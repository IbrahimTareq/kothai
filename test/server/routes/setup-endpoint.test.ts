// First run can now hand the server an endpoint and a key. The key goes to the
// credential file (never SQLite), the provider is reconfigured in place, and
// the model ids follow the path they already took.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _reset, initProvider } from '../../../server/ai/index.ts'
import type { ProviderKind } from '../../../server/ai/routing.ts'
import { handleSetup, handleSetupEndpoint, handleGetSettings } from '../../../server/routes/settings.ts'
import { _resetDb } from '../../../server/data/db.ts'
import * as settings from '../../../server/data/settings.ts'
import { setAiCredentials, getAiConfig } from '../../../server/config.ts'
import { readCredentials } from '../../../server/data/credentials.ts'
import { mockReq, mockRes, record, records } from '../../helpers/http.ts'
import { loader, provider } from '../../helpers/providers.ts'

const fakeReq = (body: unknown) => mockReq({ body: JSON.stringify(body) })
const dir = () => mkdtempSync(path.join(tmpdir(), 'kothai-setup-'))

// A stand-in provider. Without this, initProvider('local') resolves the REAL
// on-device provider and handleSetup's queued job tries to download several GB
// of weights — which is what hung an earlier version of this file. The facade
// reaches local-only calls through L()?.boot?.() and friends, so a fake that
// omits them is fine: those resolve to Promise.resolve().
const fakeProvider = (kind: ProviderKind) =>
  provider({
    capabilities: () => ({ kind, managesResidency: kind === 'local', downloadsWeights: kind === 'local' }),
  })
const load = loader(fakeProvider)

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
  const { res, sent } = mockRes()
  await handleSetup(
    fakeReq({
      endpoint: { providerId: 'openai', baseUrl: ENDPOINT, apiKey: 'sk-wizard' },
      remote: { llm: 'gpt-4o-mini' },
    }),
    res,
    { dir: d },
  )
  assert.equal(sent.code, 200)
  assert.deepEqual(readCredentials(d), { baseUrl: ENDPOINT, apiKey: 'sk-wizard', providerId: 'openai' })
  assert.equal(getAiConfig().provider, 'remote', 'the running process must be remote now')
})

test('the credential file is 0600', async () => {
  const d = dir()
  await initProvider('local', {}, { load, localAvailable: true })
  await handleSetup(fakeReq({ endpoint: { providerId: 'openai', baseUrl: ENDPOINT, apiKey: 'sk-x' } }), mockRes().res, {
    dir: d,
  })
  assert.equal(statSync(path.join(d, 'credentials.json')).mode & 0o777, 0o600)
})

test('a setup with no endpoint writes no credential file at all', async () => {
  const d = dir()
  await initProvider('local', {}, { load, localAvailable: true })
  await handleSetup(fakeReq({ llm: 'QWEN3_1_7B_INST_Q4' }), mockRes().res, { dir: d })
  assert.equal(existsSync(path.join(d, 'credentials.json')), false)
})

test('an endpoint with no base URL is rejected before anything is written', async () => {
  const d = dir()
  await initProvider('local', {}, { load, localAvailable: true })
  const { res, sent } = mockRes()
  await handleSetup(fakeReq({ endpoint: { providerId: 'openai', apiKey: 'sk-x' } }), res, { dir: d })
  assert.equal(sent.code, 400)
  assert.equal(existsSync(path.join(d, 'credentials.json')), false)
})

test('GET /api/settings offers the catalogue so the wizard can render tiles', async () => {
  await initProvider('local', {}, { load, localAvailable: true })
  const { res, sent } = mockRes()
  await handleGetSettings(res)
  const endpoints = records(sent.json().endpoints)
  assert.ok(endpoints.some(e => e.id === 'openai'))
})

test('the Railway tile is offered on Railway and withheld everywhere else', async () => {
  // ollama.railway.internal resolves only inside the project the template
  // deploys, so the tile is a dead end on a laptop or a VPS install.
  await initProvider('local', {}, { load, localAvailable: true })
  const offered = async () => {
    const { res, sent } = mockRes()
    await handleGetSettings(res)
    return records(sent.json().endpoints).some(e => e.id === 'ollama-railway')
  }
  assert.equal(await offered(), false, 'a non-Railway install must not be offered it')

  process.env.RAILWAY_ENVIRONMENT = 'production'
  try {
    assert.equal(await offered(), true, 'the template deploys with this set')
  } finally {
    delete process.env.RAILWAY_ENVIRONMENT
  }
})

