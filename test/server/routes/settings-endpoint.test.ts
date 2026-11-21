// Changing the endpoint AFTER first run. Until this existed, the provider and
// key were fixed at setup: a rotated API key or a switch from one service to
// another meant recreating the container, which is the exact problem the
// credential store was built to remove.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _reset, initProvider } from '../../../server/ai/index.ts'
import {
  handleSaveEndpoint,
  handleClearEndpoint,
  handleGetSettings,
  handleSetupEndpoint,
  handleSetup,
} from '../../../server/routes/settings.ts'
import { _resetDb } from '../../../server/data/db.ts'
import * as settings from '../../../server/data/settings.ts'
import * as store from '../../../server/data/notes.ts'
import * as enrich from '../../../server/ai/enrich.ts'
import { setAiCredentials, getAiConfig } from '../../../server/config.ts'
import { readCredentials, writeCredentials } from '../../../server/data/credentials.ts'
import { mockReq, mockRes, record } from '../../helpers/http.ts'
import { provider } from '../../helpers/providers.ts'

const fakeReq = (body: unknown) => mockReq({ body: JSON.stringify(body) })
const dir = () => mkdtempSync(path.join(tmpdir(), 'kothai-chg-'))

// How many notes the endpoint was asked to embed, which is how a queued
// re-embed shows itself.
const calls = { remoteEmbeds: 0 }
const fakeProvider = () =>
  provider({
    embedText: async () => {
      calls.remoteEmbeds++
      return [1]
    },
  })
const load = fakeProvider
const A = 'http://127.0.0.1:1/v1'
const B = 'http://127.0.0.1:2/v1'

beforeEach(async () => {
  calls.remoteEmbeds = 0
  _resetDb()
  settings._reset()
  await settings.load()
  _reset()
  setAiCredentials(null)
})

test('the endpoint can be changed once first run is over', async () => {
  const d = dir()
  writeCredentials({ baseUrl: A, apiKey: 'old-key' }, d)
  setAiCredentials(readCredentials(d))
  await settings.save({ configured: true })
  await initProvider({}, { load })

  const { res, sent } = mockRes()
  await handleSaveEndpoint(fakeReq({ endpoint: { providerId: 'openai', baseUrl: B, apiKey: 'new-key' } }), res, {
    dir: d,
    load,
  })
  assert.equal(sent.code, 200)
  assert.deepEqual(readCredentials(d), { baseUrl: B, apiKey: 'new-key', providerId: 'openai' })
  assert.equal(getAiConfig().roles.llm.baseUrl, B, 'and the running process follows')
})

test('rotating just the key keeps the endpoint', async () => {
  const d = dir()
  writeCredentials({ baseUrl: A, apiKey: 'old-key' }, d)
  setAiCredentials(readCredentials(d))
  await settings.save({ configured: true })
  await initProvider({}, { load })

  await handleSaveEndpoint(
    fakeReq({ endpoint: { providerId: 'openai', baseUrl: A, apiKey: 'rotated' } }),
    mockRes().res,
    { dir: d, load },
  )
  assert.deepEqual(readCredentials(d), { baseUrl: A, apiKey: 'rotated', providerId: 'openai' })
})

// There is no on-device provider to fall back on: disconnecting leaves AI off.
test('disconnecting removes the credential and leaves every role with no endpoint', async () => {
  const d = dir()
  writeCredentials({ baseUrl: A, apiKey: 'k' }, d)
  setAiCredentials(readCredentials(d))
  await settings.save({ configured: true, remote: { llm: 'gpt-4o-mini', embed: 'text-embedding-3-small' } })
  await initProvider({}, { load })

  const { res, sent } = mockRes()
  await handleClearEndpoint(fakeReq({}), res, { dir: d, load })
  assert.equal(sent.code, 200)
  assert.equal(existsSync(path.join(d, 'credentials.json')), false, 'the key is gone from disk')
  assert.equal(getAiConfig().source, 'none')
})

// The endpoint's model names are deliberately left alone on disconnect: they
// cost nothing while unused, and keeping them means reconnecting the same
// provider does not mean typing them again.
test('disconnecting keeps the endpoint model names for next time', async () => {
  const d = dir()
  writeCredentials({ baseUrl: A, apiKey: 'k' }, d)
  setAiCredentials(readCredentials(d))
  await settings.save({ configured: true, remote: { llm: 'gpt-4o-mini' } })
  await initProvider({}, { load })
  await handleClearEndpoint(fakeReq({}), mockRes().res, { dir: d, load })
  assert.equal(settings.getRemote().llm, 'gpt-4o-mini')
})

