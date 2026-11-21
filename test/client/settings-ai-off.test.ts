// With no service connected (a skipped first run, or a library upgraded from
// on-device models), Settings drew three model fields reading "Endpoint did
// not return a model list" under copy saying inference runs on an endpoint.
// The Connection panel already says what to do, so the fields wait for it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = (path: string) => readFileSync(new URL(`../../client/${path}`, import.meta.url), 'utf8')

test('Settings shows the model fields only once an endpoint is connected', () => {
  const view = src('views/Settings.tsx')
  const at = view.indexOf('label="Model cores"')
  assert.ok(at >= 0, 'Settings renders no Model cores group')
  assert.match(view.slice(at - 200, at), /cfg\.endpoint\.configured && \(\s*<SettingsGroup/)
})

test('the usage panel no longer speaks of local model calls', () => {
  assert.doesNotMatch(src('components/settings/UsageSection.tsx'), /local or through an endpoint/)
})
