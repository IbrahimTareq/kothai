// The prototype's SSE check (plan ruling E3): post a question and report every
// chunk of the body the moment it arrives, stamped with milliseconds since the
// request went out. Chunks are reported raw, not parsed into events, because
// the question is whether `expo/fetch` delivers the stream incrementally or
// buffers it to the end: evenly spaced stamps mean the former.
export type Chunk = { ms: number; text: string }

export async function streamAsk(
  url: string,
  question: string,
  fetch: typeof globalThis.fetch,
  onChunk: (chunk: Chunk) => void,
): Promise<number> {
  const start = Date.now()
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ question }),
  })
  if (!res.body) return res.status
  // With the language model off, /api/ask answers 409 llm_off as plain JSON,
  // not a stream; it still comes through this reader, as one chunk.
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    onChunk({ ms: Date.now() - start, text: decoder.decode(value, { stream: true }) })
  }
  return res.status
}
