// What Settings and first run say about where each role runs. Source checks,
// like the rest of test/client: the views have no render harness.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = (path: string) => readFileSync(new URL(`../../client/${path}`, import.meta.url), 'utf8')

// Claude for chat with embeddings on their own endpoint: the menu offered
// "Use api.anthropic.com for embeddings", which turned embeddings off.
test('the per-role menu never offers a chat-only shared endpoint for embeddings', () => {
  const panel = src('components/settings/ConnectionPanel.tsx')
  assert.match(panel, /servesEmbeddings === false/)
  assert.match(panel, /if \(role === 'embed' && chatOnly\) return \[change\]/)
})

// "Every role runs on api.anthropic.com" after Claude plus a second provider
// for embeddings, or with none.
test('first run names every host a role runs on, and says when search is keyword-only', () => {
  const onboarding = src('views/Onboarding.tsx')
  assert.doesNotMatch(onboarding, /Every role runs on \{cfg\?\.endpoint\.host/)
  assert.match(onboarding, /ROLES\.map\(r => cfg\?\.endpoints\[r\]\.host\)/)
  assert.match(onboarding, /keyword-only/)
})

// With KOTHAI_AI_*_BASE_URL set, every endpoint route answers 409 env_managed:
// Change, Per role and Disconnect could only fail, under copy saying the key
// was stored on this machine.
test('the Connection panel is read-only when env vars set the endpoint, and says which one to set', () => {
  const panel = src('components/settings/ConnectionPanel.tsx')
  assert.match(panel, /const env = cfg\.source === 'env'/)
  assert.match(panel, /\{!env && !target && !leaving && \(/, 'no actions in env mode')
  assert.match(
    panel,
    /location\.hash === '#connect' && cfg\.source !== 'env'/,
    'nor the banner link opening the picker',
  )
  assert.match(panel, /Set by KOTHAI_AI_\* environment variables\./)
  assert.match(panel, /To use a separate embeddings endpoint, set KOTHAI_AI_EMBED_BASE_URL\./)
})

test('Settings does not say an env endpoint was set during setup', () => {
  const view = src('views/Settings.tsx')
  assert.doesNotMatch(view, /set during setup/)
  assert.match(view, /cfg\.source === 'env'/)
})

// The model column showed the stored name while KOTHAI_AI_<ROLE>_MODEL won.
test('Settings shows the model env pins, not the stored one it overrides', () => {
  assert.match(src('views/Settings.tsx'), /\{cfg\.envModels\[role\] \|\| cfg\.remote\[role\] \|\| '—'\}/)
})

// The wizard's endpoint write is refused in env mode, so it is not offered.
test('first run skips the connect wizard when env vars manage the endpoint', () => {
  assert.match(src('views/Onboarding.tsx'), /needsWizard = Boolean\(cfg\) && cfg!\.source !== 'env'/)
})
