// The settings API must describe the provider well enough for the client to
// render the right UI, and must never echo the API key or the full endpoint
// URL — some providers carry credentials in the URL path, so the whole
// string is treated as secret and only the hostname is returned.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { initProvider, roleEnabled, _reset } from '../../../server/ai/index.ts'
import {
  handleGetSettings,
  handleSaveSettings,
  handleStatus,
  handleSetup,
  _validateModels,
} from '../../../server/routes/settings.ts'
import { _resetDb } from '../../../server/data/db.ts'
import { setAiCredentials } from '../../../server/config.ts'
import * as settings from '../../../server/data/settings.ts'
import { mockReq, mockRes, record } from '../../helpers/http.ts'

beforeEach(async () => {
  _resetDb()
  settings._reset()
  await settings.load()
  _reset()
})

test('GET /api/settings carries capabilities so the client can pick a UI shape', async () => {
  await initProvider('local', {})
  const { res, sent } = mockRes()
  await handleGetSettings(res)
  const caps = record(sent.json().capabilities)
  assert.equal(caps.kind, 'local')
  assert.equal(caps.managesResidency, true)
})

test('GET /api/settings keeps the fields the current client already reads', async () => {
  await initProvider('local', {})
  const { res, sent } = mockRes()
  await handleGetSettings(res)
  const body = sent.json()
  for (const k of ['current', 'residency', 'presets']) assert.ok(k in body, `missing ${k}`)
})

