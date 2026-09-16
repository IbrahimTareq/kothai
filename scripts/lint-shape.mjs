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
 * hand-edit to shape-baseline.json, which shows up in a diff and can be
 * argued with.
 *
 * Headroom is a few lines/exports of slack on top of a baselined file's
 * recorded number, not a ceiling the baseline is allowed to grow into — it
 * exists only so a file already over budget can still take the explanatory
 * comment this repo's own rules require without instantly failing on it.
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
const BUDGET = { lines: 400, exports: 12 }
// Slack for baselined files only — see header. Not applied to files absent
// from the baseline; those must fit BUDGET exactly.
export const HEADROOM = { lines: 5, exports: 1 }

// Counts export STATEMENTS, not exported bindings: `export { a, b }` is one.
// Deliberate — the metric is "how many things does this module announce", and
// a barrel re-exporting in one line is not the shape problem being guarded.
export const measure = src => ({
  lines: src.split('\n').length,
  exports: (src.match(/^export /gm) || []).length,
})

export function checkFile(path, got, baseline, budget, headroom) {
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
export function nextBaseline(baseline, measurements, budget) {
  const next = {}
  for (const [path, got] of Object.entries(measurements)) {
    const overBudget = got.lines > budget.lines || got.exports > budget.exports
    if (!overBudget) continue
    const base = baseline[path]
    next[path] = base ? { lines: Math.min(base.lines, got.lines), exports: Math.min(base.exports, got.exports) } : got
  }
  return next
}

const sourceFiles = () =>
  execFileSync('git', ['ls-files', 'client', 'server'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(f => /\.(js|ts|tsx)$/.test(f))

function main() {
  const update = process.argv.includes('--update')
  let baseline = {}
  try {
    baseline = JSON.parse(readFileSync(BASELINE, 'utf8'))
  } catch {
    // First run writes the baseline rather than failing 16 times.
    if (!update) console.error('no baseline found — run with --update to create it')
  }

  const measurements = {}
  for (const path of sourceFiles()) measurements[path] = measure(readFileSync(join(ROOT, path), 'utf8'))

  if (update) {
    const next = nextBaseline(baseline, measurements, BUDGET)
    writeFileSync(BASELINE, `${JSON.stringify(next, null, 2)}\n`)
    console.log(`shape baseline written: ${Object.keys(next).length} files over budget`)
    return
  }

  const failures = []
  const loosened = []

  for (const [path, got] of Object.entries(measurements)) {
    const fail = checkFile(path, got, baseline, BUDGET, HEADROOM)
    if (fail) failures.push(fail)

    const overBudget = got.lines > BUDGET.lines || got.exports > BUDGET.exports
    const base = baseline[path]
    if (base && !overBudget) loosened.push(path)
    if (base && overBudget && (got.lines < base.lines || got.exports < base.exports)) loosened.push(path)
  }

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

  console.log(`shape ok — ${Object.keys(baseline).length} files carrying budget debt`)
}

// Only run the CLI when invoked directly, so the test can import checkFile.
if (process.argv[1]?.endsWith('lint-shape.mjs')) main()
