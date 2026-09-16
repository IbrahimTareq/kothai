import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkFile, nextBaseline, HEADROOM } from '../../scripts/lint-shape.mjs'

const BUDGET = { lines: 400, exports: 12 }

test('a file inside budget and absent from the baseline passes', () => {
  const r = checkFile('client/util/format.ts', { lines: 80, exports: 4 }, {}, BUDGET, HEADROOM)
  assert.equal(r, null)
})

test('a new file over budget fails', () => {
  const r = checkFile('server/new.js', { lines: 900, exports: 2 }, {}, BUDGET, HEADROOM)
  assert.match(r, /900 lines/)
  assert.match(r, /budget is 400/)
})

test('a baselined file at its recorded size passes', () => {
  const base = { 'server/ai/meta.js': { lines: 816, exports: 25 } }
  const r = checkFile('server/ai/meta.js', { lines: 816, exports: 25 }, base, BUDGET, HEADROOM)
  assert.equal(r, null)
})

test('a baselined file within headroom passes', () => {
  const base = { 'server/ai/meta.js': { lines: 816, exports: 25 } }
  const r = checkFile('server/ai/meta.js', { lines: 819, exports: 25 }, base, BUDGET, HEADROOM)
  assert.equal(r, null)
})

test('a baselined file beyond headroom fails, naming both numbers', () => {
  const base = { 'server/ai/meta.js': { lines: 816, exports: 25 } }
  const r = checkFile('server/ai/meta.js', { lines: 822, exports: 25 }, base, BUDGET, HEADROOM)
  assert.match(r, /822/)
  assert.match(r, /816/)
})

test('a baselined file that shrinks passes', () => {
  const base = { 'server/ai/meta.js': { lines: 816, exports: 25 } }
  const r = checkFile('server/ai/meta.js', { lines: 700, exports: 20 }, base, BUDGET, HEADROOM)
  assert.equal(r, null)
})

test('headroom does not apply to a file absent from the baseline', () => {
  const r = checkFile('server/new.js', { lines: 401, exports: 2 }, {}, BUDGET, HEADROOM)
  assert.match(r, /401 lines/)
  assert.match(r, /budget is 400/)
})

test('exports headroom is 1, not 5: one over passes, two over fails', () => {
  const base = { 'client/types.ts': { lines: 260, exports: 25 } }
  const within = checkFile('client/types.ts', { lines: 260, exports: 26 }, base, BUDGET, HEADROOM)
  assert.equal(within, null)
  const beyond = checkFile('client/types.ts', { lines: 260, exports: 27 }, base, BUDGET, HEADROOM)
  assert.match(beyond, /export/)
})

test('exports are ratcheted independently of lines, beyond headroom', () => {
  const base = { 'client/types.ts': { lines: 260, exports: 32 } }
  const r = checkFile('client/types.ts', { lines: 260, exports: 34 }, base, BUDGET, HEADROOM)
  assert.match(r, /export/)
})

test('--update tightens: a shrunk over-budget file records its lower number', () => {
  const baseline = { 'server/ai/meta.js': { lines: 816, exports: 25 } }
  const measurements = { 'server/ai/meta.js': { lines: 700, exports: 20 } }
  const next = nextBaseline(baseline, measurements, BUDGET)
  assert.deepEqual(next['server/ai/meta.js'], { lines: 700, exports: 20 })
})

test('--update never loosens: a grown over-budget file keeps its old, smaller number', () => {
  const baseline = { 'server/ai/meta.js': { lines: 816, exports: 25 } }
  const measurements = { 'server/ai/meta.js': { lines: 900, exports: 25 } }
  const next = nextBaseline(baseline, measurements, BUDGET)
  assert.deepEqual(next['server/ai/meta.js'], { lines: 816, exports: 25 })
})

test('--update adds a new over-budget file at its current values', () => {
  const next = nextBaseline({}, { 'server/new.js': { lines: 500, exports: 3 } }, BUDGET)
  assert.deepEqual(next['server/new.js'], { lines: 500, exports: 3 })
})

test('--update drops a baselined file that falls back under the flat budget', () => {
  const baseline = { 'server/ai/meta.js': { lines: 816, exports: 25 } }
  const measurements = { 'server/ai/meta.js': { lines: 350, exports: 5 } }
  const next = nextBaseline(baseline, measurements, BUDGET)
  assert.equal(next['server/ai/meta.js'], undefined)
})
