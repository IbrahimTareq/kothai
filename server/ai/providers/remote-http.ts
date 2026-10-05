// HTTP transport for the remote inference provider.
//
// Split from remote.ts so the error taxonomy can be tested against a real
// throwaway server without pulling in model config or the circuit breaker.
//
// Every failure is classified transient or not. Transient failures (network,
// 5xx, 429) are worth retrying; non-transient ones (bad key, unknown model)
// are config errors that retrying cannot fix, and each retry against a
// metered endpoint costs money — so they open the circuit immediately.

export interface RemoteErrorOptions {
  transient?: boolean
  retryAfterMs?: number
  status?: number
}

export class RemoteError extends Error {
  code: string
  transient: boolean
  retryAfterMs: number
  status: number

  constructor(
    code: string,
    message: string,
    { transient = true, retryAfterMs = 0, status = 0 }: RemoteErrorOptions = {},
  ) {
    super(message)
    this.code = code
    this.transient = transient
    this.retryAfterMs = retryAfterMs
    this.status = status
  }
}

function classify(status: number, body: unknown): RemoteError {
  const detail = typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body).slice(0, 200)
  if (status === 401 || status === 403) {
    return new RemoteError('auth_failed', `Endpoint rejected the credentials (${status}). Check KOTHAI_AI_API_KEY.`, {
      transient: false,
      status,
    })
  }
  if (status === 404) {
    return new RemoteError(
      'model_not_found',
      `Endpoint returned 404 — check the model name and KOTHAI_AI_BASE_URL. ${detail}`,
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
    // The detail is kept: OpenAI sends 429 for a per-minute limit and for an
    // account out of credit alike, and without its body a library whose
    // backlog had drained the account read as a passing rate limit.
    return new RemoteError('rate_limited', `Endpoint rate-limited the request. ${detail}`, { transient: true, status })
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

const realSleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

// How long before the next attempt: what the endpoint asked for if it said,
// our own backoff if it did not, capped either way. Jitter keeps several
// callers coming back at slightly different moments rather than in lockstep.
function waitFor(err: RemoteError, attempt: number): number {
  const asked = err.retryAfterMs > 0 ? err.retryAfterMs : BACKOFF_MS[attempt] + Math.random() * 250
  return Math.min(Math.round(asked), MAX_WAIT_MS)
}

// A predicate, not a boolean: withRetry's `err` arrives as unknown from the
// catch, and this is what narrows it to a RemoteError for waitFor().
// A timeout is transient for the circuit but never retried: the endpoint got
// the request and bills for it even after we hang up, so a retry paid for the
// same vision or classify call up to four times.
const retryable = (err: unknown): err is RemoteError =>
  err instanceof RemoteError && err.transient && err.code !== 'bad_response' && err.code !== 'timeout'

export interface RequestOptions {
  apiKey?: string | null
  timeoutMs?: number
  retries?: number
  sleep?: (ms: number) => Promise<void>
}

export async function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
  { apiKey = null, timeoutMs = 60_000, retries = RETRIES, sleep = realSleep }: RequestOptions = {},
): Promise<unknown> {
  const send = (b: unknown) =>
    withRetry(
      () => request(baseUrl, path, { method: 'POST', body: JSON.stringify(b), apiKey, timeoutMs }),
      retries,
      sleep,
    )
  return typeof body === 'object' && body !== null && 'reasoning_effort' in body
    ? withLeastReasoning(baseUrl, body, send)
    : send(body)
}

// A body asking for `reasoning_effort` is asking for as little reasoning as
// the model allows. A reasoning model bills its hidden reasoning as output
// tokens, and classify and vision keep only the answer — locally, Qwen3.5-VL
// generated 1,000-4,700 characters to keep 145-530 of them. No one value is
// safe on every endpoint (checked against each provider's docs, 2026-10-01):
// 'none' turns it off on OpenAI's gpt-5.1-and-later, OpenRouter, Ollama,
// Gemini 2.5 Flash, llama.cpp and vLLM; the gpt-5 originals reject it and
// want 'minimal'; Gemini 3 bottoms out at 'low'; and gpt-4o-mini and
// gpt-4.1-mini — the OpenAI defaults — reject the field with any value. So
// each 400 that names reasoning steps down a rung, ending with the field
// gone, and the rung that worked is remembered per model: an install on the
// defaults pays three unbilled 400s per model per boot, then nothing. Any
// other failure is not this one's to handle and is thrown as it was.
const EFFORTS = ['none', 'minimal', 'low', null]
const effortRung = new Map<string, number>()

async function withLeastReasoning(baseUrl: string, body: object, send: (b: unknown) => Promise<unknown>) {
  const fields = Object.entries(body).filter(([k]) => k !== 'reasoning_effort')
  const key = `${baseUrl} ${String(Object.fromEntries(fields).model)}`
  for (let rung = effortRung.get(key) ?? 0; ; rung++) {
    const effort = EFFORTS[rung]
    try {
      const res = await send(Object.fromEntries(effort ? [...fields, ['reasoning_effort', effort]] : fields))
      effortRung.set(key, rung)
      return res
    } catch (e) {
      const aboutReasoning =
        e instanceof RemoteError && e.code === 'bad_request' && /reasoning|thinking/i.test(e.message)
      if (!effort || !aboutReasoning) throw e
    }
  }
}

export async function getJson(
  baseUrl: string,
  path: string,
  { apiKey = null, timeoutMs = 60_000, retries = RETRIES, sleep = realSleep }: RequestOptions = {},
): Promise<unknown> {
  return withRetry(() => request(baseUrl, path, { method: 'GET', apiKey, timeoutMs }), retries, sleep)
}

async function withRetry(
  attemptFn: () => Promise<unknown>,
  retries: number,
  sleep: (ms: number) => Promise<void>,
): Promise<unknown> {
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

interface Attempt {
  method: 'GET' | 'POST'
  body?: string
  apiKey: string | null
  timeoutMs: number
}

async function request(baseUrl: string, path: string, { method, body, apiKey, timeoutMs }: Attempt): Promise<unknown> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  let res: Response
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
  } catch (e: unknown) {
    // Our own timeout is told apart from a DNS/connect failure because only
    // the timeout may have been billed — see retryable() on why that matters.
    if (ac.signal.aborted)
      throw new RemoteError('timeout', `${baseUrl} did not answer within ${timeoutMs / 1000}s`, { transient: true })
    const why = e instanceof Error ? e.message : String(e)
    throw new RemoteError('endpoint_unreachable', `Could not reach ${baseUrl}: ${why}`, { transient: true })
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
