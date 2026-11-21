// An install that ran only on-device (QVAC) models, upgrading to a build where
// that provider is gone. Its library holds QVAC vectors (embed_provider
// 'local'), first run is long finished, and no endpoint is stored. It must
// boot, keep every note, search by keyword, never put those vectors next to
// an endpoint's, say what happened, and rebuild them once an embedding model
// is connected.
//
// Driven through the real router, store and settings against a temp data
// directory, with a fake OpenAI-compatible endpoint that records every call:
// "no /embeddings call" is only worth asserting against something that would
// have received one.
import { test, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listenOnLoopback, record } from '../helpers/http.ts'

const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'kothai-upgrade-test-'))
// Set before anything imports config.ts, which freezes both at import time.
// No AI variable may leak in from the shell: this install has no endpoint.
for (const k of Object.keys(process.env)) if (k.startsWith('KOTHAI_')) delete process.env[k]
process.env.KOTHAI_DATA_DIR = DATA_DIR

const calls: string[] = []
const fake = createHttpServer((req, res) => {
  let raw = ''
  req.on('data', c => (raw += c))
  req.on('end', () => {
    calls.push(req.url || '')
    const input = req.url === '/embeddings' ? JSON.parse(raw).input : null
    // An input the endpoint refuses, as some do one that is too long.
    const refused = String(input).includes('Refused')
    res.writeHead(refused ? 400 : 200, { 'content-type': 'application/json' })
    if (refused) return res.end(JSON.stringify({ error: 'input rejected' }))
    if (req.url === '/embeddings') {
      const n = Array.isArray(input) ? input.length : 1
      return res.end(JSON.stringify({ data: Array.from({ length: n }, () => ({ embedding: [0.9, 0.8, 0.7] })) }))
    }
    if (req.url === '/chat/completions') {
      return res.end(JSON.stringify({ choices: [{ message: { content: 'You saved a pasta recipe [1].' } }] }))
    }
    res.end(JSON.stringify({ data: [{ id: 'chat-m' }, { id: 'embed-m' }] }))
  })
})
const FAKE = `http://127.0.0.1:${await listenOnLoopback(fake)}`

const store = await import('../../server/data/notes.ts')
const settings = await import('../../server/data/settings.ts')
const ai = await import('../../server/ai/index.ts')
const enrich = await import('../../server/ai/enrich.ts')
const reembed = await import('../../server/ai/reembed.ts')
const { createServer } = await import('../../server/router.ts')

// The seed: three notes carrying on-device vectors, and a settings row as an
// on-device install left it.
const QVAC = [0.1, 0.2, 0.3]
await store.load()
await settings.load()
for (const title of ['Brown butter pasta', 'Sourdough starter', 'Bike repair']) {
  const n = await store.addNote({ type: 'link', title, content: `${title} notes` })
  await store.updateNote(n.id, { embedding: QVAC })
}
await settings.save({ configured: true, embedProvider: 'local' })

const server = createServer()
const BASE = `http://127.0.0.1:${await listenOnLoopback(server)}`
after(() => {
  server.close()
  fake.close()
  rmSync(DATA_DIR, { recursive: true, force: true })
})

const status = async (base = BASE) => record(record(await (await fetch(`${base}/api/status`)).json()).ai)
const post = (p: string, body: unknown) =>
  fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

// A real boot of server/index.ts on the seed, in its own process: the boot
// sweeps (recipe and provider re-embed checks, tag registry, backfill) are
// what an upgrade meets first, and none of them may throw on this library.
test('the server boots on the library and serves every note, AI off and saying why', async () => {
  const probe = createHttpServer()
  const port = await listenOnLoopback(probe)
  await new Promise(r => probe.close(r))
  const child = spawn(process.execPath, ['server/index.ts'], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', c => (out += c))
  child.stderr.on('data', c => (out += c))
  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no boot within 15s:\n${out}`)), 15_000)
      child.stdout.on('data', () => {
        if (!out.includes('running at')) return
        clearTimeout(t)
        resolve()
      })
      child.on('exit', code => {
        clearTimeout(t)
        reject(new Error(`exited ${code}:\n${out}`))
      })
    })
    const booted = `http://127.0.0.1:${port}`
    assert.deepEqual(await status(booted), { upgradeNeeded: true, keywordOnly: true })
    const notes = record(await (await fetch(`${booted}/api/notes`)).json()).notes
    assert.ok(Array.isArray(notes))
    assert.equal(notes.length, 3)
  } finally {
    child.kill()
  }
})

