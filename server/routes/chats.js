import * as chats from '../data/chats.js'
import { json, readBody } from '../lib/http.js'

const MAX_PAGE = 200

export function handleChats(res, query) {
  const num = (v, fallback) => (/^\d+$/.test(v ?? '') ? Number(v) : fallback)
  const offset = num(query?.get('offset'), 0)
  const limit = Math.min(num(query?.get('limit'), 0) || MAX_PAGE, MAX_PAGE)
  json(res, 200, chats.list({ offset, limit }))
}
export function handleChat(res, id) {
  const chat = chats.get(id)
  return chat ? json(res, 200, { chat }) : json(res, 404, { error: 'chat not found' })
}
export async function handleRenameChat(req, res, id) {
  const body = await readBody(req)
  const chat = await chats.rename(id, body.title)
  return chat
    ? json(res, 200, { chat: { id: chat.id, title: chat.title, updatedAt: chat.updatedAt } })
    : json(res, 400, { error: 'chat not found, or the title was empty' })
}
export async function handleDeleteChat(res, id) {
  const ok = await chats.remove(id)
  return json(res, ok ? 200 : 404, { ok })
}
