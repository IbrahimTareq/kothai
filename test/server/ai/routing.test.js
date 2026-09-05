// Unit tests for server/ai/routing.js — which provider serves which role.
// Pure resolution, so every branch is testable without a provider, an
// endpoint or the SDK.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveRoleProviders, kindsInUse } from '../../../server/ai/routing.js'

test('provider=local puts every role on-device', () => {
  const r = resolveRoleProviders({ provider: 'local', localAvailable: true })
  assert.deepEqual(r, { llm: 'local', embed: 'local', vision: 'local' })
})

test('provider=remote without a local provider puts every role remote (the lite image)', () => {
  const r = resolveRoleProviders({ provider: 'remote', localAvailable: false })
  assert.deepEqual(r, { llm: 'remote', embed: 'remote', vision: 'remote' })
})

test('provider=remote with a local provider keeps embedding on-device', () => {
  const r = resolveRoleProviders({ provider: 'remote', localAvailable: true })
  assert.deepEqual(r, { llm: 'remote', embed: 'local', vision: 'remote' })
})

test('STASH_AI_EMBED_PROVIDER=remote restores the all-remote behaviour', () => {
  const r = resolveRoleProviders({ provider: 'remote', embedProvider: 'remote', localAvailable: true })
  assert.deepEqual(r, { llm: 'remote', embed: 'remote', vision: 'remote' })
})

test('STASH_AI_EMBED_PROVIDER=local cannot conjure a provider that is not installed', () => {
  const r = resolveRoleProviders({ provider: 'remote', embedProvider: 'local', localAvailable: false })
  assert.equal(r.embed, 'remote')
})

test('an unrecognised STASH_AI_EMBED_PROVIDER value is ignored, not fatal', () => {
  const r = resolveRoleProviders({ provider: 'remote', embedProvider: 'banana', localAvailable: true })
  assert.equal(r.embed, 'local')
})

test('kindsInUse lists each provider once', () => {
  assert.deepEqual(kindsInUse({ llm: 'remote', embed: 'local', vision: 'remote' }).sort(), ['local', 'remote'])
  assert.deepEqual(kindsInUse({ llm: 'local', embed: 'local', vision: 'local' }), ['local'])
})
