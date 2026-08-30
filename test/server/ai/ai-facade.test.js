// Unit tests for server/ai/index.js — provider selection and the guard that
// stops a sync accessor being called before a provider is resolved.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { _selectProvider, _reset, capabilities, initProvider } from '../../../server/ai/index.js'

test('a sync accessor before init fails loudly rather than returning undefined', () => {
  _reset()
  assert.throws(() => capabilities(), /not initialised/)
})

test('_selectProvider loads the local provider when configured local', async () => {
  const p = await _selectProvider('local')
  assert.equal(p.capabilities().kind, 'local')
})

test('_selectProvider loads the remote provider when configured remote', async () => {
  const p = await _selectProvider('remote')
  assert.equal(p.capabilities().kind, 'remote')
})

test('a missing @qvac/sdk under provider=local produces a lite-image message, not a raw module error', async () => {
  const boom = Object.assign(new Error('Cannot find package @qvac/sdk'), { code: 'ERR_MODULE_NOT_FOUND' })
  await assert.rejects(
    () => _selectProvider('local', () => Promise.reject(boom)),
    /lite image/,
  )
})

test('a genuine error inside the local provider is not disguised as a missing SDK', async () => {
  await assert.rejects(
    () => _selectProvider('local', () => Promise.reject(new Error('syntax error'))),
    /syntax error/,
  )
})

test('initProvider is idempotent — a second call returns the same instance', async () => {
  _reset()
  const a = await initProvider('local', {})
  const b = await initProvider('local', {})
  assert.equal(a, b)
})
