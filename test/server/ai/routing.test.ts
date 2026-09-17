// Unit tests for server/ai/routing.ts — which provider serves which role.
// Pure resolution, so every branch is testable without a provider, an
// endpoint or the SDK.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveRoleProviders, kindsInUse } from '../../../server/ai/routing.ts'
import type { ProviderStatus, RoleProviders } from '../../../server/ai/routing.ts'
import type { RoleStatus } from '../../../server/ai/roles.ts'

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

test('KOTHAI_AI_EMBED_PROVIDER=remote restores the all-remote behaviour', () => {
  const r = resolveRoleProviders({ provider: 'remote', embedProvider: 'remote', localAvailable: true })
  assert.deepEqual(r, { llm: 'remote', embed: 'remote', vision: 'remote' })
})

test('KOTHAI_AI_EMBED_PROVIDER=local cannot conjure a provider that is not installed', () => {
  const r = resolveRoleProviders({ provider: 'remote', embedProvider: 'local', localAvailable: false })
  assert.equal(r.embed, 'remote')
})

test('an unrecognised KOTHAI_AI_EMBED_PROVIDER value is ignored, not fatal', () => {
  const r = resolveRoleProviders({ provider: 'remote', embedProvider: 'banana', localAvailable: true })
  assert.equal(r.embed, 'local')
})

test('kindsInUse lists each provider once', () => {
  assert.deepEqual(kindsInUse({ llm: 'remote', embed: 'local', vision: 'remote' }).sort(), ['local', 'remote'])
  assert.deepEqual(kindsInUse({ llm: 'local', embed: 'local', vision: 'local' }), ['local'])
})

import { mergeStatus, mergeListModels, mergeCapabilities } from '../../../server/ai/routing.ts'

const ALL_LOCAL: RoleProviders = { llm: 'local', embed: 'local', vision: 'local' }
const MIXED: RoleProviders = { llm: 'remote', embed: 'local', vision: 'remote' }

const snap = (state: RoleStatus['state'], extra: Partial<RoleStatus> = {}): RoleStatus => ({
  state,
  progress: state === 'ready' ? 100 : 0,
  message: '',
  model: '',
  ...extra,
})

// Keyed by provider kind exactly as ai/index.js builds these maps — see
// routing.ts's ByKind.
const SNAPSHOTS: Record<string, ProviderStatus> = {
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
  const snapshots: Record<string, ProviderStatus> = {
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
  const snapshots: Record<string, ProviderStatus> = {
    ...SNAPSHOTS,
    local: {
      roles: {
        llm: snap('off'),
        embed: snap('loading', { progress: 42, message: 'Downloading' }),
        vision: snap('off'),
      },
      aggregate: { state: 'loading', progress: 42, message: 'Downloading' },
    },
  }
  const merged = mergeStatus(MIXED, snapshots)
  assert.equal(merged.aggregate.state, 'loading')
  assert.equal(merged.aggregate.progress, 42)
})

test('every role off in mixed mode is ready (AI-free), not an error', () => {
  const snapshots: Record<string, ProviderStatus> = {
    local: {
      roles: { llm: snap('off'), embed: snap('off'), vision: snap('off') },
      aggregate: { state: 'ready', progress: 100, message: '' },
    },
    remote: {
      roles: { llm: snap('off'), embed: snap('off'), vision: snap('off') },
      aggregate: { state: 'ready', progress: 100, message: '' },
    },
  }
  assert.equal(mergeStatus(MIXED, snapshots).aggregate.state, 'ready')
})

test('a fault outranks a download still in progress', () => {
  const snapshots: Record<string, ProviderStatus> = {
    local: {
      roles: { llm: snap('off'), embed: snap('loading', { progress: 10 }), vision: snap('off') },
      aggregate: { state: 'loading', progress: 10, message: 'Downloading' },
    },
    remote: {
      roles: { llm: snap('error', { message: 'endpoint down' }), embed: snap('error'), vision: snap('ready') },
      aggregate: { state: 'error', progress: 0, message: 'endpoint down' },
    },
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

// Naming an endpoint embedding model IS the opt-in. Before this, connecting
// OpenAI — which serves embeddings perfectly well — still made first run ask
// for a 300 MB local download, because the rule assumed no hosted endpoint
// could serve the role at all.
test('naming an endpoint embedding model sends the role there', () => {
  const r = resolveRoleProviders({
    provider: 'remote',
    localAvailable: true,
    remoteEmbedModel: 'text-embedding-3-small',
  })
  assert.equal(r.embed, 'remote')
})

test('no endpoint embedding model keeps the role on-device, exactly as before', () => {
  const r = resolveRoleProviders({ provider: 'remote', localAvailable: true, remoteEmbedModel: '' })
  assert.equal(r.embed, 'local')
})

// The env var is an operator override and must still beat the model name, in
// both directions — someone who pinned it did so for a reason.
test('KOTHAI_AI_EMBED_PROVIDER=local beats a named endpoint model', () => {
  const r = resolveRoleProviders({
    provider: 'remote',
    localAvailable: true,
    remoteEmbedModel: 'text-embedding-3-small',
    embedProvider: 'local',
  })
  assert.equal(r.embed, 'local')
})

test('KOTHAI_AI_EMBED_PROVIDER=remote still works with no model named yet', () => {
  const r = resolveRoleProviders({ provider: 'remote', localAvailable: true, embedProvider: 'remote' })
  assert.equal(r.embed, 'remote')
})

// An install that predates this carries no remote embed name, so it resolves
// exactly as it did before — no surprise re-index on upgrade.
test('an upgrade with no endpoint embedding model is unchanged', () => {
  const before = resolveRoleProviders({ provider: 'remote', localAvailable: true })
  assert.equal(before.embed, 'local')
})
