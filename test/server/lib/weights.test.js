// server/lib/weights.js — the model cache on disk, as files rather than as
// presets. QVAC downloads weights into MODELS_DIR and never prunes them, so a
// long-lived install accumulates every model it has ever been pointed at:
// changing the LLM preset once leaves the old multi-GB file behind forever.
//
// The scan has to be conservative about what it calls reclaimable. Weights are
// re-downloadable, but a wrong "not in use" on a 2.5 GB file costs the user
// that download, so the in-use test matches on the registry BASENAME rather
// than the SDK's hashed cache filename: the hash prefix is an internal detail
// of @qvac/sdk that can change under us, the basename cannot. Matching loosely
// over-protects (two presets sharing an `mmproj-F16.gguf` name protect each
// other) and never under-protects.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { scanWeights, removeWeight, isSafeEntryName } = await import('../../../server/lib/weights.js')

// A throwaway models dir. Sizes are the file's byte length, so they're written
// as fixed-length buffers and asserted exactly.
function fixture(spec) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kothai-weights-test-'))
  for (const [rel, bytes] of Object.entries(spec)) {
    const full = path.join(dir, rel)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, Buffer.alloc(bytes))
  }
  return dir
}

test('scanWeights lists cache files with their sizes, largest first', async () => {
  const dir = fixture({ 'aaa_small.gguf': 10, 'bbb_big.gguf': 100, 'ccc_mid.gguf': 50 })
  try {
    const { entries, totalBytes } = await scanWeights(dir)
    assert.deepEqual(entries.map((e) => e.name), ['bbb_big.gguf', 'ccc_mid.gguf', 'aaa_small.gguf'])
    assert.deepEqual(entries.map((e) => e.sizeBytes), [100, 50, 10])
    assert.equal(entries.every((e) => e.kind === 'file'), true)
    assert.equal(totalBytes, 160)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scanWeights reports a companion-set directory as one entry summed recursively', async () => {
  const dir = fixture({ 'sets/abc123/model.bin': 30, 'sets/abc123/vocab.spm': 12, 'plain.gguf': 5 })
  try {
    const { entries } = await scanWeights(dir)
    const sets = entries.find((e) => e.name === 'sets')
    assert.equal(sets.kind, 'dir')
    assert.equal(sets.sizeBytes, 42)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scanWeights marks the selected models in use by registry basename, ignoring the SDK hash prefix', async () => {
  const dir = fixture({
    '6dea07e2f9342ff3_Qwen3-4B-Q4_K_M.gguf': 40,
    'c06f2a9027791346_salamandrata_2b_inst_q4.gguf': 20,
  })
  try {
    const { entries, reclaimableBytes } = await scanWeights(dir, { 'Qwen3-4B-Q4_K_M.gguf': 'llm' })
    const active = entries.find((e) => e.name.endsWith('Qwen3-4B-Q4_K_M.gguf'))
    const orphan = entries.find((e) => e.name.endsWith('salamandrata_2b_inst_q4.gguf'))
    assert.equal(active.inUse, true)
    assert.equal(active.usedBy, 'llm')
    assert.equal(orphan.inUse, false)
    assert.equal(orphan.usedBy, null)
    // Only the orphan counts toward what deleting could free.
    assert.equal(reclaimableBytes, 20)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scanWeights protects a directory that contains an in-use file', async () => {
  const dir = fixture({ 'sets/abc123/model.aren.bin': 30, 'sets/abc123/metadata.json': 2 })
  try {
    const { entries } = await scanWeights(dir, { 'model.aren.bin': 'llm' })
    const sets = entries.find((e) => e.name === 'sets')
    assert.equal(sets.inUse, true)
    assert.equal(sets.usedBy, 'llm')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scanWeights skips dotfiles so .DS_Store never shows up as a deletable model', async () => {
  const dir = fixture({ '.DS_Store': 8, 'model.gguf': 4 })
  try {
    const { entries, totalBytes } = await scanWeights(dir)
    assert.deepEqual(entries.map((e) => e.name), ['model.gguf'])
    assert.equal(totalBytes, 4)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scanWeights returns an empty listing for a models dir that does not exist yet', async () => {
  const { entries, totalBytes, reclaimableBytes } = await scanWeights(path.join(os.tmpdir(), 'kothai-weights-absent-dir'))
  assert.deepEqual(entries, [])
  assert.equal(totalBytes, 0)
  assert.equal(reclaimableBytes, 0)
})

// The entry name arrives from the URL, so this guard is what stands between a
// DELETE and any path on the machine. Nothing below is hypothetical: each of
// these joined onto MODELS_DIR resolves outside it or to something that is not
// a cache entry at all.
test('isSafeEntryName rejects anything that is not a single plain child name', () => {
  for (const bad of ['', '.', '..', '../models', 'a/b', 'a\\b', '/etc/passwd', '.hidden', 'a\0b']) {
    assert.equal(isSafeEntryName(bad), false, `expected ${JSON.stringify(bad)} to be rejected`)
  }
  for (const ok of ['6dea07e2f9342ff3_Qwen3-4B-Q4_K_M.gguf', 'sets', 'a.b-c_d']) {
    assert.equal(isSafeEntryName(ok), true, `expected ${JSON.stringify(ok)} to be accepted`)
  }
})

test('removeWeight deletes a file and reports the bytes it freed', async () => {
  const dir = fixture({ 'orphan.gguf': 64 })
  try {
    const { freedBytes } = await removeWeight(dir, 'orphan.gguf')
    assert.equal(freedBytes, 64)
    assert.equal(existsSync(path.join(dir, 'orphan.gguf')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('removeWeight deletes a companion-set directory whole', async () => {
  const dir = fixture({ 'sets/abc123/model.bin': 30, 'sets/abc123/vocab.spm': 12 })
  try {
    const { freedBytes } = await removeWeight(dir, 'sets')
    assert.equal(freedBytes, 42)
    assert.equal(existsSync(path.join(dir, 'sets')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('removeWeight refuses a traversing name and leaves the target alone', async () => {
  const dir = fixture({ 'keep.gguf': 8 })
  const outside = path.join(dir, '..', path.basename(dir) + '-sibling.gguf')
  writeFileSync(outside, Buffer.alloc(8))
  try {
    await assert.rejects(
      () => removeWeight(dir, `../${path.basename(dir)}-sibling.gguf`),
      (e) => e.code === 'invalid_name',
    )
    assert.equal(existsSync(outside), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(outside, { force: true })
  }
})

test('removeWeight reports a missing entry rather than pretending it deleted something', async () => {
  const dir = fixture({ 'keep.gguf': 8 })
  try {
    await assert.rejects(() => removeWeight(dir, 'gone.gguf'), (e) => e.code === 'not_found')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
