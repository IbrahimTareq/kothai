#!/usr/bin/env node
/* lint-shape — a ratchet on file size and export count.
 *
 * Bloat is the one failure mode tests never catch: an over-wide module passes
 * every assertion while becoming steadily harder to hold in your head. Flat
 * budgets alone were not usable here — 16 files already exceed them, and an
 * allowlist that long reads as permission rather than debt.
 *
 * So: a file absent from the baseline must fit the budget. A file present in
 * it may never exceed baseline + headroom. `--update` can only tighten a
 * baselined file's recorded number down to its current, smaller measurement —
 * it can never raise one. Without that constraint, the escape from a failing
 * check was to grow a file, run `--update`, and have the baseline record the
 * larger number: the person who caused the violation could dismiss it
 * themselves, which enforces nothing. Raising a baseline now takes a
 * hand-edit to shape-baseline.json — but nothing about `--update` stops a
 * *direct* hand-edit outside it, so `checkAgainstHead` below diffs the
 * working file against the last commit and fails on anything that grew or is
 * new. There is no PR review in this repo (commit straight to main, no
 * branches), so the commit itself, permanent in `git log`, is what stands in
 * for one: the edit cannot pass `pnpm test` until it is committed.
 *
 * Headroom is a few lines/exports of slack on top of a baselined file's
 * recorded number, not a ceiling the baseline is allowed to grow into — it
 * exists only so a file already over budget can still take the explanatory
 * comment this repo's own rules require without instantly failing on it.
 *
 * The same ratchet also covers four numbers about the governance system
 * itself (docs/development.md's Baseline section) — CLAUDE.md's and
 * clean-code-rules.md's line counts, the size of this file's own debt
 * register, and the total export count across client/ + server/. They live
 * under the `_governance` key below, in this same file rather than a second
 * one, and are checked and tightened exactly like a per-file entry.
 *
 * Run: npm run lint:shape   (also runs as part of `npm test`)
 * Tighten after a real reduction: npm run lint:shape -- --update
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE = join(ROOT, 'scripts', 'shape-baseline.json')
type Shape = { lines: number; exports: number }
type Governance = {
  claudeMdLines: number
  cleanCodeRulesLines: number
  baselineEntries: number
  exportTotal: number
}
// shape-baseline.json holds per-file entries keyed by path plus the single
// `_governance` key, which is why the two are spelled as an intersection
// rather than one record: they share a namespace but not a shape.
type Baseline = Record<string, Shape> & { _governance?: Governance }
// checkAgainstHead treats every entry alike — a file's lines/exports and a
// `_governance` field are the same question ("did this number grow?") — so it
// reads the baseline as nested numbers rather than as either named shape.
type NumberBag = Record<string, Record<string, number>>

const BUDGET = { lines: 400, exports: 12 }
// Slack for baselined files only — see header. Not applied to files absent
// from the baseline; those must fit BUDGET exactly.
export const HEADROOM = { lines: 5, exports: 1 }

// Counts export STATEMENTS, not exported bindings: `export { a, b }` is one.
// Deliberate — the metric is "how many things does this module announce", and
// a barrel re-exporting in one line is not the shape problem being guarded.
//
// `export type` and `export interface` are excluded: both are erased before
// the code runs, so they announce nothing at runtime and add no API surface.
// Counting them made the total un-satisfiable for a repo migrating to
// TypeScript — server/types.ts tripped the ratchet in 45f7fd6 purely by
// naming two types.
export const measure = (src: string) => ({
  lines: src.split('\n').length,
  exports: (src.match(/^export (?!type\b|interface\b)/gm) || []).length,
})

export function checkFile(path: string, got: Shape, baseline: Record<string, Shape>, budget: Shape, headroom: Shape) {
  const base = baseline[path]
  if (!base) {
    if (got.lines > budget.lines) return `${path}: ${got.lines} lines, budget is ${budget.lines}`
    if (got.exports > budget.exports) return `${path}: ${got.exports} exports, budget is ${budget.exports}`
    return null
  }
  if (got.lines > base.lines + headroom.lines) return `${path}: grew to ${got.lines} lines, baseline is ${base.lines}`
  if (got.exports > base.exports + headroom.exports)
    return `${path}: grew to ${got.exports} exports, baseline is ${base.exports}`
  return null
}

// The --update write path: a file's recorded baseline may only tighten. A
// file already over budget keeps the lower of its old baseline and its
// current measurement, per metric; a file newly over budget is added at its
// current values; a file that falls back under the flat budget is dropped
// (the flat budget governs it from here, which is still tighter than its old,
// larger baseline entry).
export function nextBaseline(
  baseline: Record<string, Shape>,
  measurements: Record<string, Shape>,
  budget: Shape,
): Baseline {
  const next: Baseline = {}
  for (const [path, got] of Object.entries(measurements)) {
    const overBudget = got.lines > budget.lines || got.exports > budget.exports
    if (!overBudget) continue
    const base = baseline[path]
    next[path] = base ? { lines: Math.min(base.lines, got.lines), exports: Math.min(base.exports, got.exports) } : got
  }
  return next
}

// `.js` is deliberately absent: client/ and server/ are wholly TypeScript, and
// matching it would silently re-admit a .js file to the measured set — the one
// thing the CI guard in ci.yml exists to make impossible.
const sourceFiles = () =>
  execFileSync('git', ['ls-files', 'client', 'server'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(f => /\.(ts|tsx)$/.test(f))

// `_governance` is metadata about the governance system, not a file's shape —
// every place that walks the baseline as a set of files must ignore it.
const fileEntries = (baseline: Baseline) => Object.keys(baseline).filter(k => k !== '_governance')

// The four governance numbers, measured fresh: CLAUDE.md's and
// clean-code-rules.md's line counts, the debt register's own entry count,
// and the total export statements across every measured client/+server file.
function measureGovernance(measurements: Record<string, Shape>, baselineEntryCount: number): Governance {
  return {
    claudeMdLines: readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8').split('\n').length,
    cleanCodeRulesLines: readFileSync(join(ROOT, '.claude', 'clean-code-rules.md'), 'utf8').split('\n').length,
    baselineEntries: baselineEntryCount,
    exportTotal: Object.values(measurements).reduce((sum, m) => sum + m.exports, 0),
  }
}

// `gov` below is a bag of numbers rather than a `Governance`: main passes `{}`
// when shape-baseline.json carries no `_governance` key yet, and each
// comparison then reads undefined, compares false, and lets that first run
// pass instead of failing four times over numbers nobody has recorded.
//
// CLAUDE.md and clean-code-rules.md get the same line headroom a baselined
// file gets, for the same reason (room for the explanatory comment this
// change itself needs). The debt register's entry count and the export total
// get none — "should not gain entries" and "should trend down" are absolute,
// not slack-bearing, per docs/development.md's Baseline section.
export function checkGovernance(gov: Record<string, number>, current: Governance, headroom: Shape) {
  const failures = []
  if (current.claudeMdLines > gov.claudeMdLines + headroom.lines)
    failures.push(`CLAUDE.md: grew to ${current.claudeMdLines} lines, baseline is ${gov.claudeMdLines}`)
  if (current.cleanCodeRulesLines > gov.cleanCodeRulesLines + headroom.lines)
    failures.push(
      `.claude/clean-code-rules.md: grew to ${current.cleanCodeRulesLines} lines, baseline is ${gov.cleanCodeRulesLines}`,
    )
  if (current.baselineEntries > gov.baselineEntries)
    failures.push(
      `scripts/shape-baseline.json: grew to ${current.baselineEntries} entries, baseline is ${gov.baselineEntries}`,
    )
  if (current.exportTotal > gov.exportTotal)
    failures.push(`client/+server/ exports: grew to ${current.exportTotal}, baseline is ${gov.exportTotal}`)
  return failures
}

// Same tighten-only rule as nextBaseline, applied to the four governance
// numbers instead of a per-file entry. Missing/first-run values bootstrap at
// whatever is currently true rather than failing.
export function nextGovernance(gov: Partial<Governance> | undefined, current: Governance): Governance {
  const g: Partial<Governance> = gov || {}
  const min = (a: number | undefined, b: number) => Math.min(a ?? Number.POSITIVE_INFINITY, b)
  return {
    claudeMdLines: min(g.claudeMdLines, current.claudeMdLines),
    cleanCodeRulesLines: min(g.cleanCodeRulesLines, current.cleanCodeRulesLines),
    baselineEntries: min(g.baselineEntries, current.baselineEntries),
    exportTotal: min(g.exportTotal, current.exportTotal),
  }
}

// Diffs the on-disk (possibly uncommitted) baseline against the version at
// HEAD. Fails on any entry — a file's `lines`/`exports`, or a `_governance`
// field — that is new or larger than what's committed; tightening and
// removal stay allowed. This is what actually stops a hand-edit: nothing
// else in this file checks the JSON against anything but itself, so a direct
// edit of shape-baseline.json (skipping --update entirely) would otherwise
// sail through.
export function checkAgainstHead(working: NumberBag, head: NumberBag) {
  const failures = []
  for (const [key, val] of Object.entries(working)) {
    if (!val || typeof val !== 'object') continue
    const prev = head[key]
    if (!prev) {
      failures.push(`${key}: new entry, not present at the last commit`)
      continue
    }
    for (const [field, num] of Object.entries(val)) {
      if (typeof num !== 'number') continue
      if (prev[field] === undefined || num > prev[field])
        failures.push(
          `${key}.${field}: ${num} at working tree vs ${prev[field] ?? 'unset'} at HEAD — widened without a commit`,
        )
    }
  }
  return failures
}

function readHeadBaseline(): NumberBag {
  try {
    return JSON.parse(
      execFileSync('git', ['show', 'HEAD:scripts/shape-baseline.json'], { cwd: ROOT, encoding: 'utf8' }),
    )
  } catch {
    // No shape-baseline.json at HEAD yet (e.g. the very first commit that
    // introduces it) — nothing committed to diff against.
    return {}
  }
}

function main() {
  const update = process.argv.includes('--update')
  let baseline: Baseline = {}
  try {
    baseline = JSON.parse(readFileSync(BASELINE, 'utf8'))
  } catch {
    // First run writes the baseline rather than failing 16 times.
    if (!update) console.error('no baseline found — run with --update to create it')
  }

  const measurements: Record<string, Shape> = {}
  for (const path of sourceFiles()) measurements[path] = measure(readFileSync(join(ROOT, path), 'utf8'))

  if (update) {
    const next = nextBaseline(baseline, measurements, BUDGET)
    const current = measureGovernance(measurements, fileEntries(next).length)
    next._governance = nextGovernance(baseline._governance, current)
    writeFileSync(BASELINE, `${JSON.stringify(next, null, 2)}\n`)
    console.log(`shape baseline written: ${Object.keys(next).length - 1} files over budget`)
    return
  }

  const failures: string[] = []
  const loosened: string[] = []

  for (const [path, got] of Object.entries(measurements)) {
    const fail = checkFile(path, got, baseline, BUDGET, HEADROOM)
    if (fail) failures.push(fail)

    const overBudget = got.lines > BUDGET.lines || got.exports > BUDGET.exports
    const base = baseline[path]
    if (base && !overBudget) loosened.push(path)
    if (base && overBudget && (got.lines < base.lines || got.exports < base.exports)) loosened.push(path)
  }

  const current = measureGovernance(measurements, fileEntries(baseline).length)
  failures.push(...checkGovernance(baseline._governance || {}, current, HEADROOM))
  failures.push(...checkAgainstHead(baseline, readHeadBaseline()))

  if (loosened.length) {
    console.log('shape improved — re-baseline with `npm run lint:shape -- --update`:')
    for (const p of loosened) console.log(`  ${p}`)
  }

  if (failures.length) {
    console.error('\nshape budget violations:')
    for (const f of failures) console.error(`  ${f}`)
    console.error('\nSplit the module rather than raising the baseline. See /split-module.')
    process.exit(1)
  }

  console.log(`shape ok — ${fileEntries(baseline).length} files carrying budget debt`)
}

// Only run the CLI when invoked directly, so the test can import checkFile.
if (process.argv[1]?.endsWith('lint-shape.ts')) main()
