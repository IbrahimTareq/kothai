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