test('a malformed endpoint is refused and the working one survives', async () => {
  const d = dir()
  writeCredentials({ baseUrl: A, apiKey: 'good' }, d)
  setAiCredentials(readCredentials(d))
  await settings.save({ configured: true })
  await initProvider({}, { load })

  const { res, sent } = mockRes()
  await handleSaveEndpoint(fakeReq({ endpoint: { providerId: null, baseUrl: 'not a url' } }), res, { dir: d, load })
  assert.equal(sent.code, 400)
  assert.deepEqual(readCredentials(d), { baseUrl: A, apiKey: 'good', providerId: null }, 'the old one is untouched')
})

// The wizard's Continue used to send a blank key for OpenAI, and first run
// moved on to naming models for an endpoint that could answer none of them.
test('a provider that needs a key is refused without one, and the working one survives', async () => {
  const d = dir()
  writeCredentials({ baseUrl: A, apiKey: 'good' }, d)
  setAiCredentials(readCredentials(d))
  await settings.save({ configured: true })
  await initProvider({}, { load })

  const { res, sent } = mockRes()
  await handleSaveEndpoint(fakeReq({ endpoint: { providerId: 'openai', baseUrl: A, apiKey: ' ' } }), res, {
    dir: d,
    load,
  })
  assert.equal(sent.code, 400)
  assert.deepEqual(readCredentials(d), { baseUrl: A, apiKey: 'good', providerId: null })
})

// ---- an endpoint per role --------------------------------------------------
// Claude serves chat and images but no embeddings, so connecting it means a
// second endpoint for the embedding role alone. That override has to be
// written and removed without touching the shared entry it sits beside.
const connected = async (d: string) => {
  writeCredentials({ baseUrl: A, apiKey: 'shared-key', providerId: 'claude' }, d)
  setAiCredentials(readCredentials(d))
  await settings.save({ configured: true, remote: { llm: 'claude-haiku-5-5', embed: 'text-embedding-3-small' } })
  await initProvider({}, { load })
}

test('an endpoint saved for one role is written beside the shared one, not over it', async () => {
  const d = dir()
  await connected(d)
  const { res, sent } = mockRes()
  await handleSaveEndpoint(
    fakeReq({
      endpoint: { providerId: 'openai', baseUrl: B, apiKey: 'embed-key' },
      models: { embed: 'text-embedding-3-small' },
      role: 'embed',
    }),
    res,
    { dir: d, load },
  )
  assert.equal(sent.code, 200)
  const creds = readCredentials(d)
  assert.equal(creds?.roles?.embed?.baseUrl, B)
  assert.equal(creds?.baseUrl, A, 'the shared entry is unchanged')
  assert.equal(creds?.apiKey, 'shared-key')
  assert.equal(getAiConfig().roles.embed.baseUrl, B, 'and the running process follows')
})

test('clearing one role removes only that override', async () => {
  const d = dir()
  await connected(d)
  writeCredentials(
    {
      baseUrl: A,
      apiKey: 'shared-key',
      providerId: 'claude',
      roles: { embed: { baseUrl: B, apiKey: 'e', providerId: 'openai' } },
    },
    d,
  )
  setAiCredentials(readCredentials(d))

  const { res, sent } = mockRes()
  await handleClearEndpoint(fakeReq({ role: 'embed' }), res, { dir: d, load })
  assert.equal(sent.code, 200)
  assert.deepEqual(readCredentials(d), { baseUrl: A, apiKey: 'shared-key', providerId: 'claude' })
  // The shared entry is Claude, so falling back to it is no embeddings at all.
  assert.equal(getAiConfig().roles.embed.baseUrl, null, 'embedding is off, not sent to Claude')
})

// The credential file is ignored entirely once any *_BASE_URL is set by env,
// so a save there would answer 200 and change nothing at all.
test('with the endpoint set by environment, both routes refuse rather than write a file nobody reads', async t => {
  const d = dir()
  await connected(d)
  process.env.KOTHAI_AI_BASE_URL = A
  t.after(() => delete process.env.KOTHAI_AI_BASE_URL)

  const saved = mockRes()
  await handleSaveEndpoint(
    fakeReq({ endpoint: { providerId: 'openai', baseUrl: B, apiKey: 'k' }, role: 'embed' }),
    saved.res,
    {
      dir: d,
      load,
    },
  )
  assert.equal(saved.sent.code, 409)
  assert.equal(saved.sent.json().code, 'env_managed')

  const cleared = mockRes()
  await handleClearEndpoint(fakeReq({}), cleared.res, { dir: d, load })
  assert.equal(cleared.sent.code, 409)
  assert.equal(cleared.sent.json().code, 'env_managed')
  assert.equal(readCredentials(d)?.baseUrl, A, 'the file is untouched')
})

