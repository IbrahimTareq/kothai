// The client branches its entire settings UI on capabilities, so /api/status
// must carry it. Asserted against the real handler with a stubbed response.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initProvider, _reset } from '../../../server/ai/index.js'
import { handleStatus, firstRunComplete } from '../../../server/routes/settings.js'

function fakeRes() {
  return {
    statusCode: 0, body: null, headers: {},
    writeHead(code, headers) { this.statusCode = code; this.headers = headers },
    end(body) { this.body = JSON.parse(body) },
  }
}

test('handleStatus includes a capabilities descriptor', async () => {
  _reset()
  await initProvider('local', {})
  const res = fakeRes()
  handleStatus(res)
  assert.equal(res.statusCode, 200)
  // `roles` says who serves each role; a pure-local install owns all three.
  assert.deepEqual(res.body.capabilities, {
    kind: 'local',
    managesResidency: true,
    downloadsWeights: true,
    roles: { llm: 'local', embed: 'local', vision: 'local' },
  })
})

test('handleStatus still carries the fields the client already reads', async () => {
  _reset()
  await initProvider('local', {})
  const res = fakeRes()
  handleStatus(res)
  for (const k of ['roles', 'aggregate', 'configured', 'count']) {
    assert.ok(k in res.body, `missing ${k}`)
  }
})

// The first-run gate. A provider that downloads weights has something to
// consent to, so the stored flag decides. One that does not still needs a
// model name per role before anything can run, so the gate stays open until
// there is one — otherwise a pure-remote install lands in the app with every
// role dark and nothing pointing at Settings.
test('firstRunComplete defers to the stored flag when weights are downloaded', () => {
  const caps = { downloadsWeights: true }
  const none = { llm: '', embed: '', vision: '' }
  assert.equal(firstRunComplete(caps, false, none), false)
  assert.equal(firstRunComplete(caps, true, none), true)
  // Endpoint ids are irrelevant here: a local install never reads them.
  assert.equal(firstRunComplete(caps, false, { llm: 'gpt-oss:120b', embed: '', vision: '' }), false)
})

test('a pure-remote install with no model names has not finished first run', () => {
  assert.equal(
    firstRunComplete({ downloadsWeights: false }, false, { llm: '', embed: '', vision: '' }),
    false,
  )
})

test('a pure-remote install that already has names is left alone', () => {
  // Installs predating the gate never posted /api/setup, so `configured` is
  // false — but they do carry names, and must not be sent back through setup.
  assert.equal(
    firstRunComplete({ downloadsWeights: false }, false, { llm: 'gpt-oss:120b', embed: '', vision: '' }),
    true,
  )
  // And an explicit skip stands on its own, with no names at all.
  assert.equal(
    firstRunComplete({ downloadsWeights: false }, true, { llm: '', embed: '', vision: '' }),
    true,
  )
})
