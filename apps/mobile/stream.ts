// The prototype's SSE check (plan ruling E3): post a question and report every
// chunk of the body the moment it arrives, stamped with milliseconds since the
// request went out. Chunks are reported raw, not parsed into events, because
// the question is whether `expo/fetch` delivers the stream incrementally or
// buffers it to the end: evenly spaced stamps mean the former.
export type Chunk = { ms: number; text: string }

// `signal` stops the run: /api/ask cancels generation when the response
// closes (server/routes/ask.ts), so a second Ask or leaving the screen must
// abort the first, or two streams interleave in one log and the server keeps
// generating an answer nobody reads.
export async function streamAsk(
  url: string,
  question: string,
  fetch: typeof globalThis.fetch,
  onChunk: (chunk: Chunk) => void,
  signal: AbortSignal,
): Promise<{ status: number; ok: boolean }> {
  const start = Date.now()
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ question }),
    signal,
  })
  const outcome = { status: res.status, ok: res.ok }
  if (!res.body) return outcome
  // With the language model off, /api/ask answers 409 llm_off as plain JSON,
  // not a stream; it still comes through this reader, as one chunk.
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let finished = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      // A read that resolved just before the abort would still land in the
      // log after the next Ask has cleared it.
      signal.throwIfAborted()
      if (done) break
      onChunk({ ms: Date.now() - start, text: decoder.decode(value, { stream: true }) })
    }
    finished = true
  } finally {
    // Leaving early (abort, network error) must close the connection. The
    // cancel's own rejection is ignored: the error that got us here is the
    // one already propagating.
    if (!finished) reader.cancel().catch(() => {})
  }
  return outcome
}
