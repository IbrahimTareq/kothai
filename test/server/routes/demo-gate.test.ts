// The public demo's gate, driven through a REAL listening server for the same
// reason as the password gate's tests: its claim is about everything the router
// can reach, which calling handlers directly cannot test.
//
// KOTHAI_DEMO is set before the dynamic import because server/config.ts freezes
// its resolved config at import time; node --test gives each file its own
// process, so it cannot leak into any other test. The data dir is a temp one so
// that a request slipping past the gate could never write to a real library.
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.KOTHAI_DEMO = '1'
process.env.KOTHAI_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'kothai-demo-gate-'))
const { createServer } = await import('../../../server/router.ts')
const store = await import('../../../server/data/notes.ts')
const chats = await import('../../../server/data/chats.ts')
const collections = await import('../../../server/data/collections.ts')
const { demoLimits } = await import('../../../server/routes/demo.ts')

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { jsonBody, listenOnLoopback } from '../../helpers/http.ts'

const server = createServer()
const BASE = `http://127.0.0.1:${await listenOnLoopback(server)}`
after(() => server.close())

const call = (method: string, p: string) =>
  fetch(`${BASE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : '{}',
  })

// Every one of these either rewrites the shared library, spends the operator's
// inference budget, hands over the whole library, or makes the server fetch a
// URL the visitor chose.
const REFUSED: [string, string][] = [
  ['POST', '/api/wipe'],
  ['POST', '/api/import'],
  ['POST', '/api/settings'],
  ['POST', '/api/setup'],
  ['POST', '/api/setup/test'],
  ['POST', '/api/setup/endpoint'],
  ['POST', '/api/settings/endpoint'],
  ['DELETE', '/api/settings/endpoint'],
  ['POST', '/api/telegram'],
  ['GET', '/api/telegram'],
  ['GET', '/api/export'],
  ['GET', '/api/backup'],
  ['POST', '/api/checkpoint'],
  ['POST', '/api/enrich/retag-all'],
  ['POST', '/api/enrich/backlog'],
  ['POST', '/api/availability/scan'],
  ['DELETE', '/api/models/files/x.gguf'],
]

for (const [method, p] of REFUSED) {
  test(`the demo refuses ${method} ${p}`, async () => {
    const res = await call(method, p)
    assert.equal(res.status, 403)
    assert.equal((await jsonBody(res)).code, 'demo')
  })
}

test('the demo still serves the library', async () => {
  assert.equal((await call('GET', '/api/notes')).status, 200)
  assert.equal((await call('GET', '/api/tags')).status, 200, 'a new space’s tag suggestions')
})

test('the demo lets a save and a question through to their handlers', async () => {
  // An empty body is the handlers' own 400, which proves the gate passed the
  // request on without making either one do any work.
  assert.equal((await call('POST', '/api/save')).status, 400)
  assert.equal((await call('POST', '/api/ask')).status, 400)
})

test('the demo lets a visitor make a space and delete one', async () => {
  // Both reach their handlers: an empty body is creation's own 400, and whose
  // space it is — here, nobody's — is the delete handler's own 404.
  assert.equal((await call('POST', '/api/collections')).status, 400)
  assert.equal((await call('DELETE', '/api/collections/abc')).status, 404)
})

test('the demo still answers the healthcheck', async () => {
  assert.equal((await call('GET', '/api/health')).status, 200)
})

test('the demo gives each new visitor their own id', async () => {
  const res = await call('GET', '/api/notes')
  assert.match(res.headers.get('set-cookie') ?? '', /^kothai_visitor=[0-9a-f-]{36};/)
})

// ---- what a visitor made is theirs to change --------------------------------
// Everything below reaches its handler, so each one checks whose it is: the
// shared library and other visitors' things answer exactly like missing ones.
const ME = '11111111-1111-4111-8111-111111111111'
const THEM = '22222222-2222-4222-8222-222222222222'

const as = (visitor: string, method: string, p: string, body: unknown = {}) =>
  fetch(`${BASE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: `kothai_visitor=${visitor}` },
    body: JSON.stringify(body),
  })

async function fixtures() {
  store._reset()
  chats._reset()
  collections._reset()
  demoLimits.save.reset()
  const note = (visitor?: string) => store.addNote({ type: 'link', content: 'x', tags: ['kept'], visitor })
  const space = (visitor?: string) => collections.create({ name: 'kept', visitor })
  const chat = async (visitor?: string) =>
    (await chats.appendExchange(null, { role: 'user', text: 'kept' }, { role: 'ai', text: 'x' }, visitor)).id
  return {
    mine: { note: await note(ME), space: await space(ME), chat: await chat(ME) },
    others: [
      { note: await note(), space: await space(), chat: await chat() },
      { note: await note(THEM), space: await space(THEM), chat: await chat(THEM) },
    ],
  }
}

