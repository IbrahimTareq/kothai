// Unit tests for client/domain/importFile.ts — the shared accept/reject rules for
// a file heading to /api/import. Drag-and-drop is why this exists as its own
// pure module: the file picker is constrained by its `accept=".zip,.json"`
// attribute, but a DROPPED file has no such filter, so the same checks have to
// run in code before anything is read into memory.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  validateImportFile,
  validateImportFiles,
  IMPORT_SOURCES,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_FILES,
} from '../../client/domain/importFile.ts'

test('accepts .zip and .json regardless of case', () => {
  assert.equal(validateImportFile('saved_posts.json', 100), null)
  assert.equal(validateImportFile('instagram-export.zip', 100), null)
  assert.equal(validateImportFile('SAVED_POSTS.JSON', 100), null)
  assert.equal(validateImportFile('Export.ZIP', 100), null)
})

test('rejects any other file type by name, since a dropped file bypasses the picker filter', () => {
  for (const name of ['photo.png', 'notes.txt', 'archive.tar.gz', 'saved_posts', 'malware.json.exe']) {
    assert.ok(validateImportFile(name, 100), `${name} should be rejected`)
  }
  assert.match(validateImportFile('photo.png', 100) as string, /\.zip or \.json/)
})

test('rejects a file past the body limit before it is ever read into memory', () => {
  assert.equal(validateImportFile('big.zip', MAX_IMPORT_BYTES), null) // exactly at the cap is fine
  const err = validateImportFile('big.zip', MAX_IMPORT_BYTES + 1)
  assert.ok(err)
  assert.match(err as string, /too big/i)
})

test('reports the type problem first — a huge .png is the wrong file, not just a big one', () => {
  assert.match(validateImportFile('huge.png', MAX_IMPORT_BYTES + 1) as string, /\.zip or \.json/)
})

test('rejects an empty file rather than posting a zero-byte body', () => {
  assert.ok(validateImportFile('empty.json', 0))
})

// --- Multi-file selection ---------------------------------------------------
// An Instagram export is saved_posts.json + saved_collections.json, so picking
// or dropping both at once is the normal case, not an edge case. They ride in
// one request body, so the size limit applies to their combined size.

test('accepts the two files of an Instagram export together', () => {
  assert.equal(
    validateImportFiles([
      { name: 'saved_posts.json', size: 2_000_000 },
      { name: 'saved_collections.json', size: 40_000 },
    ]),
    null,
  )
})

test('names the offending file when only one of several is wrong', () => {
  const err = validateImportFiles([
    { name: 'saved_posts.json', size: 100 },
    { name: 'profile_photo.jpg', size: 100 },
  ])
  assert.match(err as string, /profile_photo\.jpg/)
})

test('rejects on COMBINED size — each file can fit while the request body cannot', () => {
  const half = Math.ceil(MAX_IMPORT_BYTES / 2) + 1
  assert.equal(validateImportFile('a.json', half), null, 'each file alone is under the cap')
  const err = validateImportFiles([
    { name: 'a.json', size: half },
    { name: 'b.json', size: half },
  ])
  assert.ok(err)
  assert.match(err as string, /too big/i)
})

test('rejects more files than the server will accept in one request', () => {
  const files = Array.from({ length: MAX_IMPORT_FILES + 1 }, (_, i) => ({ name: `part${i}.json`, size: 10 }))
  assert.match(validateImportFiles(files) as string, /Too many files/)
})

test('every source id has a matching accept attribute and extension rule', () => {
  for (const source of IMPORT_SOURCES) {
    assert.ok(source.id && source.label && source.accept && source.extensionsLabel, `${source.id} is fully described`)
    // The picker's `accept` and the in-code rule for dropped files must agree,
    // or a file the picker offers gets rejected the moment it is chosen.
    for (const ext of source.accept.split(',')) {
      assert.ok(source.extensions.test(`export${ext}`), `${source.id} accepts ${ext} in the picker but not in code`)
    }
  }
})

// --- Pocket, Raindrop, Omnivore, mymind -------------------------------------

const source = (id: string) => IMPORT_SOURCES.find(s => s.id === id)!

test('each newer source accepts exactly its own extensions', () => {
  const cases: Record<string, { ok: string[]; bad: string[] }> = {
    pocket: { ok: ['export.zip', 'part_000000.csv'], bad: ['a.json', 'a.md'] },
    raindrop: { ok: ['Export.CSV'], bad: ['a.zip', 'a.json'] },
    omnivore: { ok: ['export.zip', 'metadata_0.json', 'highlights/a.md'], bad: ['a.csv'] },
    mymind: { ok: ['cards.csv'], bad: ['a.zip', 'a.json'] },
  }
  for (const [id, { ok, bad }] of Object.entries(cases)) {
    for (const name of ok) assert.equal(validateImportFile(name, 100, source(id)), null, `${id} accepts ${name}`)
    for (const name of bad) assert.ok(validateImportFile(name, 100, source(id)), `${id} rejects ${name}`)
  }
})

test('an Omnivore library of 1000 files is accepted and 1001 is refused', () => {
  const files = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `metadata_${i}.json`, size: 10 }))
  assert.equal(validateImportFiles(files(1000), source('omnivore')), null)
  assert.match(validateImportFiles(files(1001), source('omnivore')) as string, /Too many files/)
})

test("an oversized file gets its own source's advice", () => {
  const big = { name: 'export.zip', size: MAX_IMPORT_BYTES + 1 }
  const omnivore = 'That ZIP is too big — unzip it and choose the metadata_*.json files (and highlights/*.md) instead.'
  assert.equal(validateImportFile(big.name, big.size, source('omnivore')), omnivore)
  assert.equal(validateImportFiles([big], source('omnivore')), omnivore)
  assert.match(validateImportFile(big.name, big.size, source('instagram')) as string, /import just saved_posts\.json/)
})