test('GET /api/settings reports each role, and which ones borrow the shared endpoint', async t => {
  setAiCredentials({ baseUrl: A, apiKey: 'k', roles: { embed: { baseUrl: B, apiKey: 'e', providerId: 'openai' } } })
  process.env.KOTHAI_AI_EMBED_MODEL = 'pinned-embed'
  t.after(() => delete process.env.KOTHAI_AI_EMBED_MODEL)
  await initProvider({}, { load })
  const { res, sent } = mockRes()
  await handleGetSettings(res)
  const body = sent.json()
  const endpoints = record(body.endpoints)
  assert.deepEqual(endpoints.vision, { configured: true, host: '127.0.0.1', inherited: true, providerId: null })
  assert.deepEqual(endpoints.embed, { configured: true, host: '127.0.0.1', inherited: false, providerId: 'openai' })
  assert.equal(record(endpoints.llm).inherited, false)
  assert.deepEqual(body.endpoint, endpoints.llm, 'the old field is the shared entry')
  // The name, so Settings shows the model in use rather than the stored one
  // env overrides. A model id is not a credential.
  assert.deepEqual(body.envModels, { embed: 'pinned-embed' })
  assert.equal(body.source, 'file')
})

// The vectors in the library belong to one model at one endpoint. Pointing the
// role somewhere new while keeping the model's name is still a new space: two
// hosts serving "text-embedding-3-small" need not agree, and the library would
// keep the old one's vectors while queries used the new one.
test('moving the embedding role to another endpoint re-embeds the library, even under the same model name', async () => {
  const d = dir()
  store._reset({ keepDb: true })
  await connected(d)
  await store.addNote({ title: 'Brown butter pasta', embedding: [1, 0] })

  await handleSaveEndpoint(
    fakeReq({
      endpoint: { providerId: 'openai', baseUrl: B, apiKey: 'e' },
      models: { embed: 'text-embedding-3-small' },
      role: 'embed',
    }),
    mockRes().res,
    { dir: d, load },
  )
  await enrich.queueJob(() => {}) // drain
  assert.equal(calls.remoteEmbeds, 1, 'the note was embedded again at the new endpoint')

  // Saving the same endpoint again moves nothing.
  await handleSaveEndpoint(
    fakeReq({ endpoint: { providerId: 'openai', baseUrl: B, apiKey: 'e2' }, role: 'embed' }),
    mockRes().res,
    { dir: d, load },
  )
  await enrich.queueJob(() => {})
  assert.equal(calls.remoteEmbeds, 1, 'a rotated key is not a new vector space')
})

// ---- other roles are left alone --------------------------------------------
const OLLAMA = 'http://127.0.0.1:3/v1'
const withOwnEmbed = async (d: string) => {
  writeCredentials(
    {
      baseUrl: A,
      apiKey: 'k',
      providerId: 'openai',
      roles: { embed: { baseUrl: OLLAMA, apiKey: null, providerId: 'ollama-local' } },
    },
    d,
  )
  setAiCredentials(readCredentials(d))
  await settings.save({
    configured: true,
    remote: { llm: 'gpt-4o-mini', embed: 'nomic-embed-text', vision: 'gpt-4.1-mini' },
  })
  await initProvider({}, { load })
}

// The shared save seeded every role's model from the new tile's defaults, so
// embeddings on their own Ollama were handed OpenRouter's embedding name, and a
// whole-library re-embed was queued against a model that Ollama does not have.
test('saving the shared endpoint leaves the model of a role with its own endpoint alone', async () => {
  const d = dir()
  store._reset({ keepDb: true })
  await withOwnEmbed(d)
  await store.addNote({ title: 'Brown butter pasta', embedding: [1, 0] })
  await handleSaveEndpoint(
    fakeReq({
      endpoint: { providerId: 'openrouter', baseUrl: B, apiKey: 'or' },
      models: { llm: 'openai/gpt-4o-mini', embed: 'openai/text-embedding-3-small', vision: 'openai/gpt-4.1-mini' },
    }),
    mockRes().res,
    { dir: d, load },
  )
  await enrich.queueJob(() => {})
  assert.equal(settings.getRemote().embed, 'nomic-embed-text')
  assert.equal(settings.getRemote().llm, 'openai/gpt-4o-mini', 'the shared roles still take the new names')
  assert.equal(settings.getRemote().vision, 'openai/gpt-4.1-mini')
  assert.equal(calls.remoteEmbeds, 0, 'embeddings did not move, so nothing is re-embedded')
})

