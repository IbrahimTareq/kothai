#!/usr/bin/env node
/* lint-shape — a ratchet on file size and export count.
 *
 * Bloat is the one failure mode tests never catch: an over-wide module passes
 * every assertion while becoming steadily harder to hold in your head. Flat
 * budgets alone were not usable here — 16 files already exceed them, and an
 * allowlist that long reads as permission rather than debt.
 *
 * So: a file absent from the baseline must fit the budget. A file present in
 * it may never exceed its recorded numbers, and shrinking re-baselines. The
 * baseline can only move one direction.
 *
 * Run: npm run lint:shape   (also runs as part of `npm test`)
 * Re-baseline after a real reduction: npm run lint:shape -- --update
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE = join(ROOT, 'scripts', 'shape-baseline.json')
const BUDGET = { lines: 400, exports: 12 }

// Counts export STATEMENTS, not exported bindings: `export { a, b }` is one.
// Deliberate — the metric is "how many things does this module announce", and
// a barrel re-exporting in one line is not the shape problem being guarded.
export const measure = src => ({
  lines: src.split('\n').length,
  exports: (src.match(/^export /gm) || []).length,
})

export function checkFile(path, got, baseline, budget) {
  const base = baseline[path]
  if (!base) {
    if (got.lines > budget.lines) return `${path}: ${got.lines} lines, budget is ${budget.lines}`
    if (got.exports > budget.exports) return `${path}: ${got.exports} exports, budget is ${budget.exports}`
    return null
  }
  if (got.lines > base.lines) return `${path}: grew to ${got.lines} lines, baseline is ${base.lines}`
  if (got.exports > base.exports) return `${path}: grew to ${got.exports} exports, baseline is ${base.exports}`
  return null
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

  const failures = []
  const next = {}
  const loosened = []

  for (const path of sourceFiles()) {
    const got = measure(readFileSync(join(ROOT, path), 'utf8'))
    const fail = checkFile(path, got, baseline, BUDGET)
    if (fail) failures.push(fail)

    const overBudget = got.lines > BUDGET.lines || got.exports > BUDGET.exports
    if (overBudget) next[path] = got
    const base = baseline[path]
    if (base && !overBudget) loosened.push(path)
    if (base && overBudget && (got.lines < base.lines || got.exports < base.exports)) loosened.push(path)
  }

  if (update) {
    writeFileSync(BASELINE, `${JSON.stringify(next, null, 2)}\n`)
    console.log(`shape baseline written: ${Object.keys(next).length} files over budget`)
    return
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
if (process.argv[1] && process.argv[1].endsWith('lint-shape.mjs')) main()
