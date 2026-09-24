// The SSE contract for POST /api/ask. The Ask view drives the whole thread off
// these frames, so their names, order and payload shapes are load-bearing: the
// sources arrive before any prose (the cards render while the answer is still
// being written), the deltas reconstruct the answer exactly, and `done` carries
// the chat id the client needs for follow-up questions.
import { test, mock, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AnswerStreamArgs } from '../../../server/ai/providers/types.ts'
import { jsonBody, listenOnLoopback, record } from '../../helpers/http.ts'

const SOURCES = [{ id: 'n1', title: 'A note', summary: 'About coffee.' }]
const ANSWER = 'You saved a note about coffee [1].'
// The default streaming behaviour's chunks. Hoisted because String.match
// answers `string[] | null`, and a null degraded into an empty list would turn
// every "the answer arrives in more than one piece" assertion into a no-op.
const CHUNKS = ANSWER.match(/[\s\S]{1,6}/g)
assert.ok(CHUNKS)

// What the mocked provider does on the next call. Reassigned per test.
let answerBehaviour: (args: AnswerStreamArgs) => Promise<string>

mock.module('../../../server/ai/index.ts', {
  namedExports: {
    FeatureDisabledError: class FeatureDisabledError extends Error {},
    statusSnapshot: () => ({
      roles: { llm: { state: 'ready' }, embed: { state: 'ready' }, vision: { state: 'ready' } },
    }),
    embedText: async () => [0.1, 0.2],
    answer: async () => ANSWER,
    answerStream: (args: AnswerStreamArgs) => answerBehaviour(args),
    describeImage: async () => 'an image',
  },
})
mock.module('../../../server/data/settings.ts', {
  namedExports: { getResidency: () => ({ llm: 'ondemand', embed: 'ondemand', vision: 'ondemand' }) },
})
mock.module('../../../server/data/notes.ts', {
  namedExports: {
    count: () => 3,
    hybridSearch: () => SOURCES,
    textSearch: () => SOURCES,
  },
})

// Imported at module scope, not inside before(): the mocks above are already
// installed by the time this line runs, and a module bound in a hook is
// `T | undefined` for the rest of the file.
const { handleAsk } = await import('../../../server/routes/ask.ts')
const chats = await import('../../../server/data/chats.ts')
const { demoLimits } = await import('../../../server/routes/demo.ts')

// x-viewer stands in for the demo's visitor cookie, which the router resolves
// before handleAsk ever sees the request.
const server = createServer((req, res) => {
  const viewer = req.headers['x-viewer']
  handleAsk(req, res, typeof viewer === 'string' ? viewer : null).catch(() => {
    if (!res.writableEnded) res.end()
  })
})
const base = `http://127.0.0.1:${await listenOnLoopback(server)}/api/ask`
after(async () => {
  await new Promise<void>(r => {
    server.close(() => r())
  })
})

beforeEach(() => {
  chats._reset()
  demoLimits.ask.reset()
  answerBehaviour = async ({ onToken }) => {
    for (const chunk of CHUNKS) onToken?.(chunk)
    return ANSWER
  }
})

// Minimal SSE reader: returns the frames in arrival order.
async function askStream(body: Record<string, unknown>, init: RequestInit = {}) {
  const r = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    ...init,
  })
  const frames: { event: string; data: Record<string, unknown> }[] = []
  const text = await r.text()
  for (const frame of text.split('\n\n')) {
    const event = /^event: (.*)$/m.exec(frame)?.[1]
    const data = /^data: (.*)$/m.exec(frame)?.[1]
    if (event && data != null) frames.push({ event, data: record(JSON.parse(data)) })
  }
  return { res: r, frames }
}

test('streams sources, then deltas, then done', async () => {
  const { res, frames } = await askStream({ question: 'what about coffee?' })
  assert.equal(res.status, 200)
  const contentType = res.headers.get('content-type')
  assert.ok(typeof contentType === 'string')
  assert.match(contentType, /text\/event-stream/)
  assert.equal(res.headers.get('cache-control'), 'no-cache, no-transform')

  assert.equal(frames[0].event, 'sources', 'sources must lead so the cards can render first')
  assert.deepEqual(frames[0].data.sources, SOURCES)
  assert.equal(frames[frames.length - 1].event, 'done')

  const deltas = frames.filter(f => f.event === 'delta')
  assert.ok(deltas.length > 1, 'the answer must arrive in more than one piece')
  assert.equal(deltas.map(d => d.data.text).join(''), ANSWER, 'deltas must reconstruct the answer exactly')
})

test('done carries a chat id that the exchange was recorded under', async () => {
  const { frames } = await askStream({ question: 'what about coffee?' })
  const id = frames[frames.length - 1].data.chatId
  assert.ok(typeof id === 'string')
  const chat = chats.get(id)
  assert.ok(chat)
  assert.equal(chat.messages.length, 2)
  assert.equal(chat.messages[0].text, 'what about coffee?')
  assert.equal(chat.messages[1].text, ANSWER)
})

test('a follow-up appends to the same chat rather than starting a new one', async () => {
  const first = await askStream({ question: 'what about coffee?' })
  const id = first.frames[first.frames.length - 1].data.chatId
  assert.ok(typeof id === 'string')
  const second = await askStream({ question: 'and tea?', chatId: id })
  assert.equal(second.frames[second.frames.length - 1].data.chatId, id)
  const chat = chats.get(id)
  assert.ok(chat)
  assert.equal(chat.messages.length, 4)
})

