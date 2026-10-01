// The vision model has to load with reasoning switched off.
//
// Qwen3.5-VL reasons before it answers, and describeImage keeps only the
// answer (stripThinking). Measured on six real cover frames: 1,000-4,700
// characters generated for 145-530 kept, 9.6s a frame on average; with
// reasoning off, 1.85s and every character kept. The setting lives in the
// model's load config, so that is where this test reads it.
import { test, mock, before, after } from 'node:test'
import assert from 'node:assert/strict'

const loads: { name: string; modelConfig?: Record<string, unknown> }[] = []

mock.module('@qvac/sdk', {
  namedExports: {
    loadModel: async ({
      modelSrc,
      modelConfig,
    }: {
      modelSrc: { name: string }
      modelConfig?: Record<string, unknown>
    }) => {
      loads.push({ name: modelSrc.name, modelConfig })
      return `model-${modelSrc.name}`
    },
    unloadModel: async () => {},
    close: async () => {},
    cancel: async () => {},
    embed: async () => ({ embedding: [0.1] }),
    completion: () => ({
      requestId: 'r',
      events: (async function* () {})(),
      final: Promise.resolve({ contentText: 'a frame' }),
    }),
    QWEN3_1_7B_INST_Q4: { name: 'llm', expectedSize: 1 },
    EMBEDDINGGEMMA_300M_Q8_0: { name: 'embed', expectedSize: 1 },
    QWEN3_5_2B_MULTIMODAL_Q4_K_M: { name: 'vision', expectedSize: 1 },
    MMPROJ_QWEN3_5_2B_MULTIMODAL_F16: { name: 'proj', expectedSize: 1 },
  },
})

const local = await import('../../../../server/ai/providers/local.ts')

after(async () => {
  await local.shutdown()
})
before(async () => {
  await local.init({
    local: { llm: 'QWEN3_1_7B_INST_Q4', embed: 'EMBEDDINGGEMMA_300M_Q8_0', vision: 'QWEN3_5_2B_MULTIMODAL_Q4_K_M' },
  })
  await local.applyResidency({ llm: 'ondemand', embed: 'ondemand', vision: 'ondemand' })
})

test('the vision model loads with reasoning disabled', async () => {
  await local.describeImage({ absPath: '/tmp/frame.jpg', prompt: 'describe' })

  const vision = loads.find(l => l.name === 'vision')
  assert.ok(vision, 'describeImage loaded the vision model')
  assert.equal(vision.modelConfig?.reasoning_budget, 0)
})
