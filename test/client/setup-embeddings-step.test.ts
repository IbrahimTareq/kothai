// Claude serves chat and images and no embeddings. Its tile used to be left
// out of first run for that reason — a one-click answer that does half the job
// is not one. It is offered now because connecting it asks a second question,
// a provider for search by meaning, and that answer is saved as the embedding
// role's own endpoint rather than over the shared one.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = (path: string) => readFileSync(new URL(`../../client/${path}`, import.meta.url), 'utf8')

test('a provider that serves no embeddings is followed by the embeddings step', () => {
  const wizard = src('views/SetupWizard.tsx')
  assert.match(wizard, /servesEmbeddings/)
  assert.match(wizard, /Pick a provider for search by meaning/)
  // The step offers only the tiles that can answer it...
  assert.match(wizard, /endpoints=\{endpoints\.filter\(e => e\.servesEmbeddings\)\}/)
  // ...and a way through without one.
  assert.match(wizard, /Skip: keyword search only/)
})

test('the embeddings choice is posted for the embedding role alone', () => {
  assert.match(src('views/Onboarding.tsx'), /API\.applyEndpoint\([^;]*'embed'\)/)
  const api = src('data/api.ts')
  assert.match(api, /apiPost\('\/api\/setup\/endpoint', \{ endpoint, models, role \}\)/)
})

test('Settings can point embeddings and images at an endpoint of their own', () => {
  const panel = src('components/settings/ConnectionPanel.tsx')
  assert.match(panel, /Use a different endpoint for embeddings/)
  assert.match(panel, /Use a different endpoint for images/)
  assert.match(panel, /<Menu\b/, 'from client/ui/, not a hand-built list')
  assert.match(src('data/api.ts'), /apiPost\('\/api\/settings\/endpoint', \{ endpoint, models, role \}\)/)
})

test('a model set by env is shown read-only, naming the variable', () => {
  assert.match(src('components/settings/ModelPicker.tsx'), /Set by KOTHAI_AI_\$\{role\.toUpperCase\(\)\}_MODEL/)
  assert.match(src('views/Settings.tsx'), /envSet=\{cfg\.envModels\[role\]\}/)
})
