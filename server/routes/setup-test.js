// POST /api/setup/test — "can you reach this endpoint with this key?"
//
// Server-side because the browser cannot: hosted providers send no CORS
// headers, so a fetch from the page fails in a way indistinguishable from a
// bad key. Probing here also exercises the exact path inference will use.
//
// A refused key is a RESULT, not a server error: it comes back 200 with
// ok:false, because the wizard needs to render it as a message beside the
// field rather than as a failure of the request.
import { getJson, TIMEOUTS } from '../ai/providers/remote-http.js'
import { json, readBody } from '../lib/http.js'

export async function handleSetupTest(req, res) {
  const body = await readBody(req)
  const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim().replace(/\/+$/, '') : ''
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
  if (!baseUrl) return json(res, 400, { error: 'baseUrl is required' })

  let parsed
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
    const models = (out?.data || []).map(m => m.id).filter(Boolean)
    return json(res, 200, { ok: true, models })
  } catch (e) {
    // e.message is already written for a person — remote-http.js turns a 404
    // into "check the model name", a 401 into an auth message, and so on.
    return json(res, 200, { ok: false, models: [], error: e.message || 'Could not reach that endpoint.' })
  }
}
