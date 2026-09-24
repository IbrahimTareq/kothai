// The design system's checks read stylesheets and markup, so none of them can
// see composition: spacing, overlap, how one primitive sits beside another.
// docs/design-system.md has said so since it was written. The /ui playground
// (client/views/Playground.tsx, dev only) is where that is looked at — every
// primitive in client/ui/ in each of its states, in either theme. It is only
// worth anything if it is complete, so a primitive it does not render fails
// here instead of drifting out of sight.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'client')
const UI = join(CLIENT, 'ui')

const exported = readdirSync(UI)
  .filter(f => f.endsWith('.tsx'))
  .flatMap(f => [...readFileSync(join(UI, f), 'utf8').matchAll(/^export function ([A-Z]\w*)/gm)].map(m => m[1]))

test('client/ui exports primitives to render', () => {
  assert.ok(exported.length > 0)
})

test('the playground renders every primitive in client/ui', () => {
  const playground = readFileSync(join(CLIENT, 'views', 'Playground.tsx'), 'utf8')
  const missing = exported.filter(name => !new RegExp(`<${name}[\\s>/]`).test(playground))
  assert.deepEqual(missing, [], `add these to client/views/Playground.tsx: ${missing.join(', ')}`)
})
