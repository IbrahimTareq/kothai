// Telegram capture enriches a saved link straight away, and enrichment asks
// roleEnabled, which throws until initProvider has run (server/ai/index.ts).
// Capture started a few lines before the provider, so an update in the first
// poll after boot could reach it first.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const boot = readFileSync(new URL('../../server/index.ts', import.meta.url), 'utf8')

test('Telegram capture starts only after the provider is up', () => {
  const provider = boot.indexOf('await ai.initProvider(')
  const telegram = boot.indexOf('telegram.startTelegramCapture()')
  assert.ok(provider > 0 && telegram > 0)
  assert.ok(provider < telegram, 'capture must not start before initProvider')
})
