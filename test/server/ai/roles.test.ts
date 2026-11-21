// Unit tests for server/ai/roles.ts — the role list and FeatureDisabledError.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FeatureDisabledError, ROLES } from '../../../server/ai/roles.ts'

test('ROLES lists exactly the three roles', () => {
  assert.deepEqual(ROLES, ['llm', 'embed', 'vision'])
})

test('FeatureDisabledError keeps its historical default code and message', () => {
  const e = new FeatureDisabledError('embed')
  assert.equal(e.code, 'embed_off')
  assert.equal(e.role, 'embed')
  assert.match(e.message, /turned off/)
})

test('FeatureDisabledError accepts an override code and message for causes config can fix', () => {
  const e = new FeatureDisabledError('llm', { code: 'llm_auth_failed', message: 'Endpoint rejected the API key.' })
  assert.equal(e.code, 'llm_auth_failed')
  assert.equal(e.role, 'llm')
  assert.equal(e.message, 'Endpoint rejected the API key.')
  assert.ok(e instanceof FeatureDisabledError, 'must stay the same class the routes already catch')
})
