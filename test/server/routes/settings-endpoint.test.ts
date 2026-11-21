// Changing the endpoint AFTER first run. Until this existed, the provider and
// key were fixed at setup: a rotated API key or a switch from one service to
// another meant recreating the container, which is the exact problem the
// credential store was built to remove.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _reset, initProvider, localSupported } from '../../../server/ai/index.ts'
import type { Residency } from '../../../server/ai/roles.ts'
import type { ProviderKind } from '../../../server/ai/routing.ts'
import type { ModelSelection } from '../../../server/ai/providers/types.ts'
import { handleSaveEndpoint, handleClearEndpoint, handleGetSettings } from '../../../server/routes/settings.ts'
import { _resetDb } from '../../../server/data/db.ts'
import * as settings from '../../../server/data/settings.ts'
import * as store from '../../../server/data/notes.ts'
import * as enrich from '../../../server/ai/enrich.ts'
import { setAiCredentials, getAiConfig } from '../../../server/config.ts'
import { readCredentials, writeCredentials } from '../../../server/data/credentials.ts'
import { mockReq, mockRes, record } from '../../helpers/http.ts'
import { loader, provider } from '../../helpers/providers.ts'

const fakeReq = (body: unknown) => mockReq({ body: JSON.stringify(body) })
const dir = () => mkdtempSync(path.join(tmpdir(), 'kothai-chg-'))

// Records what the facade asks of the local provider, which is where the
// switch back actually lands.
const localCalls: { residency: Residency[]; models: ModelSelection[]; boots: number; remoteEmbeds: number } = {
  residency: [],
  models: [],
  boots: 0,
  // Not a local call: how many notes the endpoint was asked to embed, which is
  // how a queued re-embed shows itself.
  remoteEmbeds: 0,
}
// The three optional members are stubbed here precisely because they are the
// on-device calls a role coming home has to produce; everything else the
// facade touches gets the fixture's empty answer.
const fakeProvider = (kind: ProviderKind) =>
  provider({
    applyResidency: async r => {
      if (kind === 'local') localCalls.residency.push(r)
    },
    configureModels: async m => {
      if (kind === 'local') localCalls.models.push(m)
    },
    boot: async () => {
      if (kind === 'local') localCalls.boots++
    },
    embedText: async () => {
      if (kind === 'remote') localCalls.remoteEmbeds++
      return [1]
    },
    capabilities: () => ({ kind, managesResidency: kind === 'local', downloadsWeights: kind === 'local' }),
  })
const load = loader(fakeProvider)
const A = 'http://127.0.0.1:1/v1'
const B = 'http://127.0.0.1:2/v1'

beforeEach(async () => {
  localCalls.residency.length = 0
  localCalls.models.length = 0
  localCalls.boots = 0
  localCalls.remoteEmbeds = 0
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
  await initProvider('remote', {}, { load, localAvailable: false })

  const { res, sent } = mockRes()
  await handleSaveEndpoint(fakeReq({ endpoint: { providerId: 'openai', baseUrl: B, apiKey: 'new-key' } }), res, {
    dir: d,
    load,
  })
  assert.equal(sent.code, 200)
  assert.deepEqual(readCredentials(d), { baseUrl: B, apiKey: 'new-key', providerId: 'openai' })
  assert.equal(getAiConfig().baseUrl, B, 'and the running process follows')
})

test('rotating just the key keeps the endpoint', async () => {
  const d = dir()
  writeCredentials({ baseUrl: A, apiKey: 'old-key' }, d)
  setAiCredentials(readCredentials(d))
  await settings.save({ configured: true })
  await initProvider('remote', {}, { load, localAvailable: false })

  await handleSaveEndpoint(
    fakeReq({ endpoint: { providerId: 'openai', baseUrl: A, apiKey: 'rotated' } }),
    mockRes().res,
    { dir: d, load },
  )
  assert.deepEqual(readCredentials(d), { baseUrl: A, apiKey: 'rotated', providerId: 'openai' })
})

test('disconnecting removes the credential and takes the roles back on-device', async () => {
  const d = dir()
  writeCredentials({ baseUrl: A, apiKey: 'k' }, d)
  setAiCredentials(readCredentials(d))
  await settings.save({ configured: true, remote: { llm: 'gpt-4o-mini', embed: 'text-embedding-3-small' } })
  await initProvider('remote', {}, { load, localAvailable: true })

  const { res, sent } = mockRes()
  await handleClearEndpoint(fakeReq({}), res, { dir: d, load })
  assert.equal(sent.code, 200)
  assert.equal(existsSync(path.join(d, 'credentials.json')), false, 'the key is gone from disk')
  assert.equal(getAiConfig().provider, 'local')
  assert.equal(record(record(sent.json().capabilities).roles).llm, 'local')
})

