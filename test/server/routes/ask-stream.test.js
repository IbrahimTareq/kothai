// The SSE contract for POST /api/ask. The Ask view drives the whole thread off
// these frames, so their names, order and payload shapes are load-bearing: the
// sources arrive before any prose (the cards render while the answer is still
// being written), the deltas reconstruct the answer exactly, and `done` carries
// the chat id the client needs for follow-up questions.
import { test, mock, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

const SOURCES = [{ id: 'n1', title: 'A note', summary: 'About coffee.' }]
const ANSWER = 'You saved a note about coffee [1].'

// What the mocked provider does on the next call. Reassigned per test.
let answerBehaviour = null

mock.module('../../../server/ai/index.js', {
  namedExports: {
    FeatureDisabledError: class FeatureDisabledError extends Error {},
    statusSnapshot: () => ({ roles: { llm: { state: 'ready' }, embed: { state: 'ready' }, vision: { state: 'ready' } } }),
    embedText: async () => [0.1, 0.2],
    answer: async () => ANSWER,
    answerStream: (args) => answerBehaviour(args),
    describeImage: async () => 'an image',
  },
})
mock.module('../../../server/data/settings.js', {
  namedExports: { getResidency: () => ({ llm: 'ondemand', embed: 'ondemand', vision: 'ondemand' }) },
})
mock.module('../../../server/data/notes.js', {
  // UPLOAD_DIR is here because http.js imports it — replacing a module means
  // covering everything that reaches for it, not just what the route uses.
  namedExports: {
    count: () => 3, hybridSearch: () => SOURCES, textSearch: () => SOURCES,
    UPLOAD_DIR: '/tmp/kothai-test-uploads',
  },
})

let server, base, handleAsk, chats

before(async () => {
  ;({ handleAsk } = await import('../../../server/routes/ask.js'))
  chats = await import('../../../server/data/chats.js')
  server = createServer((req, res) => { handleAsk(req, res).catch(() => { if (!res.writableEnded) res.end() }) })
  await new Promise((r) => server.listen(0, r))
  base = `http://127.0.0.1:${server.address().port}/api/ask`
})
after(async () => { await new Promise((r) => server.close(r)) })

beforeEach(() => {
  chats._reset()
  answerBehaviour = async ({ onToken }) => {
    for (const chunk of ANSWER.match(/[\s\S]{1,6}/g)) onToken?.(chunk)
    return ANSWER
  }
})

// Minimal SSE reader: returns the frames in arrival order.
async function askStream(body, init = {}) {
  const r = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    ...init,
  })
  const frames = []
  const text = await r.text()
  for (const frame of text.split('\n\n')) {
    const event = /^event: (.*)$/m.exec(frame)?.[1]
    const data = /^data: (.*)$/m.exec(frame)?.[1]
    if (event && data != null) frames.push({ event, data: JSON.parse(data) })
  }
  return { res: r, frames }
}

test('streams sources, then deltas, then done', async () => {
  const { res, frames } = await askStream({ question: 'what about coffee?' })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/event-stream/)
  assert.equal(res.headers.get('cache-control'), 'no-cache, no-transform')

  assert.equal(frames[0].event, 'sources', 'sources must lead so the cards can render first')
  assert.deepEqual(frames[0].data.sources, SOURCES)
  assert.equal(frames[frames.length - 1].event, 'done')

  const deltas = frames.filter((f) => f.event === 'delta')
  assert.ok(deltas.length > 1, 'the answer must arrive in more than one piece')
  assert.equal(deltas.map((d) => d.data.text).join(''), ANSWER, 'deltas must reconstruct the answer exactly')
})

test('done carries a chat id that the exchange was recorded under', async () => {
  const { frames } = await askStream({ question: 'what about coffee?' })
  const id = frames[frames.length - 1].data.chatId
  assert.ok(id)
  const chat = chats.get(id)
  assert.equal(chat.messages.length, 2)
  assert.equal(chat.messages[0].text, 'what about coffee?')
  assert.equal(chat.messages[1].text, ANSWER)
})

test('a follow-up appends to the same chat rather than starting a new one', async () => {
  const first = await askStream({ question: 'what about coffee?' })
  const id = first.frames[first.frames.length - 1].data.chatId
  const second = await askStream({ question: 'and tea?', chatId: id })
  assert.equal(second.frames[second.frames.length - 1].data.chatId, id)
  assert.equal(chats.get(id).messages.length, 4)
})

test('a newline in the answer cannot break the frame delimiter', async () => {
  const multiline = 'line one\n\nline two'
  answerBehaviour = async ({ onToken }) => { onToken?.(multiline); return multiline }
  const { frames } = await askStream({ question: 'q' })
  const deltas = frames.filter((f) => f.event === 'delta')
  assert.equal(deltas.length, 1, 'a blank line inside the payload must not split it into two frames')
  assert.equal(deltas[0].data.text, multiline)
})

test('a provider failure mid-stream arrives as an error frame, not a dead connection', async () => {
  answerBehaviour = async ({ onToken }) => { onToken?.('partial'); throw new Error('model exploded') }
  const { res, frames } = await askStream({ question: 'q' })
  assert.equal(res.status, 200, 'the status line is already sent — the failure has to travel down the stream')
  const err = frames.find((f) => f.event === 'error')
  assert.ok(err, 'an error frame must be sent')
  assert.match(err.data.error, /model exploded/)
  assert.equal(frames.filter((f) => f.event === 'done').length, 0)
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
    await new Promise((r) => {
      if (signal?.aborted) return r()
      signal?.addEventListener('abort', r, { once: true })
      setTimeout(r, 2000)   // generous, so a real failure reads as "never fired"
    })
    sawAbort = Boolean(signal?.aborted)
    return 'partial '
  }
  await askStream({ question: 'q' }, { signal: gate.signal }).catch(() => {})
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(sawAbort, true, 'the signal handed to the provider must fire when the client goes away')
})

test('an aborted request records nothing — a stopped question is not a saved answer', async () => {
  const gate = new AbortController()
  answerBehaviour = async ({ onToken, signal }) => {
    onToken?.('partial ')
    gate.abort()
    await new Promise((r) => {
      if (signal?.aborted) return r()
      signal?.addEventListener('abort', r, { once: true })
      setTimeout(r, 2000)
    })
    return 'partial '
  }
  await askStream({ question: 'q' }, { signal: gate.signal }).catch(() => {})
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(chats.list().total, 0, 'no chat should have been written')
})

test('without the event-stream Accept header the response is still plain JSON', async () => {
  const r = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'what about coffee?' }),
  })
  assert.match(r.headers.get('content-type'), /application\/json/)
  const d = await r.json()
  assert.equal(d.answer, ANSWER)
  assert.deepEqual(d.sources, SOURCES)
  assert.ok(d.chatId)
})
