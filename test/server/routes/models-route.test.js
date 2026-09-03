// GET /api/models/files and DELETE /api/models/files/:name — the model cache
// as a manageable thing rather than a directory that only ever grows.
//
// QVAC never prunes what it downloads, so switching a preset strands the old
// weights on disk forever and there was previously no way to reclaim that
// space short of `rm` on the server. The route's whole job is to make that
// safe: a file the current selection needs must never be deletable through it,
// and a name off the wire must never address anything outside MODELS_DIR.
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Set before config.js is imported, which freezes its resolution at import
// time — the real ./models dir holds multi-GB weights and must never be the
// thing a delete test points at.
const MODELS_DIR = mkdtempSync(path.join(os.tmpdir(), 'kothai-models-test-'))
process.env.STASH_MODELS_DIR = MODELS_DIR

const { initProvider, _reset } = await import('../../../server/ai/index.js')
const { handleModelFiles, handleDeleteModelFile } = await import('../../../server/routes/models.js')
const { _resetDb } = await import('../../../server/data/db.js')
const settings = await import('../../../server/data/settings.js')

after(() => rmSync(MODELS_DIR, { recursive: true, force: true }))

// The default selection (what settings.load() gives a fresh install) is
// Qwen3 1.7B / EmbeddingGemma Q8 / Qwen3.5-VL 2B + its F16 projector.
const ACTIVE_LLM = 'aaaaaaaaaaaaaaaa_Qwen3-1.7B-Q4_0.gguf'
const ACTIVE_PROJ = 'bbbbbbbbbbbbbbbb_mmproj-F16.gguf'
const ORPHAN = 'cccccccccccccccc_salamandrata_2b_inst_q4.gguf'

function seedCache() {
  for (const f of ['', 'sets/abc123']) mkdirSync(path.join(MODELS_DIR, f), { recursive: true })
  writeFileSync(path.join(MODELS_DIR, ACTIVE_LLM), Buffer.alloc(300))
  writeFileSync(path.join(MODELS_DIR, ACTIVE_PROJ), Buffer.alloc(200))
  writeFileSync(path.join(MODELS_DIR, ORPHAN), Buffer.alloc(100))
  writeFileSync(path.join(MODELS_DIR, 'sets/abc123/model.bin'), Buffer.alloc(50))
}

function fakeRes() {
  return {
    statusCode: 0, body: null,
    writeHead(code) { this.statusCode = code },
    end(body) { this.body = JSON.parse(body) },
  }
}

async function list() {
  const res = fakeRes()
  await handleModelFiles(res)
  return res
}

async function del(name) {
  const res = fakeRes()
  await handleDeleteModelFile(res, name)
  return res
}

beforeEach(async () => {
  rmSync(MODELS_DIR, { recursive: true, force: true })
  seedCache()
  _resetDb()
  settings._reset()
  await settings.load()
  _reset()
  await initProvider('local', {})
})

test('GET /api/models/files lists the cache with the selected models marked in use', async () => {
  const res = await list()
  assert.equal(res.statusCode, 200)
  const byName = Object.fromEntries(res.body.entries.map((e) => [e.name, e]))
  assert.equal(byName[ACTIVE_LLM].inUse, true)
  assert.equal(byName[ACTIVE_LLM].usedBy, 'llm')
  assert.equal(byName[ACTIVE_PROJ].usedBy, 'vision')
  assert.equal(byName[ORPHAN].inUse, false)
  assert.equal(byName.sets.kind, 'dir')
  assert.equal(res.body.totalBytes, 650)
  // What deleting everything deletable would actually free — the number the
  // UI can put in front of the user before they commit to anything.
  assert.equal(res.body.reclaimableBytes, 150)
})

test('DELETE /api/models/files removes an orphaned model and reports the space freed', async () => {
  const res = await del(ORPHAN)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.body, { deleted: ORPHAN, freedBytes: 100 })
  assert.equal(existsSync(path.join(MODELS_DIR, ORPHAN)), false)
})

test('DELETE /api/models/files refuses a model the current selection needs', async () => {
  const res = await del(ACTIVE_LLM)
  assert.equal(res.statusCode, 409)
  assert.equal(res.body.code, 'in_use')
  assert.match(res.body.error, /llm/)
  assert.equal(existsSync(path.join(MODELS_DIR, ACTIVE_LLM)), true)
})

test('DELETE /api/models/files refuses the vision projector, not just the vision weights', async () => {
  const res = await del(ACTIVE_PROJ)
  assert.equal(res.statusCode, 409)
  assert.equal(existsSync(path.join(MODELS_DIR, ACTIVE_PROJ)), true)
})

test('DELETE /api/models/files rejects a name that tries to escape the models dir', async () => {
  const outside = path.join(MODELS_DIR, '..', 'kothai-models-test-escape')
  writeFileSync(outside, Buffer.alloc(4))
  try {
    for (const bad of ['../kothai-models-test-escape', '..', '/etc/passwd', 'sets/abc123/model.bin']) {
      const res = await del(bad)
      assert.equal(res.statusCode, 400, `expected 400 for ${bad}`)
      assert.equal(res.body.code, 'invalid_name')
    }
    assert.equal(existsSync(outside), true)
  } finally {
    rmSync(outside, { force: true })
  }
})

test('DELETE /api/models/files reports a cache entry that is not there', async () => {
  const res = await del('deadbeefdeadbeef_NotDownloaded.gguf')
  assert.equal(res.statusCode, 404)
  assert.equal(res.body.code, 'not_found')
})

test('the model cache endpoints are not offered by a provider that downloads no weights', async () => {
  _reset()
  await initProvider('remote', {})
  assert.equal((await list()).statusCode, 404)
  const res = await del(ORPHAN)
  assert.equal(res.statusCode, 404)
  assert.equal(res.body.code, 'no_local_models')
  // A remote deployment's DELETE must be inert, not merely refused politely.
  assert.equal(existsSync(path.join(MODELS_DIR, ORPHAN)), true)
})

// ---- routing -------------------------------------------------------------
// Driven through the real router because the delete path's parameter is a
// filename taken out of the URL: percent-encoding is decoded there, so this is
// where a `..%2F` escape attempt would be handed to the handler.
const { createServer } = await import('../../../server/router.js')
const server = createServer()
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`
after(() => server.close())

test('the routes are reachable over HTTP', async () => {
  const res = await fetch(`${BASE}/api/models/files`)
  const body = await res.json()
  assert.equal(res.status, 200)
  assert.equal(body.entries.some((e) => e.name === ORPHAN), true)

  const del = await fetch(`${BASE}/api/models/files/${ORPHAN}`, { method: 'DELETE' })
  assert.equal(del.status, 200)
  assert.equal((await del.json()).freedBytes, 100)
  assert.equal(existsSync(path.join(MODELS_DIR, ORPHAN)), false)
})

test('a percent-encoded traversal in the URL is rejected, not decoded into a path', async () => {
  const outside = path.join(MODELS_DIR, '..', 'kothai-models-test-url-escape')
  writeFileSync(outside, Buffer.alloc(4))
  try {
    const res = await fetch(`${BASE}/api/models/files/..%2Fkothai-models-test-url-escape`, { method: 'DELETE' })
    assert.equal(res.status, 400)
    assert.equal((await res.json()).code, 'invalid_name')
    assert.equal(existsSync(outside), true)
  } finally {
    rmSync(outside, { force: true })
  }
})
