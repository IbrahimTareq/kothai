// An optimistic write shows its change before the server has it. Swallow the
// failure and the screen keeps a tag, note, rename or deletion the server never
// recorded, which then reappears or vanishes on reload with nothing said —
// what the first technical audit (2026-10-11) found on every one of these.
// A read may still fail quietly; a write must roll back or say so.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'client')
const WRITES = /\b(?:API\.(?:update|retag|del|delChat)|Collections\.update)\(/g

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? sources(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
  )
}

test('no optimistic write swallows its failure', () => {
  const silent = sources(CLIENT).flatMap(file => {
    const src = readFileSync(file, 'utf8')
    return [...src.matchAll(WRITES)]
      .filter(m => {
        // The chain that hangs off this call, up to the end of its statement.
        const rest = src.slice(m.index)
        const end = rest.search(/\n\s*\n|\n {0,4}\S|\n\s*(?:const|let|if|return|\})\b/)
        return /\.catch\(\(\) => \{\}\)/.test(rest.slice(0, end < 0 ? undefined : end))
      })
      .map(m => `${file.slice(CLIENT.length + 1)}: ${m[0]}`)
  })
  assert.deepEqual(silent, [])
})
