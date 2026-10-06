// Every on-device run is one usage row: server/ai/providers/qvac.ts.
import { test, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

let finalImpl: () => Promise<unknown> = async () => ({
  contentText: 'x',
  toolCalls: [],
  raw: { fullText: 'x' },
  stats: { promptTokens: 610, generatedTokens: 118, cacheTokens: 0 },
})

mock.module('@qvac/sdk', {
  namedExports: {
    loadModel: async () => 'model-1',
    unloadModel: async () => {},
    close: async () => {},
    cancel: async () => {},
    embed: async () => ({ embedding: [0.1], stats: { totalTokens: 9 } }),
    completion: () => ({ requestId: 'r', events: (async function* () {})(), final: finalImpl() }),
  },
})

const { _resetDb, getDb } = await import('../../../../server/data/db.ts')
const { startUsageLog, withStep } = await import('../../../../server/ai/usage.ts')
const qvac = await import('../../../../server/ai/providers/qvac.ts')

async function rows() {
  await new Promise(r => setImmediate(r))
  const db = await getDb()
  return db
    .prepare('SELECT step, provider, model, ok, input_tokens, output_tokens, cached_tokens FROM ai_usage')
    .all()
    .map(r => ({ ...r }))
}

beforeEach(async () => {
  _resetDb()
  await startUsageLog()
})

test("a finished run records the SDK's token stats", async () => {
  const run = withStep('classify', () => qvac.completion({ modelId: 'model-1', history: [], stream: false }))
  await run.final
  assert.deepEqual(await rows(), [
    {
      step: 'classify',
      provider: 'local',
      model: 'local',
      ok: 1,
      input_tokens: 610,
      output_tokens: 118,
      cached_tokens: 0,
    },
  ])
})

test('a cancelled run is a failed row, and the rejection still reaches the caller alone', async () => {
  finalImpl = async () => {
    throw new Error('cancelled')
  }
  const run = qvac.completion({ modelId: 'model-1', history: [], stream: false })
  await assert.rejects(run.final, /cancelled/)
  const [r] = await rows()
  assert.equal(r.ok, 0)
  assert.equal(r.input_tokens, null)
})

test('an embedding is recorded with the token count the SDK reports', async () => {
  const out = await withStep('embed', () => qvac.embed({ modelId: 'e', text: 'hi' }))
  assert.deepEqual(out.embedding, [0.1])
  const [r] = await rows()
  assert.equal(r.step, 'embed')
  assert.equal(r.input_tokens, 9)
})
