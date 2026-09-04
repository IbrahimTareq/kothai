// client/domain/modelFiles.ts — turning /api/models/files into something a
// person can act on.
//
// The cache is named for the SDK's benefit, not the user's: entries arrive as
// `6dea07e2f9342ff3_Qwen3-4B-Q4_K_M.gguf`, which is unreadable in a row list
// and — worse — makes two quantisations of the same model look identical until
// you read past the hash. The sizes matter as much: this row exists to answer
// "what is eating my disk", and a 277 MB file rendered as "0.3 GB" answers it
// badly.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileLabel, fmtSize, storageSummary } from '../../client/domain/modelFiles.ts'
import type { ModelFile } from '../../client/types.ts'

const entry = (over: Partial<ModelFile>): ModelFile =>
  ({ name: 'x.gguf', kind: 'file', sizeBytes: 0, inUse: false, usedBy: null, ...over })

test('fileLabel drops the SDK cache hash and the extension', () => {
  assert.equal(fileLabel(entry({ name: '6dea07e2f9342ff3_Qwen3-4B-Q4_K_M.gguf' })), 'Qwen3-4B-Q4_K_M')
  assert.equal(fileLabel(entry({ name: '4e9b5f5733256805_mmproj-F16.gguf' })), 'mmproj-F16')
})

test('fileLabel leaves a name that carries no hash prefix alone', () => {
  // Not every cache entry is hash-prefixed, and a 16-char run inside a real
  // model name must not be mistaken for one.
  assert.equal(fileLabel(entry({ name: 'Qwen3-4B-Q4_K_M.gguf' })), 'Qwen3-4B-Q4_K_M')
})

test('fileLabel names a companion-set directory as what it holds, not as a path', () => {
  assert.equal(fileLabel(entry({ name: 'sets', kind: 'dir' })), 'sets — companion files')
})

test('fmtSize keeps sub-gigabyte files readable instead of rounding them to nothing', () => {
  assert.equal(fmtSize(277852192), '278 MB')
  assert.equal(fmtSize(2497280256), '2.5 GB')
  assert.equal(fmtSize(0), '0 MB')
})

test('storageSummary leads with what is on disk and what can be freed', () => {
  assert.equal(
    storageSummary({ totalBytes: 6590000000, reclaimableBytes: 1820000000 }),
    '6.6 GB downloaded · 1.8 GB can be freed',
  )
})

test('storageSummary says so plainly when every file is in use', () => {
  assert.equal(
    storageSummary({ totalBytes: 4400000000, reclaimableBytes: 0 }),
    '4.4 GB downloaded · nothing to free — every file is in use',
  )
})
