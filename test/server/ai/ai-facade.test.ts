// Unit tests for server/ai/index.ts — dispatch to the provider and the guard
// that stops a sync accessor being called before a provider is resolved.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  _reset,
  initProvider,
  statusSnapshot,
  embedText,
  classify,
  roleEnabled,
  applySettings,
  listModels,
  answer,
  describeImage,
  validateModel,
} from '../../../server/ai/index.ts'
import type { Provider } from '../../../server/ai/providers/types.ts'
import { provider } from '../../helpers/providers.ts'

test('a sync accessor before init fails loudly rather than returning undefined', () => {
  _reset()
  assert.throws(() => statusSnapshot(), /not initialised/)
})

// The remote provider with no endpoint reports every role off; the test
// fixture's default would say idle.
test('with no fake handed in, every role is served by the remote provider', async () => {
  _reset()
  await initProvider({})
  assert.equal(statusSnapshot().roles.llm.state, 'off')
})

test('initProvider is idempotent — a second call returns the same instance', async () => {
  _reset()
  const a = await initProvider({})
  const b = await initProvider({})
  assert.equal(a, b)
})

// ---- dispatch -------------------------------------------------------------
// A fake provider whose calls are recorded, so dispatch can be asserted
// without loading the real one.
type Call = [string, ...unknown[]]

const CLASSIFY = { text: 'hi', now: '2026-01-01' }
const ASK = { question: 'hi', contextNotes: [] }

function fake(): Provider & { calls: Call[] } {
  const calls: Call[] = []
  const p = provider({
    roleEnabled: role => {
      calls.push(['roleEnabled', role])
      return true
    },
    validateModel: (role, key) => {
      calls.push(['validateModel', role, key])
      return { ok: true }
    },
    statusSnapshot: () => ({
      roles: {
        llm: { state: 'ready', progress: 100, message: '', model: 'l' },
        embed: { state: 'ready', progress: 100, message: '', model: 'e' },
        vision: { state: 'ready', progress: 100, message: '', model: 'v' },
      },
      aggregate: { state: 'ready', progress: 100, message: '' },
    }),
    listModels: async () => ({ llm: [{ key: 'l', label: 'l' }], embed: [], vision: [] }),
    applySettings: async patch => {
      calls.push(['applySettings', patch])
    },
    init: async models => {
      calls.push(['init', models])
    },
    classify: async () => {
      calls.push(['classify'])
      return { type: 'link', category: 'c', title: '', summary: '', tags: [] }
    },
    embedText: async () => {
      calls.push(['embedText'])
      return [1]
    },
    describeImage: async () => {
      calls.push(['describeImage'])
      return 'd'
    },
    answer: async () => {
      calls.push(['answer'])
      return 'a'
    },
  })
  return Object.assign(p, { calls })
}

test('the provider is initialised with the stored model names', async () => {
  _reset()
  const p = fake()
  const models = { llm: 'gpt-4o-mini' }
  await initProvider(models, { load: () => p })
  assert.deepEqual(p.calls[0], ['init', models])
})

test('every call reaches the provider', async () => {
  _reset()
  const p = fake()
  await initProvider({}, { load: () => p })

  assert.equal(await answer(ASK), 'a')
  assert.equal(await describeImage({ absPath: '/tmp/x.png' }), 'd')
  assert.deepEqual(await embedText('hi'), [1])
  assert.equal((await classify(CLASSIFY)).category, 'c')
  assert.equal(roleEnabled('embed'), true)
  validateModel('vision', 'gpt-4.1-mini')
  await applySettings({ llm: 'x' })
  assert.equal(statusSnapshot().roles.embed.model, 'e')
  assert.deepEqual(
    (await listModels()).llm.map(o => o.key),
    ['l'],
  )

  assert.deepEqual(
    p.calls.filter(c => c[0] !== 'init'),
    [
      ['answer'],
      ['describeImage'],
      ['embedText'],
      ['classify'],
      ['roleEnabled', 'embed'],
      ['validateModel', 'vision', 'gpt-4.1-mini'],
      ['applySettings', { llm: 'x' }],
    ],
  )
})

test('a provider that throws mid-init leaves nothing half-built for the retry to reuse', async () => {
  _reset()
  const p = fake()
  p.init = async () => {
    throw new Error('endpoint unreachable')
  }
  await assert.rejects(() => initProvider({}, { load: () => p }), /endpoint unreachable/)

  // Not initialised, so the guard still fires rather than handing out a
  // provider that never came up.
  assert.throws(() => roleEnabled('llm'), /not initialised/)

  p.init = async () => {}
  await initProvider({}, { load: () => p })
  assert.equal(roleEnabled('llm'), true)
})

test('the facade exposes no local hooks', async () => {
  const ai = await import('../../../server/ai/index.ts')
  assert.equal('warmCache' in ai, false)
  assert.equal('applyResidency' in ai, false)
  assert.equal('localPresets' in ai, false)
})
