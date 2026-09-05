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

import { mergeStatus, mergeListModels, mergeCapabilities } from '../../../server/ai/routing.js'

const ALL_LOCAL = { llm: 'local', embed: 'local', vision: 'local' }
const MIXED = { llm: 'remote', embed: 'local', vision: 'remote' }

const snap = (state, extra = {}) => ({ state, progress: state === 'ready' ? 100 : 0, message: '', model: '', ...extra })

const SNAPSHOTS = {
  local: {
    roles: { llm: snap('off'), embed: snap('ready'), vision: snap('off') },
    aggregate: { state: 'ready', progress: 100, message: 'Local ready' },
  },
  remote: {
    roles: { llm: snap('ready'), embed: snap('ready'), vision: snap('ready') },
    aggregate: { state: 'ready', progress: 100, message: 'Remote ready' },
  },
}

test('one kind in use returns that provider snapshot untouched', () => {
  assert.equal(mergeStatus(ALL_LOCAL, SNAPSHOTS), SNAPSHOTS.local)
})

test('mixed mode takes each role from the provider that owns it', () => {
  const merged = mergeStatus(MIXED, SNAPSHOTS)
  assert.equal(merged.roles.embed, SNAPSHOTS.local.roles.embed)
  assert.equal(merged.roles.llm, SNAPSHOTS.remote.roles.llm)
  assert.equal(merged.aggregate.state, 'ready')
})

test('a failing remote endpoint makes the mixed aggregate an error', () => {
  const snapshots = {
    ...SNAPSHOTS,
    remote: {
      roles: { llm: snap('error', { message: 'endpoint down' }), embed: snap('error'), vision: snap('error') },
      aggregate: { state: 'error', progress: 0, message: 'endpoint down' },
    },
  }
  const merged = mergeStatus(MIXED, snapshots)
  assert.equal(merged.aggregate.state, 'error')
  assert.equal(merged.aggregate.message, 'endpoint down')
})

test('a downloading local model makes the mixed aggregate loading, and carries its progress', () => {
  const snapshots = {
    ...SNAPSHOTS,
    local: {
      roles: { llm: snap('off'), embed: snap('loading', { progress: 42, message: 'Downloading' }), vision: snap('off') },
      aggregate: { state: 'loading', progress: 42, message: 'Downloading' },
    },
  }
  const merged = mergeStatus(MIXED, snapshots)
  assert.equal(merged.aggregate.state, 'loading')
  assert.equal(merged.aggregate.progress, 42)
})

test('every role off in mixed mode is ready (AI-free), not an error', () => {
  const snapshots = {
    local: { roles: { llm: snap('off'), embed: snap('off'), vision: snap('off') }, aggregate: { state: 'ready', progress: 100, message: '' } },
    remote: { roles: { llm: snap('off'), embed: snap('off'), vision: snap('off') }, aggregate: { state: 'ready', progress: 100, message: '' } },
  }
  assert.equal(mergeStatus(MIXED, snapshots).aggregate.state, 'ready')
})

test('a fault outranks a download still in progress', () => {
  const snapshots = {
    local: { roles: { llm: snap('off'), embed: snap('loading', { progress: 10 }), vision: snap('off') }, aggregate: { state: 'loading', progress: 10, message: 'Downloading' } },
    remote: { roles: { llm: snap('error', { message: 'endpoint down' }), embed: snap('error'), vision: snap('ready') }, aggregate: { state: 'error', progress: 0, message: 'endpoint down' } },
  }
  assert.equal(mergeStatus(MIXED, snapshots).aggregate.state, 'error')
})

test('one kind in use returns the provider list untouched', () => {
  const lists = { local: { llm: [], embed: [], vision: [] } }
  assert.equal(mergeListModels(ALL_LOCAL, lists), lists.local)
})

test('mergeListModels offers each role the catalogue of its own provider', () => {
  const lists = {
    local: { llm: [{ key: 'local-llm' }], embed: [{ key: 'embeddinggemma-300m' }], vision: [{ key: 'local-vision' }] },
    remote: { llm: [{ key: 'gpt-oss:120b' }], embed: [{ key: 'gpt-oss:120b' }], vision: [{ key: 'gpt-oss:120b' }] },
  }
  const merged = mergeListModels(MIXED, lists)
  assert.deepEqual(merged.embed, [{ key: 'embeddinggemma-300m' }])
  assert.deepEqual(merged.llm, [{ key: 'gpt-oss:120b' }])
})

test('mergeCapabilities reports mixed, and always names the owner of each role', () => {
  const caps = {
    local: { kind: 'local', managesResidency: true, downloadsWeights: true },
    remote: { kind: 'remote', managesResidency: false, downloadsWeights: false },
  }
  const single = mergeCapabilities(ALL_LOCAL, caps)
  assert.equal(single.kind, 'local')
  assert.deepEqual(single.roles, ALL_LOCAL)

  const mixed = mergeCapabilities(MIXED, caps)
  assert.equal(mixed.kind, 'mixed')
  assert.equal(mixed.managesResidency, true)
  assert.equal(mixed.downloadsWeights, true)
  assert.deepEqual(mixed.roles, MIXED)
})
