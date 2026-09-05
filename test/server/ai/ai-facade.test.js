// Unit tests for server/ai/index.js — provider selection and the guard that
// stops a sync accessor being called before a provider is resolved.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  _selectProvider,
  _reset,
  capabilities,
  initProvider,
  statusSnapshot,
  embedText,
  classify,
  roleEnabled,
  applyResidency,
  warmCache,
} from '../../../server/ai/index.js'

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

// ---- per-role dispatch ----------------------------------------------------
// A fake provider whose calls are recorded, so dispatch can be asserted
// without loading either real provider.
function fake(kind) {
  const calls = []
  return {
    calls,
    capabilities: () => ({ kind, managesResidency: kind === 'local', downloadsWeights: kind === 'local' }),
    roleEnabled: (role) => { calls.push(['roleEnabled', role]); return true },
    available: () => true,
    validateModel: (role, key) => { calls.push(['validateModel', role, key]); return { ok: true } },
    statusSnapshot: () => ({
      roles: {
        llm: { state: 'ready', progress: 100, message: '', model: kind },
        embed: { state: 'ready', progress: 100, message: '', model: kind },
        vision: { state: 'ready', progress: 100, message: '', model: kind },
      },
      aggregate: { state: 'ready', progress: 100, message: kind },
    }),
    listModels: async () => ({ llm: [{ key: kind }], embed: [{ key: kind }], vision: [{ key: kind }] }),
    applySettings: async (patch) => { calls.push(['applySettings', patch]) },
    init: async (cfg) => { calls.push(['init', cfg]) },
    classify: async () => { calls.push(['classify']); return kind },
    embedText: async () => { calls.push(['embedText']); return [kind] },
    describeImage: async () => { calls.push(['describeImage']); return kind },
    answer: async () => { calls.push(['answer']); return kind },
    shutdown: async () => { calls.push(['shutdown']) },
  }
}

test('mixed routing sends embedding to local and classification to remote', async () => {
  _reset()
  const local = fake('local')
  const remote = fake('remote')
  await initProvider('remote', { local: { embed: 'a' }, remote: { llm: 'b' } }, {
    load: (kind) => (kind === 'local' ? local : remote),
    embedProvider: null,
    localAvailable: true,
  })

  assert.deepEqual(await embedText('hi'), ['local'])
  assert.equal(await classify({ text: 'hi' }), 'remote')
  assert.equal(capabilities().kind, 'mixed')
  assert.deepEqual(capabilities().roles, { llm: 'remote', embed: 'local', vision: 'remote' })
})

test('both providers are initialised with the same { local, remote } settings object', async () => {
  _reset()
  const local = fake('local')
  const remote = fake('remote')
  const cfg = { local: { embed: 'a' }, remote: { llm: 'b' } }
  await initProvider('remote', cfg, { load: (k) => (k === 'local' ? local : remote), localAvailable: true })
  assert.deepEqual(local.calls[0], ['init', cfg])
  assert.deepEqual(remote.calls[0], ['init', cfg])
})

test('a lite image with no local provider stays entirely remote', async () => {
  _reset()
  const remote = fake('remote')
  await initProvider('remote', {}, { load: () => remote, localAvailable: false })
  assert.equal(capabilities().kind, 'remote')
  assert.deepEqual(await embedText('hi'), ['remote'])
})

test('roleEnabled asks the provider that owns the role', async () => {
  _reset()
  const local = fake('local')
  const remote = fake('remote')
  await initProvider('remote', {}, { load: (k) => (k === 'local' ? local : remote), localAvailable: true })
  roleEnabled('embed')
  roleEnabled('llm')
  assert.deepEqual(local.calls.filter((c) => c[0] === 'roleEnabled'), [['roleEnabled', 'embed']])
  assert.deepEqual(remote.calls.filter((c) => c[0] === 'roleEnabled'), [['roleEnabled', 'llm']])
})

test('statusSnapshot in mixed mode reports each role against its own provider', async () => {
  _reset()
  const local = fake('local')
  const remote = fake('remote')
  await initProvider('remote', {}, { load: (k) => (k === 'local' ? local : remote), localAvailable: true })
  const s = statusSnapshot()
  assert.equal(s.roles.embed.model, 'local')
  assert.equal(s.roles.llm.model, 'remote')
})

test('a mixed install never asks the local provider to hold a remotely-served role', async () => {
  _reset()
  const local = fake('local')
  const remote = fake('remote')
  local.applyResidency = async (r) => { local.calls.push(['applyResidency', r]) }
  local.warmCache = async (r) => { local.calls.push(['warmCache', r]) }
  await initProvider('remote', {}, { load: (k) => (k === 'local' ? local : remote), localAvailable: true })

  await applyResidency({ llm: 'always', embed: 'always', vision: 'ondemand' })
  await warmCache({ llm: 'always', embed: 'always', vision: 'ondemand' })

  assert.deepEqual(local.calls.find((c) => c[0] === 'applyResidency')[1], { llm: 'off', embed: 'always', vision: 'off' })
  assert.deepEqual(local.calls.find((c) => c[0] === 'warmCache')[1], { llm: 'off', embed: 'always', vision: 'off' })
})

test('a pure-local install passes the residency map through untouched', async () => {
  _reset()
  const local = fake('local')
  local.applyResidency = async (r) => { local.calls.push(['applyResidency', r]) }
  await initProvider('local', {}, { load: () => local, localAvailable: true })

  const residency = { llm: 'always', embed: 'always', vision: 'ondemand' }
  await applyResidency(residency)
  assert.deepEqual(local.calls.find((c) => c[0] === 'applyResidency')[1], residency)
})
