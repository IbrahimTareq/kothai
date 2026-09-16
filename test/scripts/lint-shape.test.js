import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkFile } from '../../scripts/lint-shape.mjs'

const BUDGET = { lines: 400, exports: 12 }

test('a file inside budget and absent from the baseline passes', () => {
  const r = checkFile('client/util/format.ts', { lines: 80, exports: 4 }, {}, BUDGET)
  assert.equal(r, null)
})

test('a new file over budget fails', () => {
  const r = checkFile('server/new.js', { lines: 900, exports: 2 }, {}, BUDGET)
  assert.match(r, /900 lines/)
  assert.match(r, /budget is 400/)
})

test('a baselined file at its recorded size passes', () => {
  const base = { 'server/ai/meta.js': { lines: 816, exports: 25 } }
  const r = checkFile('server/ai/meta.js', { lines: 816, exports: 25 }, base, BUDGET)
  assert.equal(r, null)
})

test('a baselined file that grows fails', () => {
  const base = { 'server/ai/meta.js': { lines: 816, exports: 25 } }
  const r = checkFile('server/ai/meta.js', { lines: 817, exports: 25 }, base, BUDGET)
  assert.match(r, /817/)
  assert.match(r, /816/)
})

test('a baselined file that shrinks passes', () => {
  const base = { 'server/ai/meta.js': { lines: 816, exports: 25 } }
  const r = checkFile('server/ai/meta.js', { lines: 700, exports: 20 }, base, BUDGET)
  assert.equal(r, null)
})

test('exports are ratcheted independently of lines', () => {
  const base = { 'client/types.ts': { lines: 260, exports: 32 } }
  const r = checkFile('client/types.ts', { lines: 260, exports: 33 }, base, BUDGET)
  assert.match(r, /export/)
})