test('GET /api/settings never returns an API key or a full endpoint URL', async () => {
  await initProvider('local', {})
  const { res, sent } = mockRes()
  await handleGetSettings(res)
  const body = sent.json()
  const serialised = JSON.stringify(body)
  assert.ok(!/apiKey|api_key|Bearer/i.test(serialised), 'no credential field may appear')
  const host = record(body.endpoint).host
  assert.ok(!/^https?:\/\//.test(typeof host === 'string' ? host : ''), 'host must be a hostname, not a URL')
})

test('GET /api/settings includes the remote model selection', async () => {
  await settings.save({ remote: { llm: 'gpt-4o-mini' } })
  await initProvider('local', {})
  const { res, sent } = mockRes()
  await handleGetSettings(res)
  assert.equal(record(sent.json().remote).llm, 'gpt-4o-mini')
})

// A pure-remote install downloads nothing, so it used to report `configured`
// unconditionally and skip first-run altogether — landing the user in the app
// with no endpoint model ids set and every role throwing FeatureDisabledError.
// The names are the one thing setup still has to collect there.
// localAvailable:false is the lite image: @qvac/sdk is not installed, so no
// role can fall back on-device. Plain initProvider('remote') will not do here
// — in a dev checkout the SDK IS present, so routing keeps embedding local and
// the install comes out mixed, which downloads weights and takes the other
// branch entirely.
const LITE = { localAvailable: false }

test('GET /api/status leaves first run open on a fresh pure-remote install', async () => {
  await initProvider('remote', {}, LITE)
  const { res, sent } = mockRes()
  handleStatus(res)
  const body = sent.json()
  assert.equal(record(body.capabilities).downloadsWeights, false)
  assert.equal(body.configured, false)
})

test('GET /api/status leaves an install that predates the gate alone', async () => {
  // Names in the database with no `configured` flag is what an install set up
  // before this gate existed looks like. That is decided when settings LOAD,
  // so persist the names and reload — writing them into a store that is
  // already loaded is a different thing entirely (see the test below).
  await settings.save({ remote: { llm: 'gpt-oss:120b' } })
  settings._reset()
  await settings.load()
  await initProvider('remote', {}, LITE)
  const { res, sent } = mockRes()
  handleStatus(res)
  assert.equal(sent.json().configured, true)
})

// The counterpart, and the regression that made this distinction necessary:
// the setup wizard seeds endpoint model names partway through first run, so
// that the embedding role resolves before the model picker is drawn. While the
// gate inferred completion from "are there names?", that seeding ended first
// run early and Save & start came back 409 "already configured".
test('names written DURING first run leave it open', async () => {
  await initProvider('remote', {}, LITE)
  await settings.save({ remote: { llm: 'gpt-oss:120b' } })
  const { res, sent } = mockRes()
  handleStatus(res)
  assert.equal(sent.json().configured, false, 'first run is not over until the user says so')
})

test('a mixed install is gated on the stored flag, not on endpoint ids', async () => {
  // Embedding stays on-device here, so there ARE weights to consent to and
  // naming a remote model must not skip the download screen.
  await settings.save({ remote: { llm: 'gpt-oss:120b' } })
  await initProvider('remote', {}, { localAvailable: true })
  const { res, sent } = mockRes()
  handleStatus(res)
  const body = sent.json()
  assert.equal(record(body.capabilities).kind, 'mixed')
  assert.equal(body.configured, false)
})

// Setup used to refuse outright for a provider that downloads nothing, and to
// persist only the local half of a patch. On a pure-remote install that meant
// the one thing worth collecting — the endpoint's model ids — had nowhere to
// go. They must land in the remote store, which is the only one the remote
// provider reads back.
test('POST /api/setup stores endpoint ids on a pure-remote install', async () => {
  await initProvider('remote', {}, { localAvailable: false })
  const req = mockReq({
    body: JSON.stringify({ remote: { llm: 'gpt-oss:120b', embed: 'nomic-embed-text', vision: 'llava' } }),
  })
  const { res, sent } = mockRes()
  const localBefore = settings.get()
  await handleSetup(req, res)
  assert.equal(sent.code, 200)
  assert.deepEqual(settings.getRemote(), {
    llm: 'gpt-oss:120b',
    embed: 'nomic-embed-text',
    vision: 'llava',
  })
  // The local columns keep their preset defaults: an endpoint id written there
  // would be read back as a QVAC registry key and resolve to nothing.
  assert.deepEqual(settings.get(), localBefore)

  const status = mockRes()
  handleStatus(status.res)
  assert.equal(status.sent.json().configured, true)
})

test('POST /api/setup refuses once first run is already closed', async () => {
  // Closed the way it actually closes: the flag, set by a completed setup or
  // an explicit skip. Names alone no longer mean anything here.
  await settings.save({ remote: { llm: 'gpt-oss:120b' }, configured: true })
  await initProvider('remote', {}, { localAvailable: false })
  const req = mockReq({ body: JSON.stringify({ remote: { llm: 'other' } }) })
  const { res, sent } = mockRes()
  await handleSetup(req, res)
  assert.equal(sent.code, 409)
  assert.equal(settings.getRemote().llm, 'gpt-oss:120b')
})

// Regression. Sending untouched blanks once blocked mixed first run entirely,
// because a blank endpoint id was rejected. A blank now means "this role is
// off" (see the Settings test below), so it validates — and first run still
// sends only the names actually filled in.
test('a blank endpoint id validates as the role being off', async () => {
  await initProvider('remote', {}, { localAvailable: true })
  const local = settings.get()

  const withBlanks = _validateModels({ ...local, remote: { llm: '', embed: '', vision: '' } })
  assert.equal(withBlanks.error, undefined)

  // What a mixed first run sends once the endpoint's models are named: local
  // keys at the root, endpoint ids under remote, each to its own store.
  const filled = _validateModels({ ...local, remote: { llm: 'gpt-oss:120b', vision: 'llava:7b' } })
  assert.equal(filled.error, undefined)
  assert.deepEqual(filled.remote, { llm: 'gpt-oss:120b', vision: 'llava:7b' })
  assert.equal(filled.local.embed, local.embed)

  // And left blank, the local picks alone still validate.
  const omitted = _validateModels(local)
  assert.equal(omitted.error, undefined)
  assert.deepEqual(omitted.remote, {})
})

// Regression, from a Railway install whose vision role named llama3.2:3b, a
// text-only model, on an endpoint serving no vision model at all. Clearing the
// field was the only way out, and it came back 400 "vision model name cannot
// be empty" — so the one broken role could never be switched off.
test('clearing an endpoint model name in Settings turns that role off', async t => {
  // Port 1 refuses at once: the boot probe fails fast, and nothing here needs
  // the endpoint to answer — only to be configured.
  setAiCredentials({ baseUrl: 'http://127.0.0.1:1/v1' })
  t.after(() => setAiCredentials(null))
  await settings.save({ remote: { llm: 'llama3.2:3b', embed: 'nomic-embed-text', vision: 'llama3.2:3b' } })
  await initProvider('remote', { remote: settings.getRemote() }, LITE)
  assert.equal(roleEnabled('vision'), true)

  const { res, sent } = mockRes()
  await handleSaveSettings(mockReq({ body: JSON.stringify({ remote: { vision: '' } }) }), res)
  assert.equal(sent.code, 200, JSON.stringify(sent.json()))
  assert.equal(settings.getRemote().vision, '')
  assert.equal(roleEnabled('vision'), false)
  assert.equal(roleEnabled('llm'), true, 'the other roles are untouched')
})
