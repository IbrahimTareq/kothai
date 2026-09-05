// The client branches its entire settings UI on capabilities, so /api/status
// must carry it. Asserted against the real handler with a stubbed response.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initProvider, _reset } from '../../../server/ai/index.js'
import { handleStatus } from '../../../server/routes/settings.js'

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
