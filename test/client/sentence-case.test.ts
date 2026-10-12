// Labels are sentence case (docs/design-system.md, rule 5), and lint:tokens
// fails `text-transform:uppercase` in any sheet — but caps typed straight into
// markup never pass through a sheet. "NO SPACES YET", "NO ITEMS MATCH YET" and
// a model role's "OFF" shipped that way, the tracked-caps costume the typeface
// pass removed, back through the one door the linter does not watch. Found by
// the first design critique (2026-10-11).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'client')

// Caps that are not copy: acronyms, DOM tag names, and the word a destructive
// confirm asks you to type, which is matched literally.
const ALLOWED = new Set(['AI', 'JSON', 'INPUT', 'TEXTAREA', 'DELETE', 'GET', 'POST', 'PUT', 'PATCH', 'HEAD'])

function tsx(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? tsx(join(dir, e.name)) : e.name.endsWith('.tsx') ? [join(dir, e.name)] : [],
  )
}

test('no copy is written in capitals', () => {
  const found = tsx(CLIENT).flatMap(file =>
    [...readFileSync(file, 'utf8').matchAll(/['">]([A-Z]{2,}(?: [A-Z]{2,})*)['"<]/g)]
      .map(m => m[1])
      .filter(s => !ALLOWED.has(s))
      .map(s => `${file.slice(CLIENT.length + 1)}: ${s}`),
  )
  assert.deepEqual(found, [])
})
