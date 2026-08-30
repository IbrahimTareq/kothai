// Tests for chats.recentMessages — the tail of a conversation that Ask feeds
// to the answer prompt and to the retrieval query.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import * as chats from '../../../server/data/chats.js'

beforeEach(() => chats._reset())

async function seed(turns) {
  let id = null
  for (const [q, a] of turns) {
    const chat = await chats.appendExchange(id, { role: 'user', text: q }, { role: 'ai', text: a, sources: [{ id: 'n1' }] })
    id = chat.id
  }
  return id
}

test('returns the last N exchanges in order, oldest first', async () => {
  const id = await seed([['q1', 'a1'], ['q2', 'a2'], ['q3', 'a3'], ['q4', 'a4']])
  const out = chats.recentMessages(id, 2)
  assert.deepEqual(out, [
    { role: 'user', text: 'q3' },
    { role: 'ai', text: 'a3' },
    { role: 'user', text: 'q4' },
    { role: 'ai', text: 'a4' },
  ])
})

test('drops the cited-sources snapshot each AI message carries', async () => {
  const id = await seed([['q1', 'a1']])
  // Replaying an older turn's sources would put stale, unranked evidence
  // beside the notes this turn actually retrieved.
  assert.ok(chats.recentMessages(id).every((m) => !('sources' in m)))
})

test('a new chat and an unknown id both yield an empty history, never a throw', async () => {
  assert.deepEqual(chats.recentMessages(null), [])
  assert.deepEqual(chats.recentMessages(undefined), [])
  assert.deepEqual(chats.recentMessages('no-such-chat'), [])
})

test('a chat shorter than the window returns everything it has', async () => {
  const id = await seed([['only q', 'only a']])
  assert.equal(chats.recentMessages(id, 3).length, 2)
})

// ---- rename --------------------------------------------------------------
// The title is otherwise derived from the first question, which is a poor
// label for a thread that wandered.

test('rename replaces the derived title and bumps updatedAt', async () => {
  const id = await seed([['what did I save about coffee?', 'a1']])
  const before = chats.get(id).updatedAt
  await new Promise((r) => setTimeout(r, 2))
  const out = await chats.rename(id, '  Coffee gear  ')
  assert.equal(out.title, 'Coffee gear', 'the title is trimmed')
  assert.equal(chats.get(id).title, 'Coffee gear')
  assert.ok(chats.get(id).updatedAt >= before)
})

test('rename refuses an empty or whitespace-only title', async () => {
  const id = await seed([['q1', 'a1']])
  assert.equal(await chats.rename(id, '   '), null)
  assert.equal(await chats.rename(id, ''), null)
  assert.equal(chats.get(id).title, 'q1', 'the original title survives a rejected rename')
})

test('rename caps the title at the same length as a derived one', async () => {
  const id = await seed([['q1', 'a1']])
  const out = await chats.rename(id, 'x'.repeat(200))
  assert.equal(out.title.length, 80)
})

test('renaming an unknown chat is a no-op, not a throw', async () => {
  assert.equal(await chats.rename('no-such-id', 'Anything'), null)
})

// ---- paged list ----------------------------------------------------------
// The Ask page renders one screenful and walks the rest with "Load more", so
// list() has to page without ever repeating or dropping a chat.

test('list pages newest-first and reports the full total', async () => {
  for (const q of ['q1', 'q2', 'q3', 'q4', 'q5']) await seed([[q, 'a']])
  const first = chats.list({ offset: 0, limit: 2 })
  assert.equal(first.total, 5, 'total counts every chat, not just the page')
  assert.deepEqual(first.chats.map((c) => c.title), ['q5', 'q4'])
  const second = chats.list({ offset: 2, limit: 2 })
  assert.deepEqual(second.chats.map((c) => c.title), ['q3', 'q2'])
})

test('paging past the end yields an empty page, not a throw', async () => {
  await seed([['only', 'a']])
  const page = chats.list({ offset: 50, limit: 8 })
  assert.deepEqual(page.chats, [])
  assert.equal(page.total, 1)
})

test('walking every page reproduces the whole list exactly once', async () => {
  for (const q of ['q1', 'q2', 'q3', 'q4', 'q5']) await seed([[q, 'a']])
  const seen = []
  for (let off = 0; off < chats.list({ limit: 1 }).total; off += 2) {
    seen.push(...chats.list({ offset: off, limit: 2 }).chats.map((c) => c.id))
  }
  assert.equal(seen.length, 5)
  assert.equal(new Set(seen).size, 5, 'no chat appears on two pages')
})

test('an omitted limit returns everything, for callers that are not paging', async () => {
  for (const q of ['q1', 'q2', 'q3']) await seed([[q, 'a']])
  assert.equal(chats.list().chats.length, 3)
})
