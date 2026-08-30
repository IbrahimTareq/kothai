// Route-level tests for POST /api/enrich/retag-all. The retagAll() pipeline
// itself is covered by test/retag-all.test.js — this checks only the HTTP
// wiring, and specifically the two guards that stop a whole-library job from
// being started when it cannot possibly do useful work.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

let retagAllImpl
let availableImpl
let residencyImpl

const realEnrich = await import('../../../server/ai/enrich.js')
const realAi = await import('../../../server/ai/index.js')
const realSettings = await import('../../../server/data/settings.js')

mock.module('../../../server/ai/enrich.js', { namedExports: { ...realEnrich, retagAll: () => retagAllImpl() } })
mock.module('../../../server/ai/index.js', { namedExports: { ...realAi, available: () => availableImpl() } })
mock.module('../../../server/data/settings.js', { namedExports: { ...realSettings, getResidency: () => residencyImpl() } })

const { handleRetagAll } = await import('../../../server/routes/settings.js')

function mockRes() {
  const r = { code: 0, body: null }
  r.writeHead = (c) => { r.code = c; return r }
  r.end = (s) => { r.body = JSON.parse(s) }
  r.setHeader = () => {}
  return r
}

function ok() {
  availableImpl = () => true
  residencyImpl = () => ({ llm: 'ondemand', embed: 'always', vision: 'ondemand' })
  retagAllImpl = async () => 1688
}

test('200 with the queued count on success', async () => {
  ok()
  const res = mockRes()
  await handleRetagAll(res)
  assert.equal(res.code, 200)
  assert.deepEqual(res.body, { ok: true, queued: 1688 })
})

test('503 when the inference provider is unavailable, and nothing is queued', async () => {
  ok()
  availableImpl = () => false
  let called = false
  retagAllImpl = async () => { called = true; return 0 }

  const res = mockRes()
  await handleRetagAll(res)
  assert.equal(res.code, 503)
  assert.equal(res.body.code, 'provider_unavailable')
  assert.equal(called, false, 'a dead endpoint must not be handed the whole library')
})

test('409 when the language model is off — re-tagging is entirely an LLM job', async () => {
  ok()
  residencyImpl = () => ({ llm: 'off', embed: 'always', vision: 'ondemand' })
  let called = false
  retagAllImpl = async () => { called = true; return 0 }

  const res = mockRes()
  await handleRetagAll(res)
  assert.equal(res.code, 409)
  assert.equal(res.body.code, 'llm_off')
  assert.equal(called, false, 'without the LLM every note would be marked pending for nothing')
})
