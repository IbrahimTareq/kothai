// Precedence for the inference endpoint: environment first, credential file
// second, nothing third. Env must keep winning so that no existing install
// changes behaviour when it upgrades.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveAiConfig } from '../../server/ai/endpoint-config.ts'

test('nothing configured anywhere is the local provider', () => {
  const c = resolveAiConfig({}, null)
  assert.deepEqual([c.baseUrl, c.apiKey, c.providerId, c.provider, c.source], [null, null, null, 'local', 'none'])
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

const NONE = { baseUrl: null, apiKey: null, providerId: null }

test('a role env URL without its own key gets no key', () => {
  const c = resolveAiConfig(
    { KOTHAI_AI_BASE_URL: 'https://a', KOTHAI_AI_API_KEY: 'k1', KOTHAI_AI_EMBED_BASE_URL: 'https://e' },
    null,
  )
  assert.deepEqual(c.roles.embed, { baseUrl: 'https://e', apiKey: null, providerId: null })
  assert.deepEqual(c.roles.llm, { baseUrl: 'https://a', apiKey: 'k1', providerId: null })
})

test('a role without its own env URL falls back to the llm env pair', () => {
  const c = resolveAiConfig({ KOTHAI_AI_BASE_URL: 'https://a', KOTHAI_AI_API_KEY: 'k1' }, null)
  assert.deepEqual(c.roles.vision, { baseUrl: 'https://a', apiKey: 'k1', providerId: null })
  assert.deepEqual(c.roles.embed, c.roles.vision)
})

test('a role env URL takes its own env key', () => {
  const c = resolveAiConfig(
    { KOTHAI_AI_BASE_URL: 'https://a', KOTHAI_AI_VISION_BASE_URL: 'https://v/', KOTHAI_AI_VISION_API_KEY: 'vk' },
    null,
  )
  assert.deepEqual(c.roles.vision, { baseUrl: 'https://v', apiKey: 'vk', providerId: null })
})

test('env mode ignores the credential file entirely', () => {
  const c = resolveAiConfig(
    { KOTHAI_AI_EMBED_BASE_URL: 'https://e' },
    {
      baseUrl: 'https://f',
      apiKey: 'fk',
      roles: { vision: { baseUrl: 'https://v', apiKey: 'vk', providerId: null } },
    },
  )
  assert.equal(c.roles.llm.baseUrl, null)
  assert.equal(c.roles.vision.baseUrl, null)
  assert.equal(c.roles.vision.apiKey, null, 'no stored key may be reachable in env mode')
  assert.equal(c.roles.embed.apiKey, null)
  assert.equal(c.source, 'env')
})

test('file roles override the shared entry', () => {
  const embed = { baseUrl: 'https://e/', apiKey: 'ek', providerId: 'ollama' }
  const c = resolveAiConfig({}, { baseUrl: 'https://f', apiKey: 'fk', providerId: 'openai', roles: { embed } })
  assert.deepEqual(c.roles.embed, { baseUrl: 'https://e', apiKey: 'ek', providerId: 'ollama' })
  assert.deepEqual(c.roles.vision, { baseUrl: 'https://f', apiKey: 'fk', providerId: 'openai' })
  assert.equal(c.source, 'file')
})

test('an old single-endpoint file resolves every role to it', () => {
  const c = resolveAiConfig({}, { baseUrl: 'https://f/', apiKey: 'fk', providerId: 'openai' })
  const ep = { baseUrl: 'https://f', apiKey: 'fk', providerId: 'openai' }
  assert.deepEqual(c.roles, { llm: ep, vision: ep, embed: ep })
  assert.deepEqual([c.baseUrl, c.apiKey, c.providerId], ['https://f', 'fk', 'openai'])
})

test('a file with only a role entry leaves the other roles unconfigured', () => {
  const c = resolveAiConfig({}, { roles: { embed: { baseUrl: 'https://e', apiKey: null, providerId: null } } })
  assert.deepEqual(c.roles.llm, NONE)
  assert.equal(c.roles.embed.baseUrl, 'https://e')
  assert.equal(c.source, 'file')
})

test('model env vars land in envModels', () => {
  assert.deepEqual(resolveAiConfig({ KOTHAI_AI_EMBED_MODEL: 'nomic' }, null).envModels, { embed: 'nomic' })
  assert.deepEqual(resolveAiConfig({}, null).envModels, {})
})

test('a model env var alone does not make the source env', () => {
  assert.equal(resolveAiConfig({ KOTHAI_AI_LLM_MODEL: 'm' }, null).source, 'none')
})

// Claude serves chat and images but no embeddings. An embedding role left to
// borrow it was sent to Claude's URL: every note's re-embed failed, and so did
// every search query's. Borrowing a chat-only endpoint is no endpoint at all —
// the role is off, keyword search only — and the one place endpoints are
// derived says so, so boot, roleEnabled and the re-embed check all agree.
test('an embedding role borrowing a chat-only endpoint is unconfigured, and images still borrow it', () => {
  const c = resolveAiConfig({}, { baseUrl: 'https://api.anthropic.com/v1', apiKey: 'ak', providerId: 'claude' })
  assert.equal(c.roles.embed.baseUrl, null)
  assert.equal(c.roles.embed.apiKey, null, 'and the Claude key goes nowhere near it')
  assert.equal(c.roles.vision.baseUrl, 'https://api.anthropic.com/v1')
  assert.equal(c.source, 'file')
})

test('an embedding role with its own endpoint beside a chat-only shared one keeps it', () => {
  const embed = { baseUrl: 'https://api.openai.com/v1', apiKey: 'ok', providerId: 'openai' }
  const c = resolveAiConfig(
    {},
    { baseUrl: 'https://api.anthropic.com/v1', apiKey: 'ak', providerId: 'claude', roles: { embed } },
  )
  assert.deepEqual(c.roles.embed, embed)
})
