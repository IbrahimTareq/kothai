// Local embeddings have to run one at a time per model.
//
// @qvac/sdk holds one job per model and rejects a second outright with "Cannot
// set new job: a job is already set or being processed". Saving one link
// (2026-10-05) fired seven embeds at once — tagvocab's canonicalize embeds
// every new tag with Promise.all, alongside the note's own embed — and six tag
// embeds plus the note's failed within ~10 ms, leaving the note unembedded.
import { test, mock, after, before } from 'node:test'
import assert from 'node:assert/strict'

let running = false

mock.module('@qvac/sdk', {
  namedExports: {
    loadModel: async () => 'model-1',
    unloadModel: async () => {},
    close: async () => {},
    cancel: async () => {},
    completion: () => ({ requestId: 'r', events: (async function* () {})(), final: Promise.resolve({}) }),
    // The SDK's single-job slot: a second embed while one is in flight rejects.
    embed: async () => {
      if (running) throw new Error('Cannot set new job: a job is already set or being processed')
      running = true
      await new Promise(r => setTimeout(r, 5))
      running = false
      return { embedding: [0.1] }
    },
    QWEN3_1_7B_INST_Q4: { name: 'llm', expectedSize: 1 },
    EMBEDDINGGEMMA_300M_Q8_0: { name: 'embed', expectedSize: 1 },
    QWEN3_5_2B_MULTIMODAL_Q4_K_M: { name: 'vision', expectedSize: 1 },
    MMPROJ_QWEN3_5_2B_MULTIMODAL_F16: { name: 'proj', expectedSize: 1 },
  },
})

const local = await import('../../../../server/ai/providers/local.ts')

// The provider keeps role managers alive; without this the process never exits.
after(async () => {
  await local.shutdown()
})
before(async () => {
  await local.init({ local: { embed: 'EMBEDDINGGEMMA_300M_Q8_0' } })
  await local.applyResidency({ llm: 'off', embed: 'ondemand', vision: 'off' })
})

test('concurrent embeds on one model all succeed', async () => {
  const texts = ['note', 'sqlite', 'database', 'sql', 'embedded', 'c', 'public-domain']
  const results = await Promise.allSettled(texts.map(t => local.embedText(t)))
  const failed = results.filter(r => r.status === 'rejected')
  assert.deepEqual(failed, [])
})