test('with no endpoint, status asks for one and says search is keyword-only', async () => {
  await ai.initProvider(settings.getRemote())
  assert.deepEqual(await status(), { upgradeNeeded: true, keywordOnly: true })
})

test('with only a language model connected, Ask answers from keywords and sends no vectors anywhere', async () => {
  const saved = await post('/api/settings/endpoint', { endpoint: { baseUrl: FAKE }, models: { llm: 'chat-m' } })
  assert.equal(saved.status, 200)
  assert.deepEqual(await status(), { upgradeNeeded: false, keywordOnly: true })

  calls.length = 0
  const r = await post('/api/ask', { question: 'brown butter pasta' })
  assert.equal(r.status, 200)
  const sources = record(await r.json()).sources
  assert.ok(Array.isArray(sources))
  assert.equal(record(sources[0]).title, 'Brown butter pasta')
  assert.ok(calls.includes('/chat/completions'))
  assert.ok(!calls.includes('/embeddings'), 'the embed role is off, so the QVAC vectors must not be queried against')
  assert.equal(settings.getEmbedProvider(), 'local', 'nothing has been rebuilt yet')
})

test('naming an embedding model rebuilds every vector, and only then marks the library remote', async () => {
  calls.length = 0
  const saved = await post('/api/settings', { remote: { embed: 'embed-m' } })
  assert.equal(saved.status, 200)
  await enrich.queueJob(() => {}) // the re-embed runs on the job queue

  assert.ok(calls.filter(c => c === '/embeddings').length >= 3)
  const raw = await import('../../server/data/db.ts').then(m => m.getDb())
  const rows = raw.prepare('SELECT embedding FROM notes').all()
  assert.equal(rows.length, 3)
  for (const row of rows) {
    assert.ok(row.embedding instanceof Uint8Array)
    const v = Array.from(store.decodeEmbedding(row.embedding) ?? [])
    assert.deepEqual(
      v.map(x => Math.round(x * 10) / 10),
      [0.9, 0.8, 0.7],
      'every on-device vector is overwritten',
    )
  }
  assert.equal(settings.getEmbedProvider(), 'remote')
  assert.deepEqual(await status(), { upgradeNeeded: false, keywordOnly: false })
})

// One import, one content type: refused notes come in runs. Five in a row
// opened the embed breaker, the sweep stopped at the same note on every boot,
// and the library never finished moving off its on-device vectors.
test('a run of refused notes between good ones does not stop the sweep', async () => {
  for (let i = 0; i < 7; i++) {
    const n = await store.addNote({ type: 'link', title: `Refused ${i}`, content: 'x' })
    await store.updateNote(n.id, { embedding: QVAC })
  }
  // Newest first, so this one is embedded before the run and the model is
  // known to work by the time the refusals start.
  await store.addNote({ type: 'link', title: 'Fresh good note', content: 'y' })
  await settings.save({ embedProvider: 'local' })
  const quiet = mock.method(console, 'error', () => {})

  await reembed.reembedAll('test')
  quiet.mock.restore()
  assert.equal(store.count(), 11)
  const raw = await import('../../server/data/db.ts').then(m => m.getDb())
  for (const row of raw.prepare('SELECT data, embedding FROM notes').all()) {
    const refused = String(row.data).includes('Refused')
    assert.equal(
      row.embedding === null,
      refused,
      refused ? 'refused notes lose their on-device vector' : 'the rest are embedded',
    )
  }
  assert.equal(settings.getEmbedProvider(), 'remote')
})