// The override's model stayed stored after it was cleared, so OpenRouter's
// embedding name was sent to a shared OpenAI endpoint that does not know it.
test('clearing a role override puts that role back on the shared provider’s default model', async () => {
  const d = dir()
  await withOwnEmbed(d)
  await handleClearEndpoint(fakeReq({ role: 'embed' }), mockRes().res, { dir: d, load })
  assert.equal(settings.getRemote().embed, 'text-embedding-3-small', "OpenAI's default, not Ollama's name")
  assert.equal(settings.getRemote().llm, 'gpt-4o-mini', 'the other roles are untouched')
})

test('swapping the shared endpoint re-embeds when embeddings borrow it', async () => {
  const d = dir()
  store._reset({ keepDb: true })
  writeCredentials({ baseUrl: A, apiKey: 'k', providerId: 'openai' }, d)
  setAiCredentials(readCredentials(d))
  await settings.save({ configured: true, remote: { llm: 'gpt-4o-mini', embed: 'text-embedding-3-small' } })
  await initProvider({}, { load })
  await store.addNote({ title: 'Brown butter pasta', embedding: [1, 0] })
  await handleSaveEndpoint(
    fakeReq({
      endpoint: { providerId: 'openai', baseUrl: B, apiKey: 'k' },
      models: { embed: 'text-embedding-3-small' },
    }),
    mockRes().res,
    { dir: d, load },
  )
  await enrich.queueJob(() => {})
  assert.equal(calls.remoteEmbeds, 1)
})

// Settings → Change → Claude while embeddings borrowed the shared endpoint:
// the stored embedding name stayed, embeddings went to Claude's URL, and a
// re-embed was queued that failed on every note. Now the role is off.
test('switching the shared endpoint to Claude turns embeddings off rather than sending them to Claude', async () => {
  const d = dir()
  store._reset({ keepDb: true })
  writeCredentials({ baseUrl: A, apiKey: 'k', providerId: 'openai' }, d)
  setAiCredentials(readCredentials(d))
  await settings.save({ configured: true, remote: { llm: 'gpt-4o-mini', embed: 'text-embedding-3-small' } })
  await initProvider({}, { load })
  await store.addNote({ title: 'Brown butter pasta', embedding: [1, 0] })
  await handleSaveEndpoint(
    fakeReq({
      endpoint: { providerId: 'claude', baseUrl: B, apiKey: 'ak' },
      models: { llm: 'claude-haiku-5-5', vision: 'claude-haiku-5-5', embed: '' },
    }),
    mockRes().res,
    { dir: d, load },
  )
  await enrich.queueJob(() => {})
  assert.equal(calls.remoteEmbeds, 0, 'no re-embed against an endpoint with no embeddings')
  assert.equal(getAiConfig().roles.embed.baseUrl, null)
  const { res, sent } = mockRes()
  await handleGetSettings(res)
  assert.deepEqual(record(sent.json().endpoints).embed, {
    configured: false,
    host: null,
    inherited: true,
    providerId: null,
  })
})

// With only KOTHAI_AI_EMBED_BASE_URL set, first run offered the wizard, which
// wrote a credential file env mode ignores and answered 200.
test('in env mode first run cannot write an endpoint either, and Settings is told why', async t => {
  const d = dir()
  await initProvider({}, { load })
  process.env.KOTHAI_AI_EMBED_BASE_URL = B
  t.after(() => delete process.env.KOTHAI_AI_EMBED_BASE_URL)

  const applied = mockRes()
  await handleSetupEndpoint(fakeReq({ endpoint: { providerId: 'openai', baseUrl: A, apiKey: 'k' } }), applied.res, {
    dir: d,
    load,
  })
  assert.equal(applied.sent.code, 409)
  assert.equal(applied.sent.json().code, 'env_managed')
  const setup = mockRes()
  await handleSetup(fakeReq({ endpoint: { providerId: 'openai', baseUrl: A, apiKey: 'k' } }), setup.res, {
    dir: d,
    load,
  })
  assert.equal(setup.sent.code, 409, 'nor by the endpoint field of the final setup post')
  assert.equal(existsSync(path.join(d, 'credentials.json')), false)

  const got = mockRes()
  await handleGetSettings(got.res)
  assert.equal(got.sent.json().source, 'env')
})
