// Changing the endpoint AFTER first run. Until this existed, the provider and
// key were fixed at setup: a rotated API key or a switch from one service to
// another meant recreating the container, which is the exact problem the
// credential store was built to remove.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { _reset, initProvider } from '../../../server/ai/index.ts'
import { handleSaveEndpoint, handleClearEndpoint, handleGetSettings } from '../../../server/routes/settings.ts'
import { _resetDb } from '../../../server/data/db.ts'
import * as settings from '../../../server/data/settings.ts'
import { setAiCredentials, getAiConfig } from '../../../server/config.ts'
import { readCredentials, writeCredentials } from '../../../server/data/credentials.ts'

function fakeRes() {
  return {
    statusCode: 0,
    body: null,
    writeHead(code) {
      this.statusCode = code
    },
    end(body) {
      this.body = JSON.parse(body)
    },
  }
}
const fakeReq = body => Readable.from([Buffer.from(JSON.stringify(body))])
const dir = () => mkdtempSync(path.join(tmpdir(), 'kothai-chg-'))

// Records what the facade asks of the local provider, which is where the
// switch back actually lands.
const localCalls = { residency: [], models: [], boots: 0 }
const fakeProvider = kind => ({
  init: async () => {},
  applyResidency: async r => {
    if (kind === 'local') localCalls.residency.push(r)
  },
  configureModels: async m => {
    if (kind === 'local') localCalls.models.push(m)
  },
  boot: async () => {
    if (kind === 'local') localCalls.boots++
  },
  capabilities: () => ({ kind, managesResidency: kind === 'local', downloadsWeights: kind === 'local' }),
  statusSnapshot: () => ({ roles: {}, aggregate: { state: 'ready', progress: 100, message: 'Ready' } }),
  listModels: async () => ({ llm: [], embed: [], vision: [] }),
  validateModel: () => ({ ok: true }),
  applySettings: async () => {},
  shutdown: async () => {},
})
const load = kind => Promise.resolve(fakeProvider(kind))
const A = 'http://127.0.0.1:1/v1'
const B = 'http://127.0.0.1:2/v1'

beforeEach(async () => {
  localCalls.residency.length = 0
  localCalls.models.length = 0
  localCalls.boots = 0
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

  const res = fakeRes()
  await handleSaveEndpoint(fakeReq({ endpoint: { providerId: 'openai', baseUrl: B, apiKey: 'new-key' } }), res, {
    dir: d,
    load,
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(readCredentials(d), { baseUrl: B, apiKey: 'new-key', providerId: 'openai' })
  assert.equal(getAiConfig().baseUrl, B, 'and the running process follows')
})

test('rotating just the key keeps the endpoint', async () => {
  const d = dir()
  writeCredentials({ baseUrl: A, apiKey: 'old-key' }, d)
  setAiCredentials(readCredentials(d))
  await settings.save({ configured: true })
  await initProvider('remote', {}, { load, localAvailable: false })

  await handleSaveEndpoint(fakeReq({ endpoint: { providerId: 'openai', baseUrl: A, apiKey: 'rotated' } }), fakeRes(), {
    dir: d,
    load,
  })
  assert.deepEqual(readCredentials(d), { baseUrl: A, apiKey: 'rotated', providerId: 'openai' })
})

test('disconnecting removes the credential and takes the roles back on-device', async () => {
  const d = dir()
  writeCredentials({ baseUrl: A, apiKey: 'k' }, d)
  setAiCredentials(readCredentials(d))
  await settings.save({ configured: true, remote: { llm: 'gpt-4o-mini', embed: 'text-embedding-3-small' } })
  await initProvider('remote', {}, { load, localAvailable: true })

  const res = fakeRes()
  await handleClearEndpoint(fakeReq({}), res, { dir: d, load })
  assert.equal(res.statusCode, 200)
  assert.equal(existsSync(path.join(d, 'credentials.json')), false, 'the key is gone from disk')
  assert.equal(getAiConfig().provider, 'local')
  assert.equal(res.body.capabilities.roles.llm, 'local')
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
  await handleClearEndpoint(fakeReq({}), fakeRes(), { dir: d, load })
  assert.equal(settings.getRemote().llm, 'gpt-4o-mini')
})

test('a malformed endpoint is refused and the working one survives', async () => {
  const d = dir()
  writeCredentials({ baseUrl: A, apiKey: 'good' }, d)
  setAiCredentials(readCredentials(d))
  await settings.save({ configured: true })
  await initProvider('remote', {}, { load, localAvailable: false })

  const res = fakeRes()
  await handleSaveEndpoint(fakeReq({ endpoint: { providerId: null, baseUrl: 'not a url' } }), res, { dir: d, load })
  assert.equal(res.statusCode, 400)
  assert.deepEqual(readCredentials(d), { baseUrl: A, apiKey: 'good', providerId: null }, 'the old one is untouched')
})

test('GET /api/settings says whether this image could run models locally', async () => {
  await initProvider('remote', {}, { load, localAvailable: false })
  const res = fakeRes()
  await handleGetSettings(res)
  assert.ok('localSupported' in res.body, 'Settings needs it to know whether to offer the switch')
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

  await handleClearEndpoint(fakeReq({}), fakeRes(), { dir: d, load })

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

  await handleClearEndpoint(fakeReq({}), fakeRes(), { dir: d, load })
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
    fakeRes(),
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

  const res = fakeRes()
  await handleClearEndpoint(fakeReq({ models: { llm: 'QWEN3_4B_INST_Q4_K_M' } }), res, { dir: d, load })
  assert.equal(res.statusCode, 200)
  assert.equal(settings.get().llm, 'QWEN3_4B_INST_Q4_K_M', 'the choice made during the switch sticks')
})

test('disconnecting with no choice keeps what was already stored', async () => {
  const d = dir()
  writeCredentials({ baseUrl: A, apiKey: 'k' }, d)
  setAiCredentials(readCredentials(d))
  await settings.save({ configured: true, llm: 'QWEN3_1_7B_INST_Q4' })
  await initProvider('remote', {}, { load, localAvailable: true })

  await handleClearEndpoint(fakeReq({}), fakeRes(), { dir: d, load })
  assert.equal(settings.get().llm, 'QWEN3_1_7B_INST_Q4')
})

test('GET /api/settings carries on-device presets with sizes while a service is connected', async () => {
  await initProvider('remote', {}, { load, localAvailable: true })
  const res = fakeRes()
  await handleGetSettings(res)
  assert.ok('localPresets' in res.body, 'Settings cannot price the switch without them')
})
