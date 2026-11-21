// A role stored as 'off' (first-run Skip) stays disabled even when its
// provider has an endpoint and a model — env-pinned endpoints and models are
// invisible to the remote provider's own check. See roleEnabled in ai/index.ts.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import type { Residency } from '../../../server/ai/roles.ts'
import { OFF_RESIDENCY } from '../../../server/ai/roles.ts'
import { loader, provider } from '../../helpers/providers.ts'

let stored: Residency = OFF_RESIDENCY
const realSettings = await import('../../../server/data/settings.ts')
mock.module('../../../server/data/settings.ts', {
  namedExports: { ...realSettings, getResidency: () => stored },
})

const { initProvider, roleEnabled, _reset } = await import('../../../server/ai/index.ts')
const { stepsFor } = await import('../../../server/ai/backlog.ts')

async function remoteWithEndpointAndModel() {
  _reset()
  const remote = provider({
    capabilities: () => ({ kind: 'remote', managesResidency: false, downloadsWeights: false }),
    roleEnabled: () => true,
  })
  await initProvider('remote', {}, { load: loader(() => remote), localAvailable: false })
}

test('a skipped install with an endpoint and a model has every role off and queues no steps', async () => {
  stored = OFF_RESIDENCY
  await remoteWithEndpointAndModel()
  for (const role of ['llm', 'embed', 'vision'] as const) assert.equal(roleEnabled(role), false, role)
  assert.deepEqual(stepsFor({ ai: {}, thumb: '/uploads/a.jpg' }, roleEnabled), [])
})

test('roles stored as always or ondemand stay enabled when the provider says so', async () => {
  stored = { llm: 'ondemand', embed: 'always', vision: 'ondemand' }
  await remoteWithEndpointAndModel()
  for (const role of ['llm', 'embed', 'vision'] as const) assert.equal(roleEnabled(role), true, role)
})
