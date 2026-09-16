// The node:http shapes tests need and cannot spell themselves: real request
// and response objects for calling a handler directly, and the two narrowings
// every test that drives a real listening server had to do by hand.
//
// One module rather than two because the JSON guard below is shared, and a
// second copy of it in a sibling file would be the first thing to drift.
//
// Fourteen test files each hand-rolled a plain object with writeHead/end and
// handed it to a parameter typed `ServerResponse`. That works at runtime and
// is unrepresentable in the type system, which is why those files stayed .js
// through ten migration waves: the only way to type the literal was
// `as unknown as ServerResponse`, and a cast there would have made every
// handler's parameter type a lie — the exact property the migration existed to
// establish.
//
// So these build the real classes and swap only the two methods a test reads
// back. The swap is not a convenience: a ServerResponse with no live socket
// keeps nothing of what it was handed — getHeaders() comes back EMPTY for
// headers passed to writeHead (measured in wave 0a, see
// test/server/lib/static-cache.test.ts) — so recording at the call is the only
// way to observe a response at all.
import { IncomingMessage, ServerResponse } from 'node:http'
import type { IncomingHttpHeaders, OutgoingHttpHeader, OutgoingHttpHeaders } from 'node:http'
import { Socket } from 'node:net'
import type { Server } from 'node:net'

export interface Sent {
  code: number | null
  // Lowercased, because that is how a header arrives at a real client and
  // handlers in this repo spell them inconsistently (`Content-Type` in
  // downloadJson, `content-type` elsewhere).
  headers: Record<string, string>
  body: string | Buffer | undefined
  // The body parsed as JSON. Separate from `body` because both are real
  // usage: eleven of the surveyed files JSON.parse it in their fake's end(),
  // three (export, wipe, static-cache) assert on the raw string.
  json(): Record<string, unknown>
}

// A guard rather than an assignment, so the shape is actually checked at
// runtime. Handing back `any` from JSON.parse would type every call site off a
// promise nothing verifies — the same unsoundness as the cast this file
// exists to avoid, one level further down.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// The two narrowings json() cannot do for itself. It answers
// Record<string, unknown> because that is all a parse can honestly promise, so
// a test reading `body.notes[0].type` or `body.facets.types` has two or three
// unknowns to get through and only one one-liner available: a cast.
//
// `Array.isArray(body.notes)` would compile without one — and is worse, because
// it narrows unknown to `any[]`, so every read off the array afterwards is
// unchecked while looking, in review, like a guard. These keep the elements at
// Record<string, unknown> and name the offending value when a route's shape
// changes, so the failure lands here rather than at an undefined property read
// three assertions later.
export function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`expected a JSON object, got ${JSON.stringify(value)?.slice(0, 80)}`)
  return value
}

export function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`expected an array, got ${JSON.stringify(value)?.slice(0, 80)}`)
  return value.map((v: unknown, i) => {
    if (!isRecord(v))
      throw new Error(`expected element ${i} to be a JSON object, got ${JSON.stringify(v)?.slice(0, 80)}`)
    return v
  })
}

export function mockRes(): { res: ServerResponse; sent: Sent } {
  const res = new ServerResponse(mockReq())
  const sent: Sent = {
    code: null,
    headers: {},
    body: undefined,
    json() {
      if (sent.body === undefined) throw new Error('mockRes: end() was never called, so there is no body to parse')
      const parsed: unknown = JSON.parse(sent.body.toString())
      if (!isRecord(parsed)) throw new Error(`mockRes: body is not a JSON object: ${sent.body.toString().slice(0, 80)}`)
      return parsed
    },
  }
  res.writeHead = (
    code: number,
    a?: string | OutgoingHttpHeaders | OutgoingHttpHeader[],
    b?: OutgoingHttpHeaders | OutgoingHttpHeader[],
  ) => {
    // node's writeHead also has a (code, statusMessage, headers) overload; the
    // recorder has to accept it to be assignable, though no handler here calls
    // anything but the two-argument form.
    const headers = typeof a === 'string' ? b : a
    sent.code = code
    sent.headers = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]))
    return res
  }
  res.end = (body?: unknown) => {
    // node's end() also accepts a callback as its first argument; handlers here
    // only ever pass the bytes or nothing, and a callback is not a body.
    sent.body = typeof body === 'string' || Buffer.isBuffer(body) ? body : undefined
    return res
  }
  return { res, sent }
}

export function mockReq({
  method = 'GET',
  url = '/',
  headers = {},
  body,
}: {
  method?: string
  url?: string
  headers?: IncomingHttpHeaders
  body?: string
} = {}): IncomingMessage {
  const req = new IncomingMessage(new Socket())
  req.method = method
  req.url = url
  req.headers = headers
  // A real Readable, not an EventEmitter emitting 'data' from a setImmediate:
  // the buffered push is delivered whenever the handler starts reading, so a
  // handler that awaits the body before subscribing cannot miss it.
  if (body !== undefined) req.push(body)
  // Always EOF, body or not — a handler reading the body of a request that
  // never ends hangs the test run instead of failing it.
  req.push(null)
  return req
}

// ---- driving a real listening server -----------------------------------

// `await new Promise(r => server.listen(0, '127.0.0.1', r))` — the line the ten
// server-driving files share — does not compile: node types listen's callback as
// `() => void` and the promise's resolve as `(value: unknown) => void`, so no
// overload matches. server.address() then widens to
// `string | AddressInfo | null`, because the same method answers for a unix
// socket and for a server that is not listening yet.
//
// Listening and reading the port back are one step at every call site, so they
// are one helper: a `portOf(server)` that only narrowed address() would leave
// the listen line broken in all ten and would have no caller of its own.
export async function listenOnLoopback(server: Server): Promise<number> {
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string')
    throw new Error(`expected a TCP port, got ${JSON.stringify(address)} — is this server listening on a pipe?`)
  return address.port
}

// `(await res.json()).ok` does not compile either: node types json() as
// Promise<unknown>, correctly — nothing about a Response says its body is an
// object. Checked rather than asserted for the same reason as above, so a
// handler that answers with HTML or an array fails here, naming the body,
// instead of failing later on an undefined property read.
export async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  const parsed: unknown = await res.json()
  if (!isRecord(parsed)) throw new Error(`expected a JSON object body, got ${JSON.stringify(parsed)?.slice(0, 80)}`)
  return parsed
}
