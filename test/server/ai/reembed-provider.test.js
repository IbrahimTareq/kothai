// The embed role changing provider invalidates every stored vector. This is
// the guard that rebuilds them, and the guard that stays quiet when nothing
// changed — a spurious re-embed of a large library is expensive.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { embedProviderChanged } from '../../../server/ai/enrich.js'

test('no stored value on a remote install means it was embedding remotely', () => {
  assert.equal(embedProviderChanged({ stored: null, resolved: 'local', wasRemote: true }), true)
  assert.equal(embedProviderChanged({ stored: null, resolved: 'remote', wasRemote: true }), false)
})

test('no stored value on a local install means it was embedding locally', () => {
  assert.equal(embedProviderChanged({ stored: null, resolved: 'local', wasRemote: false }), false)
  assert.equal(embedProviderChanged({ stored: null, resolved: 'remote', wasRemote: false }), true)
})

test('a stored value is believed over any inference', () => {
  assert.equal(embedProviderChanged({ stored: 'local', resolved: 'local', wasRemote: true }), false)
  assert.equal(embedProviderChanged({ stored: 'remote', resolved: 'local', wasRemote: false }), true)
})
