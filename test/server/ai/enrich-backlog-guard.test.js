// queueBacklog must not enqueue work when the inference provider is
// unavailable. With ~1500 notes in the backlog and a metered remote endpoint,
// draining into an open circuit means 1500 failures and a real bill.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

test('queueBacklog enqueues nothing and reports 0 when the provider is unavailable', async () => {
  mock.module('../../../server/ai/index.js', {
    namedExports: {
      available: () => false,
      roleEnabled: () => true,
      capabilities: () => ({ kind: 'remote', managesResidency: false, downloadsWeights: false }),
      classify: async () => ({}),
      embedText: async () => [],
      describeImage: async () => '',
      answer: async () => '',
      isLikelyUrl: () => false,
      heuristicType: () => 'text',
      deriveTitle: () => '',
      extractUrl: () => null,
      FeatureDisabledError: class extends Error {},
    },
  })
  const enrich = await import('../../../server/ai/enrich.js')
  assert.equal(enrich.queueBacklog(), 0)
})
