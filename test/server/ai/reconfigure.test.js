// reconfigure() re-resolves which provider serves which role and re-boots the
// remote provider against whatever config now says. The local provider is
// deliberately left alone: re-initialising it would unload and reload model
// weights for a change that has nothing to do with them.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { initProvider, reconfigure, capabilities, _reset } from '../../../server/ai/index.ts'

function fakeProvider(kind, log) {
  return {
    init: async () => {
      log.push(`${kind}:init`)
    },
    capabilities: () => ({ kind, managesResidency: kind === 'local', downloadsWeights: kind === 'local' }),
    statusSnapshot: () => ({ roles: {}, aggregate: { state: 'ready', progress: 100, message: 'Ready' } }),
    applySettings: async () => {},
    shutdown: async () => {},
  }
}

beforeEach(() => _reset())

test('re-boots the remote provider so it picks up the new endpoint', async () => {
  const log = []
  const load = kind => Promise.resolve(fakeProvider(kind, log))
  await initProvider('remote', {}, { load, localAvailable: false })
  log.length = 0
  await reconfigure({}, { load, provider: 'remote', localAvailable: false })
  assert.deepEqual(log, ['remote:init'])
})

test('leaves an already-initialised local provider untouched', async () => {
  const log = []
  const load = kind => Promise.resolve(fakeProvider(kind, log))
  await initProvider('remote', {}, { load, localAvailable: true }) // mixed: embed stays local
  assert.equal(capabilities().kind, 'mixed')
  log.length = 0
  await reconfigure({}, { load, provider: 'remote', localAvailable: true })
  assert.ok(!log.includes('local:init'), 'weights must not be reloaded for an endpoint change')
})

test('initialises a provider kind that was not in use before', async () => {
  const log = []
  const load = kind => Promise.resolve(fakeProvider(kind, log))
  await initProvider('local', {}, { load, localAvailable: true })
  log.length = 0
  await reconfigure({}, { load, provider: 'remote', localAvailable: true })
  assert.ok(log.includes('remote:init'), 'the remote provider must be brought up')
  assert.equal(capabilities().roles.llm, 'remote')
})

test('a failure leaves the previous provider map live rather than half-built', async () => {
  const log = []
  const load = kind =>
    kind === 'remote' && log.includes('poisoned')
      ? Promise.reject(new Error('endpoint provider exploded'))
      : Promise.resolve(fakeProvider(kind, log))
  await initProvider('local', {}, { load, localAvailable: true })
  log.push('poisoned')
  await assert.rejects(() => reconfigure({}, { load, provider: 'remote', localAvailable: true }), /exploded/)
  assert.equal(capabilities().kind, 'local', 'the working map must survive a failed reconfigure')
})
