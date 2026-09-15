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
import { _reset, initProvider } from '../../../server/ai/index.js'
import { handleSaveEndpoint, handleClearEndpoint, handleGetSettings } from '../../../server/routes/settings.js'
import { _resetDb } from '../../../server/data/db.js'
import * as settings from '../../../server/data/settings.js'
import { setAiCredentials, getAiConfig } from '../../../server/config.js'
import { readCredentials, writeCredentials } from '../../../server/data/credentials.js'

function fakeRes() {
  return {
    statusCode: 0, body: null,
    writeHead(code) { this.statusCode = code },
    end(body) { this.body = JSON.parse(body) },
  }
}
const fakeReq = (body) => Readable.from([Buffer.from(JSON.stringify(body))])
const dir = () => mkdtempSync(path.join(tmpdir(), 'kothai-chg-'))

const fakeProvider = (kind) => ({
  init: async () => {},
  capabilities: () => ({ kind, managesResidency: kind === 'local', downloadsWeights: kind === 'local' }),
  statusSnapshot: () => ({ roles: {}, aggregate: { state: 'ready', progress: 100, message: 'Ready' } }),
  listModels: async () => ({ llm: [], embed: [], vision: [] }),
  validateModel: () => ({ ok: true }),
  applySettings: async () => {},
  shutdown: async () => {},
})
const load = (kind) => Promise.resolve(fakeProvider(kind))
const A = 'http://127.0.0.1:1/v1'
const B = 'http://127.0.0.1:2/v1'

beforeEach(async () => {
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
  await handleSaveEndpoint(fakeReq({ endpoint: { providerId: 'openai', baseUrl: B, apiKey: 'new-key' } }), res, { dir: d })
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

  await handleSaveEndpoint(fakeReq({ endpoint: { providerId: 'openai', baseUrl: A, apiKey: 'rotated' } }), fakeRes(), { dir: d })
  assert.deepEqual(readCredentials(d), { baseUrl: A, apiKey: 'rotated', providerId: 'openai' })
})

test('disconnecting removes the credential and takes the roles back on-device', async () => {
  const d = dir()
  writeCredentials({ baseUrl: A, apiKey: 'k' }, d)
  setAiCredentials(readCredentials(d))
  await settings.save({ configured: true, remote: { llm: 'gpt-4o-mini', embed: 'text-embedding-3-small' } })
  await initProvider('remote', {}, { load, localAvailable: true })

  const res = fakeRes()
  await handleClearEndpoint(res, { dir: d })
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
  await handleClearEndpoint(fakeRes(), { dir: d })
  assert.equal(settings.getRemote().llm, 'gpt-4o-mini')
})

test('a malformed endpoint is refused and the working one survives', async () => {
  const d = dir()
  writeCredentials({ baseUrl: A, apiKey: 'good' }, d)
  setAiCredentials(readCredentials(d))
  await settings.save({ configured: true })
  await initProvider('remote', {}, { load, localAvailable: false })

  const res = fakeRes()
  await handleSaveEndpoint(fakeReq({ endpoint: { providerId: 'other', baseUrl: 'not a url' } }), res, { dir: d })
  assert.equal(res.statusCode, 400)
  assert.deepEqual(readCredentials(d), { baseUrl: A, apiKey: 'good', providerId: null }, 'the old one is untouched')
})

test('GET /api/settings says whether this image could run models locally', async () => {
  await initProvider('remote', {}, { load, localAvailable: false })
  const res = fakeRes()
  await handleGetSettings(res)
  assert.ok('localSupported' in res.body, 'Settings needs it to know whether to offer the switch')
})
