// The async clipboard is undefined on a plain-http origin, which is how most
// self-hosted installs are reached over the LAN. util/clipboard.ts falls back
// to the selection copy for that; "Copy link" in the item view called
// navigator.clipboard itself and did nothing there, silently. Found by the
// first technical audit (2026-10-11).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'client')

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? sources(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
  )
}

test('only util/clipboard.ts touches navigator.clipboard', () => {
  const direct = sources(CLIENT)
    .filter(f => !f.endsWith(join('util', 'clipboard.ts')))
    .filter(f => /navigator\.clipboard/.test(readFileSync(f, 'utf8')))
    .map(f => f.slice(CLIENT.length + 1))
  assert.deepEqual(direct, [])
})
