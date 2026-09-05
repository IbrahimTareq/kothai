// The settings API must describe the provider well enough for the client to
// render the right UI, and must never echo the API key or the full endpoint
// URL — some providers carry credentials in the URL path, so the whole
// string is treated as secret and only the hostname is returned.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { initProvider, _reset } from '../../../server/ai/index.js'
import { handleGetSettings, handleStatus, handleSetup, _validateModels } from '../../../server/routes/settings.js'
import { Readable } from 'node:stream'
import { _resetDb } from '../../../server/data/db.js'
import * as settings from '../../../server/data/settings.js'

function fakeRes() {
  return {
    statusCode: 0, body: null,
    writeHead(code) { this.statusCode = code },
    end(body) { this.body = JSON.parse(body) },
  }
}

beforeEach(async () => {
  _resetDb()
  settings._reset()
  await settings.load()
  _reset()
})

test('GET /api/settings carries capabilities so the client can pick a UI shape', async () => {
  await initProvider('local', {})
  const res = fakeRes()
  await handleGetSettings(res)
  assert.equal(res.body.capabilities.kind, 'local')
  assert.equal(res.body.capabilities.managesResidency, true)
})

test('GET /api/settings keeps the fields the current client already reads', async () => {
  await initProvider('local', {})
  const res = fakeRes()
  await handleGetSettings(res)
  for (const k of ['current', 'residency', 'presets']) assert.ok(k in res.body, `missing ${k}`)
})

test('GET /api/settings never returns an API key or a full endpoint URL', async () => {
  await initProvider('local', {})
  const res = fakeRes()
  await handleGetSettings(res)
  const serialised = JSON.stringify(res.body)
  assert.ok(!/apiKey|api_key|Bearer/i.test(serialised), 'no credential field may appear')
  assert.ok(!/^https?:\/\//.test(res.body.endpoint?.host || ''), 'host must be a hostname, not a URL')
})

test('GET /api/settings includes the remote model selection', async () => {
  await settings.save({ remote: { llm: 'gpt-4o-mini' } })
  await initProvider('local', {})
  const res = fakeRes()
  await handleGetSettings(res)
  assert.equal(res.body.remote.llm, 'gpt-4o-mini')
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
  const res = fakeRes()
  handleStatus(res)
  assert.equal(res.body.capabilities.downloadsWeights, false)
  assert.equal(res.body.configured, false)
})

test('GET /api/status closes first run once the endpoint ids are saved', async () => {
  await settings.save({ remote: { llm: 'gpt-oss:120b' } })
  await initProvider('remote', {}, LITE)
  const res = fakeRes()
  handleStatus(res)
  assert.equal(res.body.configured, true)
})

test('a mixed install is gated on the stored flag, not on endpoint ids', async () => {
  // Embedding stays on-device here, so there ARE weights to consent to and
  // naming a remote model must not skip the download screen.
  await settings.save({ remote: { llm: 'gpt-oss:120b' } })
  await initProvider('remote', {}, { localAvailable: true })
  const res = fakeRes()
  handleStatus(res)
  assert.equal(res.body.capabilities.kind, 'mixed')
  assert.equal(res.body.configured, false)
})

// Setup used to refuse outright for a provider that downloads nothing, and to
// persist only the local half of a patch. On a pure-remote install that meant
// the one thing worth collecting — the endpoint's model ids — had nowhere to
// go. They must land in the remote store, which is the only one the remote
// provider reads back.
test('POST /api/setup stores endpoint ids on a pure-remote install', async () => {
  await initProvider('remote', {}, { localAvailable: false })
  const req = Readable.from([Buffer.from(JSON.stringify({
    remote: { llm: 'gpt-oss:120b', embed: 'nomic-embed-text', vision: 'llava' },
  }))])
  const res = fakeRes()
  const localBefore = settings.get()
  await handleSetup(req, res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(settings.getRemote(), {
    llm: 'gpt-oss:120b', embed: 'nomic-embed-text', vision: 'llava',
  })
  // The local columns keep their preset defaults: an endpoint id written there
  // would be read back as a QVAC registry key and resolve to nothing.
  assert.deepEqual(settings.get(), localBefore)

  const status = fakeRes()
  handleStatus(status)
  assert.equal(status.body.configured, true)
})

test('POST /api/setup refuses once first run is already closed', async () => {
  await settings.save({ remote: { llm: 'gpt-oss:120b' } })
  await initProvider('remote', {}, { localAvailable: false })
  const req = Readable.from([Buffer.from(JSON.stringify({ remote: { llm: 'other' } }))])
  const res = fakeRes()
  await handleSetup(req, res)
  assert.equal(res.statusCode, 409)
  assert.equal(settings.getRemote().llm, 'gpt-oss:120b')
})

// Regression. First run posts a model id for every role the endpoint serves,
// but an empty name is rejected — so the screen sends only the ones actually
// filled in. Sending untouched blanks blocked mixed first run entirely, and a
// blank has to stay legitimate: that role is simply named later in Settings.
test('a blank endpoint id is rejected, so first run omits rather than sends it', async () => {
  await initProvider('remote', {}, { localAvailable: true })
  const local = settings.get()

  const withBlanks = _validateModels({ ...local, remote: { llm: '', embed: '', vision: '' } })
  assert.match(withBlanks.error, /cannot be empty/)

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