// A note rather than tags: a tag edit queues a re-embed, and this server has
// no model to run it on. Whose link it is gets checked before either.
test('a visitor can write on and delete a link they saved', async () => {
  const { mine } = await fixtures()
  assert.equal((await as(ME, 'PATCH', `/api/notes/${mine.note.id}`, { mindNote: 'hi' })).status, 200)
  assert.equal(store.getNote(mine.note.id)?.mindNote, 'hi')
  assert.equal((await as(ME, 'DELETE', `/api/notes/${mine.note.id}`)).status, 200)
  assert.equal(store.getNote(mine.note.id), null)
})

test('the library’s links and another visitor’s cannot be edited, re-tagged or deleted', async () => {
  const { others } = await fixtures()
  for (const { note } of others) {
    assert.equal((await as(ME, 'PATCH', `/api/notes/${note.id}`, { tags: ['vandal'] })).status, 404)
    assert.equal((await as(ME, 'POST', `/api/notes/${note.id}/retag`)).status, 404)
    assert.equal((await as(ME, 'DELETE', `/api/notes/${note.id}`)).status, 404)
    assert.deepEqual(store.getNote(note.id)?.tags, ['kept'])
  }
})

test('re-tagging your own link spends one of the day’s saves, since it runs the model again', async () => {
  const { mine } = await fixtures()
  while (demoLimits.save.take(ME));
  const res = await as(ME, 'POST', `/api/notes/${mine.note.id}/retag`)
  assert.equal(res.status, 429)
  assert.equal((await jsonBody(res)).code, 'demo_limit')
})

test('a visitor can rename their space, lay out its canvas, and put the library’s links in and out of it', async () => {
  const { mine, others } = await fixtures()
  const space = `/api/collections/${mine.space.id}`
  assert.equal((await as(ME, 'PATCH', space, { name: 'Trip' })).status, 200)
  assert.equal((await as(ME, 'PATCH', space, { canvas: { nodes: [], edges: [] } })).status, 200)
  assert.equal((await as(ME, 'POST', `${space}/items`, { itemId: others[0].note.id })).status, 200)
  assert.deepEqual(collections.get(mine.space.id)?.itemIds, [others[0].note.id])
  assert.equal((await as(ME, 'DELETE', `${space}/items/${others[0].note.id}`)).status, 200)
  assert.equal(collections.get(mine.space.id)?.name, 'Trip')
})

test('a visitor cannot put another visitor’s link in their own space', async () => {
  const { mine, others } = await fixtures()
  const res = await as(ME, 'POST', `/api/collections/${mine.space.id}/items`, { itemId: others[1].note.id })
  assert.equal(res.status, 404)
  assert.deepEqual(collections.get(mine.space.id)?.itemIds, [])
})

test('the library’s spaces and another visitor’s cannot be renamed, filled or emptied', async () => {
  const { mine, others } = await fixtures()
  for (const { space } of others) {
    await collections.addItem(space.id, mine.note.id)
    const at = `/api/collections/${space.id}`
    assert.equal((await as(ME, 'PATCH', at, { name: 'vandal' })).status, 404)
    assert.equal((await as(ME, 'POST', `${at}/items`, { itemId: others[0].note.id })).status, 404)
    assert.equal((await as(ME, 'DELETE', `${at}/items/${mine.note.id}`)).status, 404)
    assert.equal(collections.get(space.id)?.name, 'kept')
    assert.deepEqual(collections.get(space.id)?.itemIds, [mine.note.id])
  }
})

test('a visitor can rename and delete their own chat, and no one else’s', async () => {
  const { mine, others } = await fixtures()
  for (const { chat } of others) {
    assert.equal((await as(ME, 'PATCH', `/api/chats/${chat}`, { title: 'vandal' })).status, 404)
    assert.equal((await as(ME, 'DELETE', `/api/chats/${chat}`)).status, 404)
    assert.equal(chats.get(chat)?.title, 'kept')
  }
  assert.equal((await as(ME, 'PATCH', `/api/chats/${mine.chat}`, { title: 'Mine' })).status, 200)
  assert.equal((await as(ME, 'DELETE', `/api/chats/${mine.chat}`)).status, 200)
  assert.equal(chats.get(mine.chat), null)
})

// The item view asks for an Instagram post's slides when it opens one, and the
// seeded library carries posts. The handler answers with the note, so it has
// to hide another visitor's as the reads do.
test('a visitor can open a post’s slides, but never reach another visitor’s link through them', async () => {
  const { mine, others } = await fixtures()
  assert.equal((await as(ME, 'POST', `/api/notes/${mine.note.id}/slides`)).status, 200)
  assert.equal((await as(ME, 'POST', `/api/notes/${others[0].note.id}/slides`)).status, 200)
  assert.equal((await as(ME, 'POST', `/api/notes/${others[1].note.id}/slides`)).status, 404)
})
