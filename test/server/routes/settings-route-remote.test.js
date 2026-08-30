// The settings API must describe the provider well enough for the client to
// render the right UI, and must never echo the API key or the full endpoint
// URL — some providers carry credentials in the URL path, so the whole
// string is treated as secret and only the hostname is returned.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { initProvider, _reset } from '../../../server/ai/index.js'
import { handleGetSettings } from '../../../server/routes/settings.js'
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
