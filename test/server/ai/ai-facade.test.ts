// Unit tests for server/ai/index.ts — provider selection and the guard that
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
} from '../../../server/ai/index.ts'
import type { Residency } from '../../../server/ai/roles.ts'
import type { ProviderKind } from '../../../server/ai/routing.ts'
import type { Provider } from '../../../server/ai/providers/types.ts'
import { loader, provider } from '../../helpers/providers.ts'

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
  await assert.rejects(() => _selectProvider('local', () => Promise.reject(boom)), /lite image/)
})

test('a genuine error inside the local provider is not disguised as a missing SDK', async () => {
  await assert.rejects(() => _selectProvider('local', () => Promise.reject(new Error('syntax error'))), /syntax error/)
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
//
// Every inference member answers something that names the provider that ran
// it, which is how "did this reach the right one?" is asserted at all. answer
// and describeImage return plain strings, so the kind IS the answer; the other
// two have shapes to respect, so the kind is carried in the one field of each
// that can hold it.
type Call = [string, ...unknown[]]

// embedText answers number[], so a provider's identity has to be a number.
const VECTOR: Record<ProviderKind, number[]> = { local: [1], remote: [2] }
// listModels answers ModelOption[], which is a Preset plus a resolved size.
const option = (kind: ProviderKind) => ({ key: kind, label: '', desc: '', best: [], sizeBytes: 0 })

// The arguments are all required on the contract and none of them steer a fake,
// so they are named once here rather than at every call below.
const CLASSIFY = { text: 'hi', hasImage: false, isUrl: false, now: '2026-01-01' }
const ASK = { question: 'hi', contextNotes: [] }

function fake(kind: ProviderKind): Provider & { calls: Call[] } {
  const calls: Call[] = []
  const p = provider({
    capabilities: () => ({ kind, managesResidency: kind === 'local', downloadsWeights: kind === 'local' }),
    roleEnabled: role => {
      calls.push(['roleEnabled', role])
      return true
    },
    available: () => true,
    validateModel: (role, key) => {
      calls.push(['validateModel', role, key])
      return { ok: true }
    },
    statusSnapshot: () => ({
      roles: {
        llm: { state: 'ready', progress: 100, message: '', model: kind },
        embed: { state: 'ready', progress: 100, message: '', model: kind },
        vision: { state: 'ready', progress: 100, message: '', model: kind },
      },
      aggregate: { state: 'ready', progress: 100, message: kind },
    }),
    listModels: async () => ({ llm: [option(kind)], embed: [option(kind)], vision: [option(kind)] }),
    applySettings: async patch => {
      calls.push(['applySettings', patch])
    },
    init: async cfg => {
      calls.push(['init', cfg])
    },
    classify: async () => {
      calls.push(['classify'])
      return { type: '', category: kind, title: '', summary: '', tags: [] }
    },
    embedText: async () => {
      calls.push(['embedText'])
      return VECTOR[kind]
    },
    describeImage: async () => {
      calls.push(['describeImage'])
      return kind
    },
    answer: async () => {
      calls.push(['answer'])
      return kind
    },
    shutdown: async () => {
      calls.push(['shutdown'])
    },
  })
  return Object.assign(p, { calls })
}

test('mixed routing sends embedding to local and classification to remote', async () => {
  _reset()
  const local = fake('local')
  const remote = fake('remote')
  await initProvider(
    'remote',
    { local: { embed: 'a' }, remote: { llm: 'b' } },
    {
      load: loader(kind => (kind === 'local' ? local : remote)),
      embedProvider: null,
      localAvailable: true,
    },
  )

  assert.deepEqual(await embedText('hi'), VECTOR.local)
  assert.equal((await classify(CLASSIFY)).category, 'remote')
  assert.equal(capabilities().kind, 'mixed')
  assert.deepEqual(capabilities().roles, { llm: 'remote', embed: 'local', vision: 'remote' })
})

test('both providers are initialised with the same { local, remote } settings object', async () => {
  _reset()
  const local = fake('local')
  const remote = fake('remote')
  const cfg = { local: { embed: 'a' }, remote: { llm: 'b' } }
  await initProvider('remote', cfg, { load: loader(k => (k === 'local' ? local : remote)), localAvailable: true })
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
  assert.deepEqual(await embedText('hi'), VECTOR.remote)
})

test('roleEnabled asks the provider that owns the role', async () => {
  _reset()
  const local = fake('local')
  const remote = fake('remote')
  await initProvider('remote', {}, { load: loader(k => (k === 'local' ? local : remote)), localAvailable: true })
  roleEnabled('embed')
  roleEnabled('llm')
  assert.deepEqual(
    local.calls.filter(c => c[0] === 'roleEnabled'),
    [['roleEnabled', 'embed']],
  )
  assert.deepEqual(
    remote.calls.filter(c => c[0] === 'roleEnabled'),
    [['roleEnabled', 'llm']],
  )
})

test('statusSnapshot in mixed mode reports each role against its own provider', async () => {
  _reset()
  const local = fake('local')
  const remote = fake('remote')
  await initProvider('remote', {}, { load: loader(k => (k === 'local' ? local : remote)), localAvailable: true })
  const s = statusSnapshot()
  assert.equal(s.roles.embed.model, 'local')
  assert.equal(s.roles.llm.model, 'remote')
})

test('a mixed install never asks the local provider to hold a remotely-served role', async () => {
  _reset()
  const local = fake('local')
  const remote = fake('remote')
  local.applyResidency = async r => {
    local.calls.push(['applyResidency', r])
  }
  local.warmCache = async r => {
    local.calls.push(['warmCache', r])
  }
  await initProvider('remote', {}, { load: loader(k => (k === 'local' ? local : remote)), localAvailable: true })

  await applyResidency({ llm: 'always', embed: 'always', vision: 'ondemand' })
  await warmCache({ llm: 'always', embed: 'always', vision: 'ondemand' })

  const applied = local.calls.find(c => c[0] === 'applyResidency')
  const warmed = local.calls.find(c => c[0] === 'warmCache')
  assert.ok(applied, 'the local provider must be handed a residency map')
  assert.ok(warmed, 'and a cache map')
  assert.deepEqual(applied[1], { llm: 'off', embed: 'always', vision: 'off' })
  assert.deepEqual(warmed[1], { llm: 'off', embed: 'always', vision: 'off' })
})

test('a pure-local install passes the residency map through untouched', async () => {
  _reset()
  const local = fake('local')
  local.applyResidency = async r => {
    local.calls.push(['applyResidency', r])
  }
  await initProvider('local', {}, { load: () => local, localAvailable: true })

  const residency: Residency = { llm: 'always', embed: 'always', vision: 'ondemand' }
  await applyResidency(residency)
  const applied = local.calls.find(c => c[0] === 'applyResidency')
  assert.ok(applied, 'the local provider must be handed a residency map')
  assert.deepEqual(applied[1], residency)
})

test('a mixed install does not claim the weights of a remotely-served role', async () => {
  _reset()
  const local = fake('local')
  const remote = fake('remote')
  local.weightsInUse = sel => {
    local.calls.push(['weightsInUse', sel])
    return {}
  }
  await initProvider('remote', {}, { load: loader(k => (k === 'local' ? local : remote)), localAvailable: true })

  weightsInUse({ llm: 'big-llm', embed: 'embeddinggemma-300m', vision: 'big-vision' })
  const asked = local.calls.find(c => c[0] === 'weightsInUse')
  assert.ok(asked, 'the local provider must be asked which weights it holds')
  assert.deepEqual(asked[1], { embed: 'embeddinggemma-300m' })
})

test('a model patch splits by owner, and a provider with nothing to do is not called', async () => {
  _reset()
  const local = fake('local')
  const remote = fake('remote')
  const mixed = { load: loader(k => (k === 'local' ? local : remote)), localAvailable: true }
  await initProvider('remote', {}, mixed)

  await applySettings({ llm: 'x', embed: 'y' })
  assert.deepEqual(
    local.calls.filter(c => c[0] === 'applySettings'),
    [['applySettings', { embed: 'y' }]],
  )
  assert.deepEqual(
    remote.calls.filter(c => c[0] === 'applySettings'),
    [['applySettings', { llm: 'x' }]],
  )

  // A patch touching only the locally-served role must not reach the endpoint
  // at all — an applySettings({}) there is a wasted round trip at best.
  await applySettings({ embed: 'z' })
  assert.equal(remote.calls.filter(c => c[0] === 'applySettings').length, 1)
})

test('a mixed install configures the local provider with only the roles it serves', async () => {
  _reset()
  const local = fake('local')
  const remote = fake('remote')
  local.configureModels = async p => {
    local.calls.push(['configureModels', p])
  }
  await initProvider('remote', {}, { load: loader(k => (k === 'local' ? local : remote)), localAvailable: true })

  await configureModels({ llm: 'big-llm', embed: 'embeddinggemma-300m', vision: 'big-vision' })
  const configured = local.calls.find(c => c[0] === 'configureModels')
  assert.ok(configured, 'the local provider must be handed the roles it serves')
  assert.deepEqual(configured[1], { embed: 'embeddinggemma-300m' })
})

test('every inference call reaches the provider that owns its role', async () => {
  _reset()
  const local = fake('local')
  const remote = fake('remote')
  await initProvider('remote', {}, { load: loader(k => (k === 'local' ? local : remote)), localAvailable: true })

  assert.equal(await answer(ASK), 'remote')
  assert.equal(await describeImage({ absPath: '/tmp/x.png' }), 'remote')
  assert.deepEqual(await embedText('hi'), VECTOR.local)
  assert.equal((await classify(CLASSIFY)).category, 'remote')

  // The local provider must have seen the embedding work and nothing else.
  assert.deepEqual(
    local.calls.map(c => c[0]).filter(n => n !== 'init'),
    ['embedText'],
  )
  assert.deepEqual(
    remote.calls.map(c => c[0]).filter(n => n !== 'init'),
    ['answer', 'describeImage', 'classify'],
  )
})

test('validateModel checks a key against the provider that will run it', async () => {
  _reset()
  const local = fake('local')
  const remote = fake('remote')
  await initProvider('remote', {}, { load: loader(k => (k === 'local' ? local : remote)), localAvailable: true })

  validateModel('embed', 'embeddinggemma-300m')
  validateModel('vision', 'gpt-4o-mini')
  assert.deepEqual(
    local.calls.filter(c => c[0] === 'validateModel'),
    [['validateModel', 'embed', 'embeddinggemma-300m']],
  )
  assert.deepEqual(
    remote.calls.filter(c => c[0] === 'validateModel'),
    [['validateModel', 'vision', 'gpt-4o-mini']],
  )
})

test('listModels in mixed mode offers each role the catalogue of its own provider', async () => {
  _reset()
  const local = fake('local')
  const remote = fake('remote')
  await initProvider('remote', {}, { load: loader(k => (k === 'local' ? local : remote)), localAvailable: true })

  const lists = await listModels()
  assert.deepEqual(
    lists.embed.map(o => o.key),
    ['local'],
  )
  assert.deepEqual(
    lists.llm.map(o => o.key),
    ['remote'],
  )
  assert.deepEqual(
    lists.vision.map(o => o.key),
    ['remote'],
  )
})

test('a missing @qvac/sdk means no on-device role, not a crash', async () => {
  const boom = Object.assign(new Error('Cannot find package @qvac/sdk'), { code: 'ERR_MODULE_NOT_FOUND' })
  assert.equal(await _localAvailable(() => Promise.reject(boom)), false)
})

test('a broken native binding degrades to all-remote instead of killing boot', async () => {
  // The operator on this host set KOTHAI_AI_PROVIDER=remote precisely to escape
  // on-device inference; refusing to boot because the escape route probed the
  // thing being escaped would be the worst possible answer.
  const boom = Object.assign(new Error('dlopen failed'), { code: 'ERR_DLOPEN_FAILED' })
  assert.equal(await _localAvailable(() => Promise.reject(boom)), false)
})

test('the on-device probe is skipped entirely when the embedding role is pinned remote', async () => {
  _reset()
  const remote = fake('remote')
  const loaded: ProviderKind[] = []
  await initProvider(
    'remote',
    {},
    {
      load: loader(k => {
        loaded.push(k)
        return remote
      }),
      embedProvider: 'remote',
    },
  )
  // No localAvailable was pinned, so a probe would have shown up as a 'local'
  // load — and on a host with a broken binding it would have thrown.
  assert.deepEqual(loaded, ['remote'])
  assert.equal(capabilities().kind, 'remote')
})

test('a provider that throws mid-init leaves nothing half-built for the retry to reuse', async () => {
  _reset()
  const local = fake('local')
  const remote = fake('remote')
  remote.init = async () => {
    throw new Error('endpoint unreachable')
  }
  const opts = { load: loader(k => (k === 'local' ? local : remote)), localAvailable: true }
  await assert.rejects(() => initProvider('remote', {}, opts), /endpoint unreachable/)

  // Not initialised, so the guard still fires rather than handing out the one
  // provider that happened to come up first.
  assert.throws(() => capabilities(), /not initialised/)

  remote.init = async cfg => {
    remote.calls.push(['init', cfg])
  }
  await initProvider('remote', {}, opts)
  assert.equal(capabilities().kind, 'mixed')
})

test('a weights call before init fails loudly rather than reporting an empty cache', async () => {
  _reset()
  // Silently returning {} here would tell the model-cache route that no file is
  // in use, and its DELETE would happily remove the running model's weights.
  assert.throws(() => weightsInUse({ llm: 'x' }), /not initialised/)
})

// The slice keeps any role whose value is not `undefined`, so an empty string
// is a real instruction — "this role has no model" — and it is forwarded.
// That is why a caller must pass the roles it actually means rather than the
// whole remote store: settings.getRemote() carries '' for every role the
// endpoint does not serve, and handing it over blanks the local provider's own
// model. It did, and first run on a mixed install stopped returning.
test('applySettings forwards an empty name, so callers must pass only the roles they mean', async () => {
  _reset()
  const local = fake('local')
  const remote = fake('remote')
  await initProvider('remote', {}, { load: loader(k => (k === 'local' ? local : remote)), localAvailable: true })

  // The shape of settings.getRemote() on a mixed install: llm named, and the
  // locally-served embed role blank.
  await applySettings({ llm: 'gpt-oss:120b', embed: '', vision: '' })
  const localCall = local.calls.find(c => c[0] === 'applySettings')
  assert.ok(localCall, 'the local provider must see the roles it serves')
  assert.deepEqual(localCall[1], { embed: '' }, 'the blank reaches the local provider')

  // Passing only the remote-owned roles leaves the local provider alone.
  local.calls.length = 0
  await applySettings({ llm: 'gpt-oss:120b' })
  assert.equal(
    local.calls.find(c => c[0] === 'applySettings'),
    undefined,
  )
})
