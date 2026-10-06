// The work each entry point sets off is recorded under its trigger.
// HTTP-triggered work is labelled where routes are registered (router.ts);
// a save, outage recovery and re-embedding label themselves.
import { test, mock, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'

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

const { recordUsage, startUsageLog } = await import('../../../server/ai/usage.ts')
// Each mocked handler records one row and answers, as the real handler's
// queued model work would.
const recorded = async (res: import('node:http').ServerResponse) => {
  await recordUsage(CALL)
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end('{}')
}

const realAsk = await import('../../../server/routes/ask.ts')
mock.module('../../../server/routes/ask.ts', {
  namedExports: { ...realAsk, handleAsk: (_req: unknown, res: import('node:http').ServerResponse) => recorded(res) },
})
const realImport = await import('../../../server/routes/import.ts')
mock.module('../../../server/routes/import.ts', {
  namedExports: {
    ...realImport,
    handleImport: (_req: unknown, res: import('node:http').ServerResponse) => recorded(res),
  },
})
const realEnrich = await import('../../../server/routes/enrich.ts')
mock.module('../../../server/routes/enrich.ts', {
  namedExports: {
    ...realEnrich,
    handleEnrichBacklog: (res: import('node:http').ServerResponse) => recorded(res),
    handleRetagAll: (res: import('node:http').ServerResponse) => recorded(res),
  },
})
const realNotes = await import('../../../server/routes/notes.ts')
mock.module('../../../server/routes/notes.ts', {
  namedExports: {
    ...realNotes,
    handleRetagNote: (res: import('node:http').ServerResponse) => recorded(res),
    handleUpdateNote: (_req: unknown, res: import('node:http').ServerResponse) => recorded(res),
  },
})

const { _resetDb, getDb } = await import('../../../server/data/db.ts')
const { createServer } = await import('../../../server/router.ts')
const { listenOnLoopback } = await import('../../helpers/http.ts')
const server = createServer()
const BASE = `http://127.0.0.1:${await listenOnLoopback(server)}`
after(() => server.close())

async function lastTrigger() {
  const db = await getDb()
  const row = db.prepare('SELECT triggered_by FROM ai_usage ORDER BY id DESC LIMIT 1').get()
  return row?.triggered_by
}

beforeEach(async () => {
  _resetDb()
  await startUsageLog()
})

for (const [method, path, trigger] of [
  ['POST', '/api/ask', 'ask'],
  ['POST', '/api/import', 'import'],
  ['POST', '/api/enrich/backlog', 'backlog'],
  ['POST', '/api/enrich/retag-all', 'retag-all'],
  ['POST', '/api/notes/n1/retag', 'retag'],
  ['PATCH', '/api/notes/n1', 'tag-edit'],
] as const) {
  test(`${method} ${path} is recorded as ${trigger}`, async () => {
    await fetch(BASE + path, { method, body: '{}', headers: { 'content-type': 'application/json' } })
    assert.equal(await lastTrigger(), trigger)
  })
}