// The endpoint's model names are deliberately left alone on disconnect: they
// cost nothing while unused, and keeping them means reconnecting the same
// provider does not mean typing them again.
test('disconnecting keeps the endpoint model names for next time', async () => {
  const d = dir()
  writeCredentials({ baseUrl: A, apiKey: 'k' }, d)
  setAiCredentials(readCredentials(d))
  await settings.save({ configured: true, remote: { llm: 'gpt-4o-mini' } })
  await initProvider('remote', {}, { load, localAvailable: true })
  await handleClearEndpoint(fakeReq({}), mockRes().res, { dir: d, load })
  assert.equal(settings.getRemote().llm, 'gpt-4o-mini')
})

test('a malformed endpoint is refused and the working one survives', async () => {
  const d = dir()
  writeCredentials({ baseUrl: A, apiKey: 'good' }, d)
  setAiCredentials(readCredentials(d))
  await settings.save({ configured: true })
  await initProvider('remote', {}, { load, localAvailable: false })

  const { res, sent } = mockRes()
  await handleSaveEndpoint(fakeReq({ endpoint: { providerId: null, baseUrl: 'not a url' } }), res, { dir: d, load })
  assert.equal(sent.code, 400)
  assert.deepEqual(readCredentials(d), { baseUrl: A, apiKey: 'good', providerId: null }, 'the old one is untouched')
})

test('GET /api/settings says whether this image could run models locally', async () => {
  await initProvider('remote', {}, { load, localAvailable: false })
  const { res, sent } = mockRes()
  await handleGetSettings(res)
  assert.ok('localSupported' in sent.json(), 'Settings needs it to know whether to offer the switch')
})

// Greyed rather than hidden, beside first run's own "On this machine": a
// lone pair of hosted tiles read as the only way Kothai can run.
test('on the lite image a provider on this machine is offered but unavailable', async () => {
  await initProvider('remote', {}, { load, localAvailable: false })
  // What the lite image's import of the on-device provider throws. The probe
  // caches its answer, so handleGetSettings reads this one.
  await localSupported(() => {
    throw Object.assign(new Error('absent'), { code: 'ERR_MODULE_NOT_FOUND' })
  })
  const { res, sent } = mockRes()
  await handleGetSettings(res)
  const offered = sent.json().catalogue as { id: string; available: boolean }[]
  assert.equal(offered.find(e => e.id === 'ollama-local')?.available, false)
  assert.equal(offered.find(e => e.id === 'openai')?.available, true, 'a hosted provider is unaffected by the image')
})

// The wizard's Continue used to send a blank key for OpenAI, and first run
// moved on to naming models for an endpoint that could answer none of them.
test('a provider that needs a key is refused without one, and the working one survives', async () => {
  const d = dir()
  writeCredentials({ baseUrl: A, apiKey: 'good' }, d)
  setAiCredentials(readCredentials(d))
  await settings.save({ configured: true })
  await initProvider('remote', {}, { load, localAvailable: false })

  const { res, sent } = mockRes()
  await handleSaveEndpoint(fakeReq({ endpoint: { providerId: 'openai', baseUrl: A, apiKey: ' ' } }), res, {
    dir: d,
    load,
  })
  assert.equal(sent.code, 400)
  assert.deepEqual(readCredentials(d), { baseUrl: A, apiKey: 'good', providerId: null })
})

// Disconnecting moved the roles back on paper and left them dead in practice.
// While llm and vision were served remotely the local provider had them pinned
// 'off' — correct then, and nothing re-applied residency when they came back —
// so the app returned to local with only embedding working, and an aggregate
// still cheerfully reporting Ready.
test('switching back to local turns the returning roles on', async () => {
  const d = dir()
  writeCredentials({ baseUrl: A, apiKey: 'k' }, d)
  setAiCredentials(readCredentials(d))
  await settings.save({ configured: true, residency: { llm: 'ondemand', embed: 'always', vision: 'ondemand' } })
  await initProvider('remote', {}, { load, localAvailable: true })

  await handleClearEndpoint(fakeReq({}), mockRes().res, { dir: d, load })

  const last = localCalls.residency.at(-1)
  assert.ok(last, 'residency must be re-applied when the role map changes')
  assert.equal(last.llm, 'ondemand', 'language is local again, so it must not stay off')
  assert.equal(last.vision, 'ondemand')
  assert.equal(last.embed, 'always')
})

test('switching back to local hands the local provider its own model names', async () => {
  const d = dir()
  writeCredentials({ baseUrl: A, apiKey: 'k' }, d)
  setAiCredentials(readCredentials(d))
  await settings.save({ configured: true })
  await initProvider('remote', {}, { load, localAvailable: true })

  await handleClearEndpoint(fakeReq({}), mockRes().res, { dir: d, load })
  const names = localCalls.models.at(-1)
  assert.ok(names, 'the roles it now serves need models configured')
  assert.ok(names.llm, `expected a language model, got ${JSON.stringify(names)}`)
})

