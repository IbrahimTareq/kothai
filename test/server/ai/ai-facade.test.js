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
  weightsInUse,
  configureModels,
  applySettings,
  listModels,
  answer,
  describeImage,
  validateModel,
  _localAvailable,
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
  // Identity, not deep equality: a structural clone would satisfy deepEqual
  // while breaking the property that matters — both providers destructure
  // their own half of the one object the caller resolved.
  assert.equal(local.calls[0][0], 'init')
  assert.equal(local.calls[0][1], cfg)
  assert.equal(remote.calls[0][0], 'init')
  assert.equal(remote.calls[0][1], cfg)
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

test('a mixed install does not claim the weights of a remotely-served role', async () => {
  _reset()
  const local = fake('local')
  const remote = fake('remote')
  local.weightsInUse = (sel) => { local.calls.push(['weightsInUse', sel]); return {} }
  await initProvider('remote', {}, { load: (k) => (k === 'local' ? local : remote), localAvailable: true })

  weightsInUse({ llm: 'big-llm', embed: 'embeddinggemma-300m', vision: 'big-vision' })
  assert.deepEqual(local.calls.find((c) => c[0] === 'weightsInUse')[1], { embed: 'embeddinggemma-300m' })
})

test('a model patch splits by owner, and a provider with nothing to do is not called', async () => {
  _reset()
  const local = fake('local')
  const remote = fake('remote')
  const mixed = { load: (k) => (k === 'local' ? local : remote), localAvailable: true }
  await initProvider('remote', {}, mixed)

  await applySettings({ llm: 'x', embed: 'y' })
  assert.deepEqual(local.calls.filter((c) => c[0] === 'applySettings'), [['applySettings', { embed: 'y' }]])
  assert.deepEqual(remote.calls.filter((c) => c[0] === 'applySettings'), [['applySettings', { llm: 'x' }]])

  // A patch touching only the locally-served role must not reach the endpoint
  // at all — an applySettings({}) there is a wasted round trip at best.
  await applySettings({ embed: 'z' })
  assert.equal(remote.calls.filter((c) => c[0] === 'applySettings').length, 1)
})

test('a mixed install configures the local provider with only the roles it serves', async () => {
  _reset()
  const local = fake('local')
  const remote = fake('remote')
  local.configureModels = async (p) => { local.calls.push(['configureModels', p]) }
  await initProvider('remote', {}, { load: (k) => (k === 'local' ? local : remote), localAvailable: true })

  await configureModels({ llm: 'big-llm', embed: 'embeddinggemma-300m', vision: 'big-vision' })
  assert.deepEqual(local.calls.find((c) => c[0] === 'configureModels')[1], { embed: 'embeddinggemma-300m' })
})

test('every inference call reaches the provider that owns its role', async () => {
  _reset()
  const local = fake('local')
  const remote = fake('remote')
  await initProvider('remote', {}, { load: (k) => (k === 'local' ? local : remote), localAvailable: true })

  assert.equal(await answer({ question: 'hi' }), 'remote')
  assert.equal(await describeImage({}), 'remote')
  assert.deepEqual(await embedText('hi'), ['local'])
  assert.equal(await classify({ text: 'hi' }), 'remote')

  // The local provider must have seen the embedding work and nothing else.
  assert.deepEqual(local.calls.map((c) => c[0]).filter((n) => n !== 'init'), ['embedText'])
  assert.deepEqual(remote.calls.map((c) => c[0]).filter((n) => n !== 'init'), ['answer', 'describeImage', 'classify'])
})

test('validateModel checks a key against the provider that will run it', async () => {
  _reset()
  const local = fake('local')
  const remote = fake('remote')
  await initProvider('remote', {}, { load: (k) => (k === 'local' ? local : remote), localAvailable: true })

  validateModel('embed', 'embeddinggemma-300m')
  validateModel('vision', 'gpt-4o-mini')
  assert.deepEqual(local.calls.filter((c) => c[0] === 'validateModel'), [['validateModel', 'embed', 'embeddinggemma-300m']])
  assert.deepEqual(remote.calls.filter((c) => c[0] === 'validateModel'), [['validateModel', 'vision', 'gpt-4o-mini']])
})

test('listModels in mixed mode offers each role the catalogue of its own provider', async () => {
  _reset()
  const local = fake('local')
  const remote = fake('remote')
  await initProvider('remote', {}, { load: (k) => (k === 'local' ? local : remote), localAvailable: true })

  const lists = await listModels()
  assert.deepEqual(lists.embed, [{ key: 'local' }])
  assert.deepEqual(lists.llm, [{ key: 'remote' }])
  assert.deepEqual(lists.vision, [{ key: 'remote' }])
})

test('a missing @qvac/sdk means no on-device role, not a crash', async () => {
  const boom = Object.assign(new Error('Cannot find package @qvac/sdk'), { code: 'ERR_MODULE_NOT_FOUND' })
  assert.equal(await _localAvailable(() => Promise.reject(boom)), false)
})

test('a broken native binding degrades to all-remote instead of killing boot', async () => {
  // The operator on this host set STASH_AI_PROVIDER=remote precisely to escape
  // on-device inference; refusing to boot because the escape route probed the
  // thing being escaped would be the worst possible answer.
  const boom = Object.assign(new Error('dlopen failed'), { code: 'ERR_DLOPEN_FAILED' })
  assert.equal(await _localAvailable(() => Promise.reject(boom)), false)
})

test('the on-device probe is skipped entirely when the embedding role is pinned remote', async () => {
  _reset()
  const remote = fake('remote')
  const loaded = []
  await initProvider('remote', {}, {
    load: (k) => { loaded.push(k); return remote },
    embedProvider: 'remote',
  })
  // No localAvailable was pinned, so a probe would have shown up as a 'local'
  // load — and on a host with a broken binding it would have thrown.
  assert.deepEqual(loaded, ['remote'])
  assert.equal(capabilities().kind, 'remote')
})

test('a provider that throws mid-init leaves nothing half-built for the retry to reuse', async () => {
  _reset()
  const local = fake('local')
  const remote = fake('remote')
  remote.init = async () => { throw new Error('endpoint unreachable') }
  const opts = { load: (k) => (k === 'local' ? local : remote), localAvailable: true }
  await assert.rejects(() => initProvider('remote', {}, opts), /endpoint unreachable/)

  // Not initialised, so the guard still fires rather than handing out the one
  // provider that happened to come up first.
  assert.throws(() => capabilities(), /not initialised/)

  remote.init = async (cfg) => { remote.calls.push(['init', cfg]) }
  await initProvider('remote', {}, opts)
  assert.equal(capabilities().kind, 'mixed')
})

test('a weights call before init fails loudly rather than reporting an empty cache', async () => {
  _reset()
  // Silently returning {} here would tell the model-cache route that no file is
  // in use, and its DELETE would happily remove the running model's weights.
  assert.throws(() => weightsInUse({ llm: 'x' }), /not initialised/)
})