test('a newline in the answer cannot break the frame delimiter', async () => {
  const multiline = 'line one\n\nline two'
  answerBehaviour = async ({ onToken }) => {
    onToken?.(multiline)
    return multiline
  }
  const { frames } = await askStream({ question: 'q' })
  const deltas = frames.filter(f => f.event === 'delta')
  assert.equal(deltas.length, 1, 'a blank line inside the payload must not split it into two frames')
  assert.equal(deltas[0].data.text, multiline)
})

test('a provider failure mid-stream arrives as an error frame, not a dead connection', async () => {
  answerBehaviour = async ({ onToken }) => {
    onToken?.('partial')
    throw new Error('model exploded')
  }
  const { res, frames } = await askStream({ question: 'q' })
  assert.equal(res.status, 200, 'the status line is already sent — the failure has to travel down the stream')
  const err = frames.find(f => f.event === 'error')
  assert.ok(err, 'an error frame must be sent')
  assert.ok(typeof err.data.error === 'string')
  assert.match(err.data.error, /model exploded/)
  assert.equal(frames.filter(f => f.event === 'done').length, 0)
})

// A rejection is not necessarily an Error. providers/local.ts rethrows the QVAC
// SDK's own rejection value unwrapped through ai/index.ts, so the caught value
// is whatever the SDK threw — and for `null`/`undefined` a bare `e.message`
// makes the catch block itself throw. That second failure lands after the 200
// SSE header is out, where the router's json(res, 500, …) can only produce
// ERR_HTTP_HEADERS_SENT: the client is left with a stream that just stops,
// carrying no error frame and no `done`, with nothing said about why.
test('a null rejection still reaches the client as an error frame', async () => {
  answerBehaviour = async ({ onToken }) => {
    onToken?.('partial')
    throw null
  }
  const { res, frames } = await askStream({ question: 'q' })
  assert.equal(res.status, 200)
  const err = frames.find(f => f.event === 'error')
  assert.ok(err, 'reading .message off the rejection must not become a second, unreportable failure')
  assert.equal(err.data.error, undefined, 'a null rejection has no message to report')
  assert.equal(frames.filter(f => f.event === 'done').length, 0)
})

// This asserts the mechanism, not just the outcome. An earlier version only
// checked that nothing was recorded, which stayed green while the disconnect
// listener was attached to the request stream — already closed by readBody, so
// it never fired and a stopped answer kept generating and saving itself.
test('a client hangup is observed by the provider as an abort', async () => {
  const gate = new AbortController()
  let sawAbort = false
  answerBehaviour = async ({ onToken, signal }) => {
    onToken?.('partial ')
    gate.abort()
    await new Promise<void>(r => {
      if (signal?.aborted) return r()
      signal?.addEventListener('abort', () => r(), { once: true })
      setTimeout(() => r(), 2000) // generous, so a real failure reads as "never fired"
    })
    sawAbort = Boolean(signal?.aborted)
    return 'partial '
  }
  await askStream({ question: 'q' }, { signal: gate.signal }).catch(() => {})
  await new Promise(r => setTimeout(r, 100))
  assert.equal(sawAbort, true, 'the signal handed to the provider must fire when the client goes away')
})

test('an aborted request records nothing — a stopped question is not a saved answer', async () => {
  const gate = new AbortController()
  answerBehaviour = async ({ onToken, signal }) => {
    onToken?.('partial ')
    gate.abort()
    await new Promise<void>(r => {
      if (signal?.aborted) return r()
      signal?.addEventListener('abort', () => r(), { once: true })
      setTimeout(() => r(), 2000)
    })
    return 'partial '
  }
  await askStream({ question: 'q' }, { signal: gate.signal }).catch(() => {})
  await new Promise(r => setTimeout(r, 100))
  assert.equal(chats.list().total, 0, 'no chat should have been written')
})

test('without the event-stream Accept header the response is still plain JSON', async () => {
  const r = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'what about coffee?' }),
  })
  const contentType = r.headers.get('content-type')
  assert.ok(typeof contentType === 'string')
  assert.match(contentType, /application\/json/)
  const d = await jsonBody(r)
  assert.equal(d.answer, ANSWER)
  assert.deepEqual(d.sources, SOURCES)
  assert.ok(d.chatId)
})

test('on the demo, another visitor’s chat is never continued, and the new one is the asker’s', async () => {
  const theirs = await chats.appendExchange(null, { role: 'user', text: 'secret' }, { role: 'ai', text: 'x' }, 'b')
  const { frames } = await askStream(
    { question: 'and tea?', chatId: theirs.id },
    { headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'x-viewer': 'a' } },
  )
  const id = frames[frames.length - 1].data.chatId
  assert.ok(typeof id === 'string')
  assert.notEqual(id, theirs.id)
  assert.equal(chats.get(id)?.visitor, 'a')
  assert.equal(chats.get(theirs.id)?.messages.length, 2, 'their chat must be left untouched')
})

// A demo visitor's question, answered with plain JSON so a refusal's code can
// be read (askStream has already consumed the body by the time it returns).
async function askAs(viewer: string, body: Record<string, unknown>) {
  const r = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-viewer': viewer },
    body: JSON.stringify(body),
  })
  return { status: r.status, body: await jsonBody(r) }
}

test('the demo answers text questions only, and short ones', async () => {
  const image = await askAs('a', { question: 'what is this?', image: 'data:image/png;base64,AAAA' })
  assert.equal(image.status, 400)
  assert.equal(image.body.code, 'demo_text_only')
  const long = await askAs('a', { question: 'x'.repeat(501) })
  assert.equal(long.status, 400)
  assert.equal(long.body.code, 'demo_too_long')
})

test('a demo visitor gets ten questions a day, and then hears why not', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await askAs('a', { question: 'q' })).status, 200)
  const over = await askAs('a', { question: 'q' })
  assert.equal(over.status, 429)
  assert.equal(over.body.code, 'demo_limit')
})
