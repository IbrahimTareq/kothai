import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkFile,
  measure,
  nextBaseline,
  HEADROOM,
  checkGovernance,
  nextGovernance,
  checkAgainstHead,
  sourceFiles,
} from '../../scripts/lint-shape.ts'

const BUDGET = { lines: 400, exports: 12 }

// Type-only exports are erased before the code runs, so they announce nothing
// at runtime. Counting them made the export total un-satisfiable for a repo
// migrating to TypeScript: 45f7fd6 tripped the ratchet by adding
// server/types.ts, a file whose entire content is two type declarations.
test('a type-only export is not counted; a runtime export is', () => {
  const typesOnly = 'export type NoteType = string\nexport interface Note {\n  id: string\n}\nexport type { Note }\n'
  assert.equal(measure(typesOnly).exports, 0)

  const runtime = 'export function f() {}\nexport const x = 1\nexport class C {}\nexport { a, b }\nexport default f\n'
  assert.equal(measure(runtime).exports, 5)
})

test('a file inside budget and absent from the baseline passes', () => {
  const r = checkFile('client/util/format.ts', { lines: 80, exports: 4 }, {}, BUDGET, HEADROOM)
  assert.equal(r, null)
})

test('a new file over budget fails', () => {
  const r = checkFile('server/new.js', { lines: 900, exports: 2 }, {}, BUDGET, HEADROOM)
  assert.ok(r, 'expected a failure message, got null')
  assert.match(r, /900 lines/)
  assert.match(r, /budget is 400/)
})

test('a baselined file at its recorded size passes', () => {
  const base = { 'server/ai/meta.ts': { lines: 816, exports: 25 } }
  const r = checkFile('server/ai/meta.ts', { lines: 816, exports: 25 }, base, BUDGET, HEADROOM)
  assert.equal(r, null)
})

test('a baselined file within headroom passes', () => {
  const base = { 'server/ai/meta.ts': { lines: 816, exports: 25 } }
  const r = checkFile('server/ai/meta.ts', { lines: 819, exports: 25 }, base, BUDGET, HEADROOM)
  assert.equal(r, null)
})

test('a baselined file beyond headroom fails, naming both numbers', () => {
  const base = { 'server/ai/meta.ts': { lines: 816, exports: 25 } }
  const r = checkFile('server/ai/meta.ts', { lines: 822, exports: 25 }, base, BUDGET, HEADROOM)
  assert.ok(r, 'expected a failure message, got null')
  assert.match(r, /822/)
  assert.match(r, /816/)
})

test('a baselined file that shrinks passes', () => {
  const base = { 'server/ai/meta.ts': { lines: 816, exports: 25 } }
  const r = checkFile('server/ai/meta.ts', { lines: 700, exports: 20 }, base, BUDGET, HEADROOM)
  assert.equal(r, null)
})

test('headroom does not apply to a file absent from the baseline', () => {
  const r = checkFile('server/new.js', { lines: 401, exports: 2 }, {}, BUDGET, HEADROOM)
  assert.ok(r, 'expected a failure message, got null')
  assert.match(r, /401 lines/)
  assert.match(r, /budget is 400/)
})

test('exports headroom is 1, not 5: one over passes, two over fails', () => {
  const base = { 'client/types.ts': { lines: 260, exports: 25 } }
  const within = checkFile('client/types.ts', { lines: 260, exports: 26 }, base, BUDGET, HEADROOM)
  assert.equal(within, null)
  const beyond = checkFile('client/types.ts', { lines: 260, exports: 27 }, base, BUDGET, HEADROOM)
  assert.ok(beyond, 'expected a failure message, got null')
  assert.match(beyond, /export/)
})

test('exports are ratcheted independently of lines, beyond headroom', () => {
  const base = { 'client/types.ts': { lines: 260, exports: 32 } }
  const r = checkFile('client/types.ts', { lines: 260, exports: 34 }, base, BUDGET, HEADROOM)
  assert.ok(r, 'expected a failure message, got null')
  assert.match(r, /export/)
})

test('--update tightens: a shrunk over-budget file records its lower number', () => {
  const baseline = { 'server/ai/meta.ts': { lines: 816, exports: 25 } }
  const measurements = { 'server/ai/meta.ts': { lines: 700, exports: 20 } }
  const next = nextBaseline(baseline, measurements, BUDGET)
  assert.deepEqual(next['server/ai/meta.ts'], { lines: 700, exports: 20 })
})

