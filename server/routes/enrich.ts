// The /api/enrich/* routes: the enrichment backlog, the library-wide re-tag,
// and the scrolling client's priority hint. Split out of routes/settings.ts —
// they act on the library through the enrichment queue, not on settings.
import type { IncomingMessage, ServerResponse } from 'node:http'
import * as ai from '../ai/index.ts'
import * as enrich from '../ai/enrich.ts'
import { backlogCount } from '../ai/backlog.ts'
import * as store from '../data/notes.ts'
import * as settings from '../data/settings.ts'
import { isInstagramPost } from '../links/instagram.ts'
import { json, readBody } from '../lib/http.ts'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

export function handleBacklog(res: ServerResponse): void {
  json(res, 200, { count: backlogCount(store.allNotes(), settings.getResidency()) })
}

// Both bulk-enrichment routes refuse the same way when there is no reachable
// provider, and the string is user-facing — two copies is two things to keep
// in step with each other and with the client that matches on the code.
const providerDown = (res: ServerResponse): void =>
  json(res, 503, {
    error: 'Inference endpoint is unavailable — check the connection and try again.',
    code: 'provider_unavailable',
  })

export function handleEnrichBacklog(res: ServerResponse) {
  if (!ai.available()) {
    return providerDown(res)
  }
  const queued = enrich.queueBacklog()
  json(res, 200, { ok: true, queued })
}

// Re-tag everything: re-run classify + embed across the whole library. Unlike
// the backlog above (which only fills in MISSING steps) this deliberately
// re-does work that already succeeded, because a note classified from its URL
// alone has a bad classification rather than a missing one. Hand-edited tags
// survive — see enrich.retagAll.
export async function handleRetagAll(res: ServerResponse): Promise<void> {
  if (!ai.available()) {
    return providerDown(res)
  }
  if (settings.getResidency().llm === 'off') {
    return json(res, 409, { error: 'Re-tagging needs the language model — enable it above.', code: 'llm_off' })
  }
  json(res, 200, { ok: true, queued: await enrich.retagAll() })
}

// Viewport-priority hint from the scrolling client: bump the visible,
// still-unfetched Instagram notes to the front of the meta queue.
export async function handlePrioritize(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req)
  const fields = isRecord(body) ? body : {}
  const ids: string[] = Array.isArray(fields.ids) ? fields.ids.filter(x => typeof x === 'string').slice(0, 200) : []
  const byId = new Map(store.allNotes().map(n => [n.id, n]))
  // The url is carried out of the lookup rather than looked up a second time
  // below, where the map answers `PublicNote | undefined` and there is nothing
  // honest to do with the undefined half.
  const eligible: { id: string; url: string }[] = []
  for (const id of ids) {
    const n = byId.get(id)
    if (n?.url && isInstagramPost(n.url) && !n.metaFetched) eligible.push({ id, url: n.url })
  }
  // ensure queued (a note might not be in the queue this boot), then promote
  for (const e of eligible) enrich.queueIgMeta(e.id, e.url)
  json(res, 200, { promoted: enrich.promoteIgMeta(eligible.map(e => e.id)) })
}
