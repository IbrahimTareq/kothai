// First run can now hand the server an endpoint and a key. The key goes to the
// credential file (never SQLite), the provider is reconfigured in place, and
// the model ids follow the path they already took.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _reset, initProvider, roleEnabled } from '../../../server/ai/index.ts'
import { handleSetup, handleSetupEndpoint, handleGetSettings } from '../../../server/routes/settings.ts'
import { _resetDb } from '../../../server/data/db.ts'
import * as settings from '../../../server/data/settings.ts'
import { setAiCredentials, getAiConfig } from '../../../server/config.ts'
import { readCredentials } from '../../../server/data/credentials.ts'
import { mockReq, mockRes, record, records } from '../../helpers/http.ts'
import { provider } from '../../helpers/providers.ts'

const fakeReq = (body: unknown) => mockReq({ body: JSON.stringify(body) })
const dir = () => mkdtempSync(path.join(tmpdir(), 'kothai-setup-'))

// A stand-in for the provider at boot. The routes reconfigure without it, onto
// the real remote provider pointed at ENDPOINT below.
const load = () => provider({ capabilities: () => ({ kind: 'remote' }) })

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
  await initProvider({}, { load })
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
  assert.equal(getAiConfig().roles.llm.baseUrl, ENDPOINT, 'the running process must use it now')
})

test('the credential file is 0600', async () => {
  const d = dir()
  await initProvider({}, { load })
  await handleSetup(fakeReq({ endpoint: { providerId: 'openai', baseUrl: ENDPOINT, apiKey: 'sk-x' } }), mockRes().res, {
    dir: d,
  })
  assert.equal(statSync(path.join(d, 'credentials.json')).mode & 0o777, 0o600)
})

test('a setup with no endpoint writes no credential file at all', async () => {
  const d = dir()
  await initProvider({}, { load })
  await handleSetup(fakeReq({ remote: { llm: 'gpt-4o-mini' } }), mockRes().res, { dir: d })
  assert.equal(existsSync(path.join(d, 'credentials.json')), false)
})

test('an endpoint with no base URL is rejected before anything is written', async () => {
  const d = dir()
  await initProvider({}, { load })
  const { res, sent } = mockRes()
  await handleSetup(fakeReq({ endpoint: { providerId: 'openai', apiKey: 'sk-x' } }), res, { dir: d })
  assert.equal(sent.code, 400)
  assert.equal(existsSync(path.join(d, 'credentials.json')), false)
})

test('GET /api/settings offers the catalogue so the wizard can render tiles', async () => {
  await initProvider({}, { load })
  const { res, sent } = mockRes()
  await handleGetSettings(res)
  const endpoints = records(sent.json().catalogue)
  assert.ok(endpoints.some(e => e.id === 'openai'))
})

// The tile used to be offered on Railway, pointing at an Ollama the
// "Kothai + Ollama" template deployed beside the app. Retired: Railway has no
// GPUs, and on its shared CPU llama3.2:3b took 41-84s to classify one note
// against a 60s budget, with captioning off entirely. A hosted endpoint is
// what Railway gets now; Ollama belongs on the user's own hardware.
test('a Railway install is not offered an Ollama on Railway', async () => {
  await initProvider({}, { load })
  process.env.RAILWAY_ENVIRONMENT = 'production'
  try {
    const { res, sent } = mockRes()
    await handleGetSettings(res)
    const ids = records(sent.json().catalogue).map(e => e.id)
    assert.ok(!ids.includes('ollama-railway'), `offered: ${ids.join(', ')}`)
  } finally {
    delete process.env.RAILWAY_ENVIRONMENT
  }
})