test('GET /api/settings still never echoes a credential', async () => {
  setAiCredentials({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-secret' })
  await initProvider('remote', {}, { load, localAvailable: false })
  const { res, sent } = mockRes()
  await handleGetSettings(res)
  assert.ok(!JSON.stringify(sent.json()).includes('sk-secret'))
})

// The ordering bug this route exists to prevent: the model picker asks about
// each role in the shape its provider needs, so the endpoint has to be applied
// BEFORE that screen is drawn — but applying it must not end first run, or the
// picker would never get to submit anything.
test('applying an endpoint mid-first-run does not mark the install configured', async () => {
  const d = dir()
  await initProvider('local', {}, { load, localAvailable: true })
  const { res, sent } = mockRes()
  await handleSetupEndpoint(fakeReq({ endpoint: { providerId: 'openai', baseUrl: ENDPOINT, apiKey: 'sk-mid' } }), res, {
    dir: d,
  })
  assert.equal(sent.code, 200)
  assert.deepEqual(readCredentials(d), { baseUrl: ENDPOINT, apiKey: 'sk-mid', providerId: 'openai' })
  assert.equal(settings.isConfigured(), false, 'first run must still be open')
})

test('applying an endpoint reports the capabilities the picker should draw against', async () => {
  const d = dir()
  await initProvider('local', {}, { load, localAvailable: true })
  const { res, sent } = mockRes()
  await handleSetupEndpoint(fakeReq({ endpoint: { providerId: 'openai', baseUrl: ENDPOINT, apiKey: 'sk-mid' } }), res, {
    dir: d,
  })
  const body = sent.json()
  assert.ok(body.capabilities, 'the client re-reads roles from this')
  assert.equal(record(record(body.capabilities).roles).llm, 'remote')
})

test('a request with no endpoint is rejected rather than silently doing nothing', async () => {
  await initProvider('local', {}, { load, localAvailable: true })
  const { res, sent } = mockRes()
  await handleSetupEndpoint(fakeReq({}), res, { dir: dir() })
  assert.equal(sent.code, 400)
})

// The installer asks which service in the terminal, because that answer picks
// the image. Echoing it back is what stops the wizard asking a second time.
test('GET /api/settings reports what the installer already asked', async () => {
  await initProvider('local', {}, { load, localAvailable: true })
  const { res, sent } = mockRes()
  await handleGetSettings(res)
  const body = sent.json()
  assert.ok('setup' in body, 'the client branches on this')
  assert.ok('providerId' in record(body.setup))
})

// The whole point of the seeding: naming an endpoint embedding model is what
// keeps the role off this machine. Connecting OpenAI and still being handed a
// 300 MB local download was the bug.
test('a provider that serves embeddings takes the embedding role too', async () => {
  const d = dir()
  await initProvider('local', {}, { load, localAvailable: true })
  const { res, sent } = mockRes()
  await handleSetupEndpoint(
    fakeReq({
      endpoint: { providerId: 'openai', baseUrl: ENDPOINT, apiKey: 'sk-e' },
      models: { llm: 'gpt-4o-mini', embed: 'text-embedding-3-small', vision: 'gpt-4o-mini' },
    }),
    res,
    { dir: d },
  )
  assert.equal(sent.code, 200)
  const roles = record(record(sent.json().capabilities).roles)
  assert.equal(roles.embed, 'remote', 'no local download for a provider that serves it')
  assert.equal(settings.getRemote().embed, 'text-embedding-3-small')
})

// Not a catalogue entry — the offered providers all serve embeddings now. This
// is the endpoint someone points at themselves with --endpoint or
// KOTHAI_AI_BASE_URL, where naming no embedding model is the whole signal.
test('an endpoint with no embedding model named leaves that role on this machine', async () => {
  const d = dir()
  await initProvider('local', {}, { load, localAvailable: true })
  const { res, sent } = mockRes()
  await handleSetupEndpoint(
    fakeReq({
      endpoint: { providerId: null, baseUrl: ENDPOINT, apiKey: 'sk-e' },
      models: { llm: 'some-chat-model', embed: '', vision: '' },
    }),
    res,
    { dir: d },
  )
  const roles = record(record(sent.json().capabilities).roles)
  assert.equal(roles.embed, 'local', 'it serves no embeddings, so we keep one here')
  assert.equal(roles.llm, 'remote')
})

// The exact flow a person walks: connect a provider in the wizard, then press
// Save & start on the picker. Seeding the model names must not make the server
// think first run already finished — that answered the second request with
// 409 "already configured" and stranded them on the picker.
test('connecting a provider then finishing first run is not "already configured"', async () => {
  const d = dir()
  await initProvider('remote', {}, { load, localAvailable: false })
  const applied = mockRes()
  await handleSetupEndpoint(
    fakeReq({
      endpoint: { providerId: 'openai', baseUrl: ENDPOINT, apiKey: 'sk-flow' },
      models: { llm: 'gpt-4o-mini', embed: 'text-embedding-3-small', vision: 'gpt-4o-mini' },
    }),
    applied.res,
    { dir: d },
  )
  assert.equal(applied.sent.code, 200)

  const done = mockRes()
  await handleSetup(
    fakeReq({ remote: { llm: 'gpt-4o-mini', embed: 'text-embedding-3-small', vision: 'gpt-4o-mini' } }),
    done.res,
    { dir: d },
  )
  assert.equal(done.sent.code, 200, `Save & start was refused: ${JSON.stringify(done.sent.body)}`)
  assert.equal(settings.isConfigured(), true, 'and first run is genuinely over afterwards')
})
