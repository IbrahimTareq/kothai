// Leftovers the design system already rules out, found still shipping by the
// first technical audit (2026-10-11):
//   - a 1px/4px scanline overlay on every media thumbnail, the last of the
//     terminal costume the typeface pass removed ("no scanlines / grid / glow",
//     base.css), plus an Expanded div for a scan rule that no longer existed;
//   - nine font files in the image that no stylesheet loads.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? files(join(dir, e.name), ext) : ext.test(e.name) ? [join(dir, e.name)] : [],
  )
}

const styles = files(join(ROOT, 'client', 'styles'), /\.css$/).map(f => readFileSync(f, 'utf8'))
const markup = files(join(ROOT, 'client'), /\.tsx$/).map(f => readFileSync(f, 'utf8'))

test('no stylesheet draws scanlines', () => {
  assert.equal(styles.filter(s => /repeating-linear-gradient/.test(s)).length, 0)
  assert.equal(markup.filter(s => /-scan\b|img-scan/.test(s)).length, 0)
})

test('every font file shipped is loaded by a stylesheet', () => {
  const css = styles.join('\n')
  const unused = readdirSync(join(ROOT, 'public', 'vendor', 'fonts')).filter(f => !css.includes(f))
  assert.deepEqual(unused, [])
})