test('GET /api/settings still never echoes a credential', async () => {
  setAiCredentials({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-secret' })
  await initProvider({}, { load })
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
  await initProvider({}, { load })
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
  await initProvider({}, { load })
  const { res, sent } = mockRes()
  await handleSetupEndpoint(fakeReq({ endpoint: { providerId: 'openai', baseUrl: ENDPOINT, apiKey: 'sk-mid' } }), res, {
    dir: d,
  })
  const body = sent.json()
  assert.deepEqual(body.capabilities, { kind: 'remote' })
})

test('a request with no endpoint is rejected rather than silently doing nothing', async () => {
  await initProvider({}, { load })
  const { res, sent } = mockRes()
  await handleSetupEndpoint(fakeReq({}), res, { dir: dir() })
  assert.equal(sent.code, 400)
})

// The installer asks which service in the terminal, because that answer picks
// the image. Echoing it back is what stops the wizard asking a second time.
test('GET /api/settings reports what the installer already asked', async () => {
  await initProvider({}, { load })
  const { res, sent } = mockRes()
  await handleGetSettings(res)
  const body = sent.json()
  assert.ok('setup' in body, 'the client branches on this')
  assert.ok('providerId' in record(body.setup))
})

// Seeded with the endpoint, so the picker is drawn with the provider's models
// already in place.
test('a provider that serves embeddings takes the embedding role too', async () => {
  const d = dir()
  await initProvider({}, { load })
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
  assert.equal(settings.getRemote().embed, 'text-embedding-3-small')
  assert.equal(roleEnabled('embed'), true)
})

// Not a catalogue entry. This is the endpoint someone points at themselves
// with --endpoint or KOTHAI_AI_BASE_URL; with no embedding model named, the
// role has nothing to run, and there is no on-device model to fall back on.
test('an endpoint with no embedding model named leaves that role off', async () => {
  const d = dir()
  await initProvider({}, { load })
  const { res, sent } = mockRes()
  await handleSetupEndpoint(
    fakeReq({
      endpoint: { providerId: null, baseUrl: ENDPOINT, apiKey: 'sk-e' },
      models: { llm: 'some-chat-model', embed: '', vision: '' },
    }),
    res,
    { dir: d },
  )
  assert.equal(sent.code, 200)
  assert.equal(roleEnabled('embed'), false)
  assert.equal(roleEnabled('llm'), true)
})

// The exact flow a person walks: connect a provider in the wizard, then press
// Save & start on the picker. Seeding the model names must not make the server
// think first run already finished — that answered the second request with
// 409 "already configured" and stranded them on the picker.
test('connecting a provider then finishing first run is not "already configured"', async () => {
  const d = dir()
  await initProvider({}, { load })
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

// The second step of connecting Claude: it serves no embeddings, so first run
// asks for another provider for search by meaning, and that choice lands as
// the embedding role's own entry while the shared one stays Claude.
test('an endpoint applied mid-first-run for one role is written as that role alone', async () => {
  const d = dir()
  await initProvider({}, { load })
  await handleSetupEndpoint(
    fakeReq({
      endpoint: { providerId: 'claude', baseUrl: ENDPOINT, apiKey: 'sk-ant' },
      models: { llm: 'claude-haiku-5-5' },
    }),
    mockRes().res,
    { dir: d },
  )
  const { res, sent } = mockRes()
  await handleSetupEndpoint(
    fakeReq({
      endpoint: { providerId: 'openai', baseUrl: 'http://127.0.0.1:2/v1', apiKey: 'sk-oa' },
      models: { embed: 'text-embedding-3-small', llm: 'not-this-one' },
      role: 'embed',
    }),
    res,
    { dir: d },
  )
  assert.equal(sent.code, 200)
  const creds = readCredentials(d)
  assert.equal(creds?.providerId, 'claude', 'the shared entry is still Claude')
  assert.equal(creds?.roles?.embed?.providerId, 'openai')
  assert.equal(settings.getRemote().embed, 'text-embedding-3-small')
  assert.equal(settings.getRemote().llm, 'claude-haiku-5-5', "a role's save names only that role's model")
})

// Skip used to store every role as 'off' and leave the model names; with
// residency gone, the cleared names are what keep a skipped install's roles off.
test('skipping first run marks it done and clears every model name', async () => {
  await settings.save({ remote: { llm: 'gpt-4o-mini', embed: 'text-embedding-3-small', vision: 'gpt-4.1-mini' } })
  await initProvider({}, { load })
  const { res, sent } = mockRes()
  await handleSetup(fakeReq({ skip: true }), res, { dir: dir() })
  assert.equal(sent.code, 200)
  assert.equal(settings.isConfigured(), true)
  assert.deepEqual(settings.getRemote(), { llm: '', embed: '', vision: '' })
})
