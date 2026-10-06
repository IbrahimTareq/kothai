// Each facade method labels its calls with their step (server/ai/index.ts),
// and tag matching keeps its own label through the facade (tagvocab.ts).
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { _resetDb, getDb } from '../../../server/data/db.ts'
import { startUsageLog, recordUsage } from '../../../server/ai/usage.ts'
import {
  _reset,
  initProvider,
  classify,
  embedText,
  describeImage,
  answer,
  answerStream,
} from '../../../server/ai/index.ts'
import * as tagvocab from '../../../server/data/tagvocab.ts'
import { loader, provider } from '../../helpers/providers.ts'

const CALL = {
  provider: 'remote' as const,
  model: 'm',
  ok: true,
  status: 200,
  inputTokens: null,
  outputTokens: null,
  cachedTokens: null,
  reasoningTokens: null,
  costUsd: null,
  ms: 1,
}
// A provider whose every call records a row, the way the real ones do on
// the wire. The step on the row is whatever the facade wrapped the call in.
const recording = provider({
  capabilities: () => ({ kind: 'remote', managesResidency: false, downloadsWeights: false }),
  available: () => true,
  roleEnabled: () => true,
  classify: async () => {
    await recordUsage(CALL)
    return { type: 'link', category: 'C', title: 'T', summary: 'S', tags: [] }
  },
  embedText: async () => {
    await recordUsage(CALL)
    return [1, 0]
  },
  describeImage: async () => {
    await recordUsage(CALL)
    return 'a frame'
  },
  answer: async () => {
    await recordUsage(CALL)
    return 'an answer'
  },
})

async function steps() {
  const db = await getDb()
  return db
    .prepare('SELECT step FROM ai_usage ORDER BY id')
    .all()
    .map(r => r.step)
}

beforeEach(async () => {
  _resetDb()
  await startUsageLog()
  _reset()
  await initProvider('remote', {}, { load: loader(() => recording), localAvailable: false })
})

test('each facade method records under its own step', async () => {
  await classify({ text: 'x', now: 'now' })
  await embedText('x')
  await describeImage({ absPath: '/tmp/x.jpg' })
  await answer({ question: 'q', contextNotes: [] })
  await answerStream({ question: 'q', contextNotes: [] })
  assert.deepEqual(await steps(), ['classify', 'embed', 'vision', 'answer', 'answer'])
})

test("tag matching's embeds are tag-embed, not plain embed", async () => {
  await tagvocab.canonicalize(['brand-new-tag'])
  assert.deepEqual(await steps(), ['tag-embed'])
})
