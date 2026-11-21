// Route-level tests for POST /api/enrich/retag-all. The retagAll() pipeline
// itself is covered by test/retag-all.test.ts — this checks only the HTTP
// wiring, and specifically the two guards that stop a whole-library job from
// being started when it cannot possibly do useful work.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mockRes } from '../../helpers/http.ts'
import type { Role } from '../../../server/ai/roles.ts'

let retagAllImpl: () => Promise<number>
let availableImpl: () => boolean
let enabledImpl: () => Record<Role, boolean>

const realEnrich = await import('../../../server/ai/enrich.ts')
const realAi = await import('../../../server/ai/index.ts')

mock.module('../../../server/ai/enrich.ts', { namedExports: { ...realEnrich, retagAll: () => retagAllImpl() } })
mock.module('../../../server/ai/index.ts', {
  namedExports: { ...realAi, available: () => availableImpl(), roleEnabled: (role: Role) => enabledImpl()[role] },
})

const { handleRetagAll } = await import('../../../server/routes/enrich.ts')

function ok() {
  availableImpl = () => true
  enabledImpl = () => ({ llm: true, embed: true, vision: true })
  retagAllImpl = async () => 1688
}

test('200 with the queued count on success', async () => {
  ok()
  const { res, sent } = mockRes()
  await handleRetagAll(res)
  assert.equal(sent.code, 200)
  assert.deepEqual(sent.json(), { ok: true, queued: 1688 })
})

test('503 when the inference provider is unavailable, and nothing is queued', async () => {
  ok()
  availableImpl = () => false
  let called = false
  retagAllImpl = async () => {
    called = true
    return 0
  }

  const { res, sent } = mockRes()
  await handleRetagAll(res)
  assert.equal(sent.code, 503)
  assert.equal(sent.json().code, 'provider_unavailable')
  assert.equal(called, false, 'a dead endpoint must not be handed the whole library')
})

test('409 when the language model is off — re-tagging is entirely an LLM job', async () => {
  ok()
  enabledImpl = () => ({ llm: false, embed: true, vision: true })
  let called = false
  retagAllImpl = async () => {
    called = true
    return 0
  }

  const { res, sent } = mockRes()
  await handleRetagAll(res)
  assert.equal(sent.code, 409)
  assert.equal(sent.json().code, 'llm_off')
  assert.equal(called, false, 'without the LLM every note would be marked pending for nothing')
})