test('--update never loosens: a grown over-budget file keeps its old, smaller number', () => {
  const baseline = { 'server/ai/meta.ts': { lines: 816, exports: 25 } }
  const measurements = { 'server/ai/meta.ts': { lines: 900, exports: 25 } }
  const next = nextBaseline(baseline, measurements, BUDGET)
  assert.deepEqual(next['server/ai/meta.ts'], { lines: 816, exports: 25 })
})

test('--update adds a new over-budget file at its current values', () => {
  const next = nextBaseline({}, { 'server/new.js': { lines: 500, exports: 3 } }, BUDGET)
  assert.deepEqual(next['server/new.js'], { lines: 500, exports: 3 })
})

test('--update drops a baselined file that falls back under the flat budget', () => {
  const baseline = { 'server/ai/meta.ts': { lines: 816, exports: 25 } }
  const measurements = { 'server/ai/meta.ts': { lines: 350, exports: 5 } }
  const next = nextBaseline(baseline, measurements, BUDGET)
  assert.equal(next['server/ai/meta.ts'], undefined)
})

// The four governance ratchets: docs/development.md's Baseline section
// recorded these as prose ("should not grow past this") with nothing
// enforcing them. They now live under shape-baseline.json's `_governance`
// key and are checked exactly like a file entry.
const GOV = { claudeMdLines: 45, cleanCodeRulesLines: 41, baselineEntries: 23, exportTotal: 562 }

test('CLAUDE.md at its recorded line count passes', () => {
  const r = checkGovernance(GOV, { ...GOV, claudeMdLines: 45 }, HEADROOM)
  assert.deepEqual(r, [])
})

test('CLAUDE.md within headroom passes', () => {
  const r = checkGovernance(GOV, { ...GOV, claudeMdLines: 45 + HEADROOM.lines }, HEADROOM)
  assert.deepEqual(r, [])
})

test('CLAUDE.md beyond headroom fails, naming both numbers', () => {
  const r = checkGovernance(GOV, { ...GOV, claudeMdLines: 45 + HEADROOM.lines + 1 }, HEADROOM)
  assert.equal(r.length, 1)
  assert.match(r[0], /CLAUDE\.md/)
  assert.match(r[0], /51/)
  assert.match(r[0], /45/)
})

test('clean-code.md beyond headroom fails', () => {
  const r = checkGovernance(GOV, { ...GOV, cleanCodeRulesLines: 41 + HEADROOM.lines + 1 }, HEADROOM)
  assert.equal(r.length, 1)
  assert.match(r[0], /clean-code\.md/)
})

test('shape-baseline.json gaining a single entry fails — no headroom on the debt register', () => {
  const r = checkGovernance(GOV, { ...GOV, baselineEntries: 24 }, HEADROOM)
  assert.equal(r.length, 1)
  assert.match(r[0], /shape-baseline\.json/)
  assert.match(r[0], /24/)
  assert.match(r[0], /23/)
})

test('shape-baseline.json entry count within its recorded value passes', () => {
  const r = checkGovernance(GOV, { ...GOV, baselineEntries: 23 }, HEADROOM)
  assert.deepEqual(r, [])
})

test('total exports exceeding the recorded count fails — no headroom on the export total', () => {
  const r = checkGovernance(GOV, { ...GOV, exportTotal: 563 }, HEADROOM)
  assert.equal(r.length, 1)
  assert.match(r[0], /exports/)
  assert.match(r[0], /563/)
  assert.match(r[0], /562/)
})

test('one added runtime export trips the export ratchet; one added type does not', () => {
  const before = 'export interface Note {\n  id: string\n}\nexport const save = () => {}\n'
  const gov = { ...GOV, exportTotal: measure(before).exports }

  const addedType = `${before}export type NoteType = string\n`
  assert.deepEqual(checkGovernance(gov, { ...gov, exportTotal: measure(addedType).exports }, HEADROOM), [])

  const addedRuntime = `${before}export const remove = () => {}\n`
  const r = checkGovernance(gov, { ...gov, exportTotal: measure(addedRuntime).exports }, HEADROOM)
  assert.equal(r.length, 1)
  assert.match(r[0], /exports/)
})

test('total exports at or under the recorded count passes', () => {
  const r = checkGovernance(GOV, { ...GOV, exportTotal: 500 }, HEADROOM)
  assert.deepEqual(r, [])
})

