// The favicon was a 1.2 MB SVG wrapped round a base64 PNG, loaded on every
// cold start; the two empty-state pictures were 2 MB and 0.5 MB SVGs of the
// same kind, drawn at 60 and 80px (technical audit, 2026-10-11). An image the
// app shows from public/ is a few kilobytes at the size it is drawn.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const LIMIT = 50 * 1024

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? sources(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
  )
}

test('every image the app draws from public/ is small', () => {
  const markup = [join(ROOT, 'index.html'), ...sources(join(ROOT, 'client'))]
    .map(f => readFileSync(f, 'utf8'))
    .join('\n')
  const images = new Set([...markup.matchAll(/["'(]\/([\w-]+\.(?:svg|png|jpe?g|webp|gif|ico))["')]/g)].map(m => m[1]))
  assert.ok(images.size > 0)
  const heavy = [...images]
    .map(name => [name, statSync(join(ROOT, 'public', name)).size] as const)
    .filter(([, size]) => size > LIMIT)
    .map(([name, size]) => `${name}: ${Math.round(size / 1024)} KB`)
  assert.deepEqual(heavy, [])
})
