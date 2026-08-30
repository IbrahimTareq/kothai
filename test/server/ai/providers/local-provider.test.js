// Unit tests for the provider-contract methods providers/local.js adds on top
// of its historical surface. The four inference calls do real model I/O and
// are covered by the cross-provider contract suite instead; these are the
// pure descriptor/validation methods the facade and routes depend on.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { capabilities, validateModel } from '../../../../server/ai/providers/local.js'

test('capabilities reports a local provider that manages residency and downloads weights', () => {
  assert.deepEqual(capabilities(), { kind: 'local', managesResidency: true, downloadsWeights: true })
})

test('validateModel accepts a key from the preset catalogue', () => {
  assert.deepEqual(validateModel('llm', 'QWEN3_1_7B_INST_Q4'), { ok: true })
})

test('validateModel rejects a key that is not a known preset', () => {
  const r = validateModel('llm', 'gpt-4o-mini')
  assert.equal(r.ok, false)
  assert.match(r.error, /unknown llm model/)
})
