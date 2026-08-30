// SQLite-backed persistence for Ask conversations, so chats survive reloads
// and can be browsed and resumed. Each AI message snapshots the source notes
// it cited, so history still renders if a note is deleted.
import { randomUUID } from 'node:crypto'
import { getDb, _resetDb } from './db.js'

let chats = []
let loaded = false

export async function load() {
  if (loaded) return
  const db = await getDb()
  chats = db.prepare('SELECT data FROM chats ORDER BY seq DESC').all().map((r) => JSON.parse(r.data))
  loaded = true
}

// One higher than every existing seq, so writing it back puts this chat at
// the front of the next `ORDER BY seq DESC` read — chats.js's equivalent of
// the old array's "move to front" splice, since AUTOINCREMENT (used by
// notes/collections) only ever advances on INSERT, never on UPDATE.
function nextSeq(db) {
  return db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM chats').get().n
}

function upsertRow(db, chat) {
  db.prepare(`
    INSERT INTO chats (seq, id, data) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET seq = excluded.seq, data = excluded.data
  `).run(nextSeq(db), chat.id, JSON.stringify(chat))
}

// test-only: clean in-memory slate against a fresh in-memory database,
// mirroring notes.js / collections.js / tagvocab.js's own _reset() helpers.
export function _reset() {
  _resetDb()
  chats = []
  loaded = true
}

// Erase every chat — see notes.clearAll().
export async function clearAll() {
  const removed = chats.length
  chats = []
  ;(await getDb()).prepare('DELETE FROM chats').run()
  return removed
}

// Full chats (messages included) — used by export, unlike the history
// view's list() which deliberately omits them.
export function all() {
  return chats.map((c) => ({ ...c, messages: c.messages.map((m) => ({ ...m })) }))
}

// Lightweight list for the history view (no messages). Paged, because the Ask
// page shows a first screenful and loads the rest only when asked. `chats` is
// already newest-first (appendExchange moves a chat to the front), so a slice
// is the whole of it.
export function list({ offset = 0, limit = null } = {}) {
  const page = limit === null ? chats.slice(offset) : chats.slice(offset, offset + limit)
  return {
    total: chats.length,
    chats: page.map((c) => ({
      id: c.id,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      questions: c.messages.filter((m) => m.role === 'user').length,
    })),
  }
}

export function get(id) {
  return chats.find((c) => c.id === id) || null
}

// The tail of a chat's messages, for the answer prompt and the retrieval
// query (see prompts.js). Returns [] for a new chat or an unknown id, so Ask
// never has to branch on whether a conversation exists yet.
//
// `sources` is deliberately dropped: each AI message snapshots the notes it
// cited, and replaying those into the prompt would put stale, unranked
// evidence beside the notes this turn actually retrieved.
export function recentMessages(id, turns = 3) {
  const chat = id ? get(id) : null
  if (!chat) return []
  return chat.messages.slice(-turns * 2).map((m) => ({ role: m.role, text: m.text || '' }))
}

// Append a question/answer pair, creating the chat when chatId is null.
// Returns the chat (most recently used chats float to the top).
export async function appendExchange(chatId, userMsg, aiMsg) {
  const now = new Date().toISOString()
  let chat = chatId ? chats.find((c) => c.id === chatId) : null
  if (!chat) {
    chat = {
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      title: (userMsg.text || 'Image question').slice(0, 80),
      messages: [],
    }
    chats.unshift(chat)
  }
  chat.messages.push({ ts: now, ...userMsg }, { ts: now, ...aiMsg })
  chat.updatedAt = now
  chats = [chat, ...chats.filter((c) => c.id !== chat.id)]
  upsertRow(await getDb(), chat)
  return chat
}

// Rename a conversation. The title is otherwise derived from the first
// question, which is a poor label for a thread that wandered.
export async function rename(id, title) {
  const chat = chats.find((c) => c.id === id)
  if (!chat) return null
  const next = String(title || '').trim().slice(0, 80)
  if (!next) return null
  chat.title = next
  chat.updatedAt = new Date().toISOString()
  upsertRow(await getDb(), chat)
  return chat
}

export async function remove(id) {
  const before = chats.length
  chats = chats.filter((c) => c.id !== id)
  const changed = chats.length !== before
  if (changed) (await getDb()).prepare('DELETE FROM chats WHERE id = ?').run(id)
  return changed
}
