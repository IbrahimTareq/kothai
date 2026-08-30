// Tests for the viewport-priority Instagram meta queue: the deque that
// replaced enrich.js's old igChain promise chain (queueIgMeta/promoteIgMeta),
// plus the POST /api/enrich/prioritize route that lets the scrolling client
// bump on-screen notes to the front.
//
// The queue-ordering tests run against the REAL enrich.js with the pump
// suspended via _igQueueState.pause() (see enrich.js) so they exercise the
// actual queue/dedup/promote logic without ever touching fetch/model code.
// The route tests reuse that same real, paused queue (queueIgMeta only ever
// pushes onto an array while paused — no network involved) and mock just
// data/notes.js's allNotes(), following test/notes-route.test.js's mockRes
// pattern and test/import-route.test.js's EventEmitter-based fakeReq for the
// POST body (readBody's real req.on('data'/'end') contract).
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { _igQueueState, queueIgMeta, promoteIgMeta } from '../../../server/ai/enrich.js'

test('queueIgMeta dedupes by noteId and appends in order', () => {
  const s = _igQueueState
  s.pause()
  queueIgMeta('n1', 'https://www.instagram.com/reel/1/')
  queueIgMeta('n2', 'https://www.instagram.com/reel/2/')
  queueIgMeta('n1', 'https://www.instagram.com/reel/1/')
  assert.deepEqual(s.ids(), ['n1', 'n2'])
  s.clear()
})

test('promoteIgMeta moves queued ids to the front preserving request order', () => {
  const s = _igQueueState
  s.pause()
  for (const n of ['a', 'b', 'c', 'd']) queueIgMeta(n, `https://www.instagram.com/reel/${n}/`)
  promoteIgMeta(['c', 'b'])
  assert.deepEqual(s.ids(), ['c', 'b', 'a', 'd'])
  s.clear()
})

test('promoteIgMeta ignores ids that are not queued (already fetched, never queued, or garbage)', () => {
  const s = _igQueueState
  s.pause()
  queueIgMeta('x', 'https://www.instagram.com/reel/x/')
  const moved = promoteIgMeta(['nope', 'also-not-real', 'x'])
  assert.equal(moved, 1, 'only the one real match counts')
  assert.deepEqual(s.ids(), ['x'])
  s.clear()
})

test('promoteIgMeta with an empty or all-unknown list is a no-op', () => {
  const s = _igQueueState
  s.pause()
  queueIgMeta('a', 'https://www.instagram.com/reel/a/')
  queueIgMeta('b', 'https://www.instagram.com/reel/b/')
  assert.equal(promoteIgMeta([]), 0)
  assert.equal(promoteIgMeta(['ghost']), 0)
  assert.deepEqual(s.ids(), ['a', 'b'])
  s.clear()
})

// ---- route: POST /api/enrich/prioritize -----------------------------------
let notes
function reset() {
  notes = []
  _igQueueState.pause() // keep this suite network-free; each test clears its own queue
  _igQueueState.clear() // clear() also flips igPaused back to false, so re-pause after
  _igQueueState.pause()
}

const realStore = await import('../../../server/data/notes.js')
mock.module('../../../server/data/notes.js', { namedExports: { ...realStore, allNotes: () => notes } })

const { handlePrioritize } = await import('../../../server/routes/settings.js')

// A real EventEmitter satisfies readBody's req.on('data'/'end') contract —
// see test/import-route.test.js's identical fakeReq for the same reasoning.
function fakeReq(payload) {
  const req = new EventEmitter()
  req.destroy = () => {}
  setImmediate(() => {
    req.emit('data', Buffer.from(JSON.stringify(payload)))
    req.emit('end')
  })
  return req
}
function fakeRes() {
  return {
    statusCode: null,
    body: null,
    writeHead(code) { this.statusCode = code },
    end(str) { this.body = str ? JSON.parse(str) : null },
  }
}

test('handlePrioritize: non-array body → {promoted: 0}, nothing queued', async () => {
  reset()
  const res = fakeRes()
  await handlePrioritize(fakeReq({ ids: 'not-an-array' }), res)
  assert.deepEqual(res.body, { promoted: 0 })
  assert.deepEqual(_igQueueState.ids(), [])
})

test('handlePrioritize: ids for non-instagram or already-fetched notes are ignored', async () => {
  reset()
  notes = [
    { id: 'a', url: 'https://example.com/foo', metaFetched: false },
    { id: 'b', url: 'https://www.instagram.com/reel/2/', metaFetched: true },
    { id: 'c', url: null },
  ]
  const res = fakeRes()
  await handlePrioritize(fakeReq({ ids: ['a', 'b', 'c'] }), res)
  assert.deepEqual(res.body, { promoted: 0 })
  assert.deepEqual(_igQueueState.ids(), [])
})

test('handlePrioritize: an eligible instagram note without metaFetched gets queued and promoted', async () => {
  reset()
  notes = [{ id: 'r1', url: 'https://www.instagram.com/reel/9/', metaFetched: false }]
  const res = fakeRes()
  await handlePrioritize(fakeReq({ ids: ['r1'] }), res)
  assert.deepEqual(res.body, { promoted: 1 })
  assert.deepEqual(_igQueueState.ids(), ['r1'])
})

test('handlePrioritize: non-string entries in a mixed-type ids array are dropped before eligibility is considered', async () => {
  reset()
  notes = [{ id: 'ok1', url: 'https://www.instagram.com/reel/1/', metaFetched: false }]
  const res = fakeRes()
  await handlePrioritize(fakeReq({ ids: ['ok1', 123, null, { id: 'ok1' }, true, [1, 2]] }), res)
  assert.deepEqual(res.body, { promoted: 1 }, 'only the one real string id survives the type filter')
  assert.deepEqual(_igQueueState.ids(), ['ok1'])
})

test('handlePrioritize: caps the incoming ids list at 200 before considering eligibility', async () => {
  reset()
  const ids = []
  notes = []
  for (let i = 0; i < 250; i++) {
    const id = `note-${i}`
    ids.push(id)
    notes.push({ id, url: `https://www.instagram.com/reel/${i}/`, metaFetched: false })
  }
  const res = fakeRes()
  await handlePrioritize(fakeReq({ ids }), res)
  assert.equal(res.body.promoted, 200, 'only the first 200 ids are considered, even though all 250 notes are eligible')
  assert.deepEqual(_igQueueState.ids(), ids.slice(0, 200), 'the cap keeps exactly the first 200 in request order')
})

test('handlePrioritize: an already-queued-but-not-yet-fetched note is promoted to the front', async () => {
  reset()
  notes = [
    { id: 'old1', url: 'https://www.instagram.com/reel/1/', metaFetched: false },
    { id: 'old2', url: 'https://www.instagram.com/reel/2/', metaFetched: false },
    { id: 'visible', url: 'https://www.instagram.com/reel/3/', metaFetched: false },
  ]
  queueIgMeta('old1', notes[0].url)
  queueIgMeta('old2', notes[1].url)
  queueIgMeta('visible', notes[2].url)
  const res = fakeRes()
  await handlePrioritize(fakeReq({ ids: ['visible'] }), res)
  assert.deepEqual(res.body, { promoted: 1 })
  assert.deepEqual(_igQueueState.ids(), ['visible', 'old1', 'old2'])
})
