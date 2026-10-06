// The ai_usage table: one row per model call attempt, for Settings' usage
// panel. Storage only — what to record and how a call is labelled live in
// server/ai/usage.ts, so this module never reaches into server/ai/.
import type { SQLOutputValue } from 'node:sqlite'
import { getDb } from './db.ts'

export interface UsageRow {
  at: number
  step: string
  trigger: string
  provider: 'local' | 'remote'
  model: string
  ok: boolean
  status: number | null
  inputTokens: number | null
  outputTokens: number | null
  cachedTokens: number | null
  reasoningTokens: number | null
  costUsd: number | null
  ms: number
}

export interface UsageGroup {
  key: string
  calls: number
  failed: number
  inputTokens: number | null
  outputTokens: number | null
  cachedTokens: number | null
  reasoningTokens: number | null
  costUsd: number | null
  costUnknownCalls: number
  ms: number
}

export async function insertUsage(r: UsageRow): Promise<void> {
  const db = await getDb()
  db.prepare(
    `INSERT INTO ai_usage (at, step, triggered_by, provider, model, ok, status, input_tokens, output_tokens,
      cached_tokens, reasoning_tokens, cost_usd, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    r.at,
    r.step,
    r.trigger,
    r.provider,
    r.model,
    r.ok ? 1 : 0,
    r.status,
    r.inputTokens,
    r.outputTokens,
    r.cachedTokens,
    r.reasoningTokens,
    r.costUsd,
    Math.round(r.ms),
  )
}

// SQLite's SUM over values that are all NULL is NULL, which is exactly "not
// reported". It is kept as null rather than read as 0, so a provider that
// sends no usage block never makes the panel's totals look complete.
// cost_unknown counts successful remote calls that carried no price: the
// panel shows those next to the summed cost instead of passing the sum off as
// the whole bill.
const AGGREGATES = `COUNT(*) AS calls, SUM(1 - ok) AS failed,
  SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
  SUM(cached_tokens) AS cached_tokens, SUM(reasoning_tokens) AS reasoning_tokens,
  SUM(cost_usd) AS cost_usd,
  SUM(CASE WHEN provider = 'remote' AND ok = 1 AND cost_usd IS NULL THEN 1 ELSE 0 END) AS cost_unknown,
  SUM(ms) AS ms`

const count = (v: SQLOutputValue | undefined): number => (typeof v === 'number' ? v : 0)
const sum = (v: SQLOutputValue | undefined): number | null => (typeof v === 'number' ? v : null)

function group(key: string, r: Record<string, SQLOutputValue> | undefined): UsageGroup {
  return {
    key,
    calls: count(r?.calls),
    failed: count(r?.failed),
    inputTokens: sum(r?.input_tokens),
    outputTokens: sum(r?.output_tokens),
    cachedTokens: sum(r?.cached_tokens),
    reasoningTokens: sum(r?.reasoning_tokens),
    costUsd: sum(r?.cost_usd),
    costUnknownCalls: count(r?.cost_unknown),
    ms: count(r?.ms),
  }
}

export async function summariseUsage(sinceMs: number) {
  const db = await getDb()
  const by = (column: 'step' | 'triggered_by') =>
    db
      .prepare(`SELECT ${column} AS key, ${AGGREGATES} FROM ai_usage WHERE at >= ? GROUP BY ${column} ORDER BY ms DESC`)
      .all(sinceMs)
      .map(r => group(String(r.key), r))
  return {
    totals: group('all', db.prepare(`SELECT ${AGGREGATES} FROM ai_usage WHERE at >= ?`).get(sinceMs)),
    byStep: by('step'),
    byTrigger: by('triggered_by'),
  }
}

export async function pruneUsage(beforeMs: number): Promise<void> {
  const db = await getDb()
  db.prepare('DELETE FROM ai_usage WHERE at < ?').run(beforeMs)
}
