// The credential file has to reach config BEFORE initProvider runs, or the
// first boot after saving a key comes up with no endpoint and every role dark.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setAiCredentials, getAiConfig, resolveAiConfig } from '../../server/config.ts'
import { writeCredentials, readCredentials } from '../../server/data/credentials.ts'

beforeEach(() => setAiCredentials(null))

test('a stored credential reaches getAiConfig once loaded', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'kothai-boot-'))
  writeCredentials({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-boot' }, d)
  assert.equal(getAiConfig().provider, 'local', 'not loaded yet')
  setAiCredentials(readCredentials(d))
  const c = getAiConfig()
  assert.equal(c.provider, 'remote')
  assert.equal(c.baseUrl, 'https://api.openai.com/v1')
})

test('clearing the loaded credential returns the process to local', () => {
  setAiCredentials({ baseUrl: 'https://x.example/v1', apiKey: 'k' })
  assert.equal(getAiConfig().provider, 'remote')
  setAiCredentials(null)
  assert.equal(getAiConfig().provider, 'local')
})

test('an env endpoint still wins over a loaded credential', () => {
  const c = resolveAiConfig(
    { STASH_AI_BASE_URL: 'https://env.example/v1' },
    { baseUrl: 'https://file.example/v1', apiKey: 'file-key' },
  )
  assert.equal(c.baseUrl, 'https://env.example/v1')
})
