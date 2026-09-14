// First run can now hand the server an endpoint and a key. The key goes to the
// credential file (never SQLite), the provider is reconfigured in place, and
// the model ids follow the path they already took.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { _reset, initProvider } from '../../../server/ai/index.js'
import { handleSetup, handleGetSettings } from '../../../server/routes/settings.js'
import { _resetDb } from '../../../server/data/db.js'
import * as settings from '../../../server/data/settings.js'
import { setAiCredentials, getAiConfig } from '../../../server/config.js'
import { readCredentials } from '../../../server/data/credentials.js'

function fakeRes() {
  return {
    statusCode: 0, body: null,
    writeHead(code) { this.statusCode = code },
    end(body) { this.body = JSON.parse(body) },
  }
}

const fakeReq = (body) => Readable.from([Buffer.from(JSON.stringify(body))])
const dir = () => mkdtempSync(path.join(tmpdir(), 'kothai-setup-'))

// A stand-in provider. Without this, initProvider('local') resolves the REAL
// on-device provider and handleSetup's queued job tries to download several GB
// of weights — which is what hung an earlier version of this file. The facade
// reaches local-only calls through L()?.boot?.() and friends, so a fake that
// omits them is fine: those resolve to Promise.resolve().
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

// Unreachable on purpose: remote.init() probes /models best-effort and
// swallows the failure, so a refused connection settles instantly instead of
// reaching out to a real provider from a unit test.
const ENDPOINT = 'http://127.0.0.1:1/v1'

beforeEach(async () => {
  _resetDb()
  settings._reset()
  await settings.load()
  _reset()
  setAiCredentials(null)
})

test('an endpoint posted at first run is stored and takes effect immediately', async () => {
  const d = dir()
  await initProvider('local', {}, { load, localAvailable: true })
  const res = fakeRes()
  await handleSetup(
    fakeReq({
      endpoint: { providerId: 'openai', baseUrl: ENDPOINT, apiKey: 'sk-wizard' },
      remote: { llm: 'gpt-4o-mini' },
    }),
    res,
    { dir: d },
  )
  assert.equal(res.statusCode, 200)
  assert.deepEqual(readCredentials(d), { baseUrl: ENDPOINT, apiKey: 'sk-wizard' })
  assert.equal(getAiConfig().provider, 'remote', 'the running process must be remote now')
})

test('the credential file is 0600', async () => {
  const d = dir()
  await initProvider('local', {}, { load, localAvailable: true })
  await handleSetup(
    fakeReq({ endpoint: { providerId: 'openai', baseUrl: ENDPOINT, apiKey: 'sk-x' } }),
    fakeRes(),
    { dir: d },
  )
  assert.equal(statSync(path.join(d, 'credentials.json')).mode & 0o777, 0o600)
})

test('a setup with no endpoint writes no credential file at all', async () => {
  const d = dir()
  await initProvider('local', {}, { load, localAvailable: true })
  await handleSetup(fakeReq({ llm: 'QWEN3_1_7B_INST_Q4' }), fakeRes(), { dir: d })
  assert.equal(existsSync(path.join(d, 'credentials.json')), false)
})

test('an endpoint with no base URL is rejected before anything is written', async () => {
  const d = dir()
  await initProvider('local', {}, { load, localAvailable: true })
  const res = fakeRes()
  await handleSetup(fakeReq({ endpoint: { providerId: 'openai', apiKey: 'sk-x' } }), res, { dir: d })
  assert.equal(res.statusCode, 400)
  assert.equal(existsSync(path.join(d, 'credentials.json')), false)
})

test('GET /api/settings offers the catalogue so the wizard can render tiles', async () => {
  await initProvider('local', {}, { load, localAvailable: true })
  const res = fakeRes()
  await handleGetSettings(res)
  assert.ok(Array.isArray(res.body.endpoints))
  assert.ok(res.body.endpoints.some((e) => e.id === 'openai'))
})

test('GET /api/settings still never echoes a credential', async () => {
  setAiCredentials({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-secret' })
  await initProvider('remote', {}, { load, localAvailable: false })
  const res = fakeRes()
  await handleGetSettings(res)
  assert.ok(!JSON.stringify(res.body).includes('sk-secret'))
})