test('all four governance metrics can fail independently in one call', () => {
  const current = {
    claudeMdLines: 45 + HEADROOM.lines + 1,
    cleanCodeRulesLines: 41 + HEADROOM.lines + 1,
    baselineEntries: 24,
    exportTotal: 563,
  }
  const r = checkGovernance(GOV, current, HEADROOM)
  assert.equal(r.length, 4)
})

test('--update tightens a governance number that improved', () => {
  const next = nextGovernance(GOV, { ...GOV, exportTotal: 550 })
  assert.equal(next.exportTotal, 550)
})

test('--update never raises a governance number, even if current reality grew', () => {
  const next = nextGovernance(GOV, { ...GOV, exportTotal: 600, claudeMdLines: 90, baselineEntries: 30 })
  assert.deepEqual(next, GOV)
})

test('--update bootstraps governance numbers when none are recorded yet', () => {
  const next = nextGovernance({}, GOV)
  assert.deepEqual(next, GOV)
})

// Finding C: the tighten-only rule above is enforced by nextGovernance/
// nextBaseline only on the --update *write* path — nothing stops a direct
// hand-edit of shape-baseline.json outside --update. checkAgainstHead closes
// that: it diffs the working file against the last commit and fails on
// anything that grew or is new, so a hand-edit cannot pass until it is
// itself committed to main (this repo's only stand-in for review).
test('checkAgainstHead passes when the working file matches HEAD', () => {
  const head = { 'server/config.ts': { lines: 104, exports: 13 } }
  const working = { 'server/config.ts': { lines: 104, exports: 13 } }
  assert.deepEqual(checkAgainstHead(working, head), [])
})

test('checkAgainstHead fails a widened file entry', () => {
  const head = { 'server/config.ts': { lines: 104, exports: 13 } }
  const working = { 'server/config.ts': { lines: 999, exports: 13 } }
  const r = checkAgainstHead(working, head)
  assert.equal(r.length, 1)
  assert.match(r[0], /server\/config\.ts/)
})

test('checkAgainstHead fails a brand-new entry not present at HEAD', () => {
  const r = checkAgainstHead({ 'server/new.js': { lines: 500, exports: 3 } }, {})
  assert.equal(r.length, 1)
  assert.match(r[0], /server\/new\.js/)
})

test('checkAgainstHead allows tightening', () => {
  const head = { 'server/config.ts': { lines: 104, exports: 13 } }
  const working = { 'server/config.ts': { lines: 90, exports: 10 } }
  assert.deepEqual(checkAgainstHead(working, head), [])
})

test('checkAgainstHead allows removing an entry entirely', () => {
  const head = { 'server/config.ts': { lines: 104, exports: 13 } }
  assert.deepEqual(checkAgainstHead({}, head), [])
})

test('checkAgainstHead fails a widened _governance field the same as a widened file entry', () => {
  const head = { _governance: { claudeMdLines: 45, cleanCodeRulesLines: 41, baselineEntries: 23, exportTotal: 562 } }
  const working = {
    _governance: { claudeMdLines: 200, cleanCodeRulesLines: 41, baselineEntries: 23, exportTotal: 562 },
  }
  const r = checkAgainstHead(working, head)
  assert.equal(r.length, 1)
  assert.match(r[0], /_governance/)
})

// A split creates new files, and --update ran before they were committed. The
// measured set came from plain `git ls-files`, so the new modules' exports
// were invisible and --update "tightened" the export total from 506 to 500
// while the real count was 511 (5d38056, 9d2f987). Untracked files count;
// ignored ones still don't.
test('sourceFiles measures new, uncommitted files but not ignored ones', () => {
  const root = mkdtempSync(join(tmpdir(), 'shape-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  git('init', '-q')
  mkdirSync(join(root, 'server'))
  writeFileSync(join(root, '.gitignore'), 'server/ignored.ts\n')
  writeFileSync(join(root, 'server', 'tracked.ts'), 'export const a = 1\n')
  git('add', '.')
  writeFileSync(join(root, 'server', 'new.ts'), 'export const b = 1\n')
  writeFileSync(join(root, 'server', 'ignored.ts'), 'export const c = 1\n')
  assert.deepEqual(sourceFiles(root).sort(), ['server/new.ts', 'server/tracked.ts'])
})
