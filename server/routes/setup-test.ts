// POST /api/setup/test — "can you reach this endpoint with this key?"
//
// Server-side because the browser cannot: hosted providers send no CORS
// headers, so a fetch from the page fails in a way indistinguishable from a
// bad key. Probing here also exercises the exact path inference will use.
//
// A refused key is a RESULT, not a server error: it comes back 200 with
// ok:false, because the wizard needs to render it as a message beside the
// field rather than as a failure of the request.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { getJson, TIMEOUTS } from '../ai/providers/remote-http.ts'
import { json, readBody } from '../lib/http.ts'

// readBody and getJson both hand back `unknown` — the request body is whatever
// the wizard posted and the response is whatever the endpoint under test
// returned, which is the whole point of probing it.
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

export async function handleSetupTest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req)
  const fields = isRecord(body) ? body : {}
  const baseUrl = typeof fields.baseUrl === 'string' ? fields.baseUrl.trim().replace(/\/+$/, '') : ''
  const apiKey = typeof fields.apiKey === 'string' ? fields.apiKey.trim() : ''
  if (!baseUrl) return json(res, 400, { error: 'baseUrl is required' })

  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    return json(res, 400, { error: 'That does not look like a URL.' })
  }
  // An endpoint is an HTTP service. Anything else is a caller poking at a
  // scheme the fetch layer should never be handed.
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return json(res, 400, { error: 'An endpoint must be an http:// or https:// URL.' })
  }

  try {
    // No retries: someone is watching this button. A rate-limited endpoint is
    // a real answer here, not something to sit on for half a minute.
    const out = await getJson(baseUrl, '/models', { apiKey: apiKey || null, timeoutMs: TIMEOUTS.probe, retries: 0 })
    const rows = isRecord(out) && Array.isArray(out.data) ? out.data : []
    const models = rows.map(m => (isRecord(m) ? m.id : null)).filter(Boolean)
    return json(res, 200, { ok: true, models })
  } catch (e) {
    // e.message is already written for a person — remote-http.ts turns a 404
    // into "check the model name", a 401 into an auth message, and so on.
    const message = e instanceof Error ? e.message : ''
    return json(res, 200, { ok: false, models: [], error: message || 'Could not reach that endpoint.' })
  }
}
