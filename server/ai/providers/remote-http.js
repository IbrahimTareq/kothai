// HTTP transport for the remote inference provider.
//
// Split from remote.js so the error taxonomy can be tested against a real
// throwaway server without pulling in model config or the circuit breaker.
//
// Every failure is classified transient or not. Transient failures (network,
// 5xx, 429) are worth retrying; non-transient ones (bad key, unknown model)
// are config errors that retrying cannot fix, and each retry against a
// metered endpoint costs money — so they open the circuit immediately.

export class RemoteError extends Error {
  constructor(code, message, { transient = true, retryAfterMs = 0, status = 0 } = {}) {
    super(message)
    this.code = code
    this.transient = transient
    this.retryAfterMs = retryAfterMs
    this.status = status
  }
}

function classify(status, body) {
  const detail = typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body).slice(0, 200)
  if (status === 401 || status === 403) {
    return new RemoteError('auth_failed', `Endpoint rejected the credentials (${status}). Check STASH_AI_API_KEY.`, {
      transient: false,
      status,
    })
  }
  if (status === 404) {
    return new RemoteError(
      'model_not_found',
      `Endpoint returned 404 — check the model name and STASH_AI_BASE_URL. ${detail}`,
      { transient: false, status },
    )
  }
  if (status === 400) {
    return new RemoteError('bad_request', `Endpoint rejected the request (400). ${detail}`, {
      transient: false,
      status,
    })
  }
  if (status === 429) {
    return new RemoteError('rate_limited', 'Endpoint rate-limited the request.', { transient: true, status })
  }
  return new RemoteError('endpoint_error', `Endpoint returned ${status}. ${detail}`, { transient: true, status })
}

// Default budgets differ per call: an embedding should be quick, an answer
// over a dozen notes legitimately is not. Local inference is in-process and
// unbounded, so this is a concern only remote has.
export const TIMEOUTS = { embed: 15_000, classify: 60_000, answer: 120_000, vision: 120_000, probe: 5_000 }

// Retry policy for the transient failures — 429 and 5xx.
//
// RETRIES is small on purpose. The point is to ride out a burst, not to keep
// a metered account busy: an endpoint that is still refusing after three tries
// is rate-limiting by the hour or the day, and the honest answer there is to
// fail, let the note keep its heuristics, and leave it in the backlog.
//
// MAX_WAIT_MS caps whatever the endpoint asks for. Providers do return
// Retry-After values in the thousands of seconds, and honouring one literally
// would park the whole enrichment chain — which is strictly serial — for the
// rest of the afternoon.
const RETRIES = 3
const MAX_WAIT_MS = 30_000
const BACKOFF_MS = [1_000, 4_000, 10_000]

const realSleep = ms => new Promise(r => setTimeout(r, ms))

// How long before the next attempt: what the endpoint asked for if it said,
// our own backoff if it did not, capped either way. Jitter keeps several
// callers coming back at slightly different moments rather than in lockstep.
function waitFor(err, attempt) {
  const asked = err.retryAfterMs > 0 ? err.retryAfterMs : BACKOFF_MS[attempt] + Math.random() * 250
  return Math.min(Math.round(asked), MAX_WAIT_MS)
}

const retryable = err => err instanceof RemoteError && err.transient && err.code !== 'bad_response'

export async function postJson(
  baseUrl,
  path,
  body,
  { apiKey = null, timeoutMs = 60_000, retries = RETRIES, sleep = realSleep } = {},
) {
  return withRetry(
    () => request(baseUrl, path, { method: 'POST', body: JSON.stringify(body), apiKey, timeoutMs }),
    retries,
    sleep,
  )
}

export async function getJson(
  baseUrl,
  path,
  { apiKey = null, timeoutMs = 60_000, retries = RETRIES, sleep = realSleep } = {},
) {
  return withRetry(() => request(baseUrl, path, { method: 'GET', apiKey, timeoutMs }), retries, sleep)
}

async function withRetry(attemptFn, retries, sleep) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await attemptFn()
    } catch (err) {
      // Config errors (bad key, unknown model) are never retried: no number of
      // attempts fixes them, and each one against a metered endpoint costs.
      if (attempt >= retries || !retryable(err)) throw err
      await sleep(waitFor(err, attempt))
    }
  }
}

async function request(baseUrl, path, { method, body, apiKey, timeoutMs }) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  let res
  try {
    res = await fetch(baseUrl + path, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body,
      signal: ac.signal,
    })
  } catch (e) {
    // AbortError and every DNS/connect failure land here identically — from
    // the caller's point of view "the endpoint did not answer" is one state.
    throw new RemoteError('endpoint_unreachable', `Could not reach ${baseUrl}: ${e.message}`, { transient: true })
  } finally {
    clearTimeout(timer)
  }

  const text = await res.text().catch(() => '')
  if (!res.ok) {
    const err = classify(res.status, text)
    if (res.status === 429) {
      const secs = Number(res.headers.get('retry-after'))
      if (Number.isFinite(secs) && secs > 0) err.retryAfterMs = secs * 1000
    }
    throw err
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new RemoteError('bad_response', `Endpoint returned non-JSON: ${text.slice(0, 200)}`, { transient: true })
  }
}
