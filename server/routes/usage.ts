// GET /api/usage — where AI time and money went over the last `days` days
// (30 unless asked), grouped by step and by trigger, for Settings' usage
// panel. Rows are kept 90 days (ai/usage.ts), so that is the furthest back
// this can see. Not on the demo's allowlist: the demo's spend is its host's
// business, not a visitor's.
import type { ServerResponse } from 'node:http'
import { summariseUsage } from '../data/usage.ts'
import { json } from '../lib/http.ts'

const DAY_MS = 86_400_000

export async function handleUsage(res: ServerResponse, url: URL): Promise<void> {
  // Number(null) is 0, so an absent `days` falls back to 30 with the junk.
  const asked = Number(url.searchParams.get('days'))
  const days = Number.isFinite(asked) && asked >= 1 ? Math.min(Math.floor(asked), 90) : 30
  json(res, 200, { days, ...(await summariseUsage(Date.now() - days * DAY_MS)) })
}