// The other direction leaks rather than breaks: a role that moves OUT to an
// endpoint leaves its weights resident until something unloads them.
test('switching to a service releases the roles it takes over', async () => {
  const d = dir()
  await settings.save({ configured: true, residency: { llm: 'always', embed: 'always', vision: 'ondemand' } })
  await initProvider('local', {}, { load, localAvailable: true })

  await handleSaveEndpoint(
    fakeReq({
      endpoint: { providerId: 'openai', baseUrl: A, apiKey: 'k' },
      models: { llm: 'gpt-4o-mini', embed: 'text-embedding-3-small' },
    }),
    mockRes().res,
    { dir: d },
  )
  const last = localCalls.residency.at(-1)
  assert.ok(last, 'residency must be re-applied here too')
  assert.equal(last.llm, 'off', 'the endpoint serves language now — stop holding its weights')
})

// Switching back used to leave you on whatever defaults were stored, with the
// model pickers only reachable afterwards as a separate, unprompted step.
test('disconnecting can choose the on-device models in the same request', async () => {
  const d = dir()
  writeCredentials({ baseUrl: A, apiKey: 'k' }, d)
  setAiCredentials(readCredentials(d))
  await settings.save({ configured: true })
  await initProvider('remote', {}, { load, localAvailable: true })

  const { res, sent } = mockRes()
  await handleClearEndpoint(fakeReq({ models: { llm: 'QWEN3_4B_INST_Q4_K_M' } }), res, { dir: d, load })
  assert.equal(sent.code, 200)
  assert.equal(settings.get().llm, 'QWEN3_4B_INST_Q4_K_M', 'the choice made during the switch sticks')
})

test('disconnecting with no choice keeps what was already stored', async () => {
  const d = dir()
  writeCredentials({ baseUrl: A, apiKey: 'k' }, d)
  setAiCredentials(readCredentials(d))
  await settings.save({ configured: true, llm: 'QWEN3_1_7B_INST_Q4' })
  await initProvider('remote', {}, { load, localAvailable: true })

  await handleClearEndpoint(fakeReq({}), mockRes().res, { dir: d, load })
  assert.equal(settings.get().llm, 'QWEN3_1_7B_INST_Q4')
})

test('GET /api/settings carries on-device presets with sizes while a service is connected', async () => {
  await initProvider('remote', {}, { load, localAvailable: true })
  const { res, sent } = mockRes()
  await handleGetSettings(res)
  assert.ok('localPresets' in sent.json(), 'Settings cannot price the switch without them')
})

// ---- an endpoint per role --------------------------------------------------
// Claude serves chat and images but no embeddings, so connecting it means a
// second endpoint for the embedding role alone. That override has to be
// written and removed without touching the shared entry it sits beside.
const connected = async (d: string) => {
  writeCredentials({ baseUrl: A, apiKey: 'shared-key', providerId: 'claude' }, d)
  setAiCredentials(readCredentials(d))
  await settings.save({ configured: true, remote: { llm: 'claude-haiku-5-5', embed: 'text-embedding-3-small' } })
  await initProvider('remote', {}, { load, localAvailable: false })
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
  await initProvider('remote', {}, { load, localAvailable: false })
  const { res, sent } = mockRes()
  await handleGetSettings(res)
  const body = sent.json()
  const endpoints = record(body.endpoints)
  assert.deepEqual(endpoints.vision, { configured: true, host: '127.0.0.1', inherited: true })
  assert.deepEqual(endpoints.embed, { configured: true, host: '127.0.0.1', inherited: false })
  assert.equal(record(endpoints.llm).inherited, false)
  assert.deepEqual(body.endpoint, endpoints.llm, 'the old field is the shared entry')
  assert.deepEqual(body.envModels, { embed: true }, 'the model name itself stays out of the response')
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
  assert.equal(localCalls.remoteEmbeds, 1, 'the note was embedded again at the new endpoint')

  // Saving the same endpoint again moves nothing.
  await handleSaveEndpoint(
    fakeReq({ endpoint: { providerId: 'openai', baseUrl: B, apiKey: 'e2' }, role: 'embed' }),
    mockRes().res,
    { dir: d, load },
  )
  await enrich.queueJob(() => {})
  assert.equal(localCalls.remoteEmbeds, 1, 'a rotated key is not a new vector space')
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
  await initProvider('remote', {}, { load, localAvailable: false })
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
  assert.equal(localCalls.remoteEmbeds, 0, 'embeddings did not move, so nothing is re-embedded')
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
  await initProvider('remote', {}, { load, localAvailable: false })
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
  assert.equal(localCalls.remoteEmbeds, 1)
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
  await initProvider('remote', {}, { load, localAvailable: false })
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
  assert.equal(localCalls.remoteEmbeds, 0, 'no re-embed against an endpoint with no embeddings')
  assert.equal(getAiConfig().roles.embed.baseUrl, null)
  const { res, sent } = mockRes()
  await handleGetSettings(res)
  assert.deepEqual(record(sent.json().endpoints).embed, { configured: false, host: null, inherited: true })
})
