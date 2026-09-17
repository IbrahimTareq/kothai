// Precedence for the inference endpoint: environment first, credential file
// second, nothing third. Env must keep winning so that no existing install
// changes behaviour when it upgrades.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveAiConfig } from '../../server/config.ts'

test('nothing configured anywhere is the local provider', () => {
  assert.deepEqual(resolveAiConfig({}, null), { baseUrl: null, apiKey: null, providerId: null, provider: 'local' })
})

test('env alone works exactly as it did before the credential file existed', () => {
  const c = resolveAiConfig({ KOTHAI_AI_BASE_URL: 'https://ollama.com/v1/', KOTHAI_AI_API_KEY: 'k' }, null)
  assert.equal(c.baseUrl, 'https://ollama.com/v1')
  assert.equal(c.apiKey, 'k')
  assert.equal(c.provider, 'remote')
})

test('the credential file supplies the endpoint when env does not', () => {
  const c = resolveAiConfig({}, { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-1' })
  assert.equal(c.baseUrl, 'https://api.openai.com/v1')
  assert.equal(c.apiKey, 'sk-1')
  assert.equal(c.provider, 'remote')
})

test('env wins over the file as a PAIR — a file key never attaches to an env URL', () => {
  const c = resolveAiConfig(
    { KOTHAI_AI_BASE_URL: 'https://env.example/v1' },
    { baseUrl: 'https://file.example/v1', apiKey: 'file-key' },
  )
  assert.equal(c.baseUrl, 'https://env.example/v1')
  assert.equal(c.apiKey, null, 'a key from the file must not be sent to an endpoint from env')
})

test('the lite image default — provider=remote with no URL yet — still resolves remote', () => {
  const c = resolveAiConfig({ KOTHAI_AI_PROVIDER: 'remote' }, null)
  assert.equal(c.provider, 'remote')
  assert.equal(c.baseUrl, null)
})

test('a stored endpoint implies remote without KOTHAI_AI_PROVIDER being set', () => {
  assert.equal(resolveAiConfig({}, { baseUrl: 'https://api.openai.com/v1' }).provider, 'remote')
})

test('an unknown provider value degrades to local rather than throwing', () => {
  assert.equal(resolveAiConfig({ KOTHAI_AI_PROVIDER: 'nonsense' }, null).provider, 'local')
})

test('a trailing slash is stripped whichever source the URL came from', () => {
  assert.equal(resolveAiConfig({}, { baseUrl: 'https://x.example/v1///' }).baseUrl, 'https://x.example/v1')
})
