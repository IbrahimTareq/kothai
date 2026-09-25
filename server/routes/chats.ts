import type { IncomingMessage, ServerResponse } from 'node:http'
import * as chats from '../data/chats.ts'
import { json, readBody } from '../lib/http.ts'
import { visibleTo } from './demo.ts'

// readBody hands back `unknown` — the body is whatever the client posted, and
// nothing has checked it. Narrowed here rather than annotated away.
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

const MAX_PAGE = 200

export function handleChats(res: ServerResponse, query: URLSearchParams, viewer: string | null): void {
  const num = (v: string | null, fallback: number) => (/^\d+$/.test(v ?? '') ? Number(v) : fallback)
  const offset = num(query?.get('offset'), 0)
  const limit = Math.min(num(query?.get('limit'), 0) || MAX_PAGE, MAX_PAGE)
  json(res, 200, chats.list({ offset, limit, keep: visibleTo(viewer) }))
}
export function handleChat(res: ServerResponse, id: string, viewer: string | null) {
  const chat = chats.get(id)
  return chat && visibleTo(viewer)(chat) ? json(res, 200, { chat }) : json(res, 404, { error: 'chat not found' })
}
// On the demo, a visitor may change only a chat they asked. Anyone else's
// answers exactly like a missing one.
const notMine = (viewer: string | null, id: string) => !!viewer && chats.get(id)?.visitor !== viewer

export async function handleRenameChat(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  viewer: string | null,
): Promise<void> {
  if (notMine(viewer, id)) return json(res, 404, { error: 'chat not found' })
  const body: unknown = await readBody(req)
  const chat = await chats.rename(id, isRecord(body) ? body.title : undefined)
  return chat
    ? json(res, 200, { chat: { id: chat.id, title: chat.title, updatedAt: chat.updatedAt } })
    : json(res, 400, { error: 'chat not found, or the title was empty' })
}
export async function handleDeleteChat(res: ServerResponse, id: string, viewer: string | null): Promise<void> {
  if (notMine(viewer, id)) return json(res, 404, { ok: false })
  const ok = await chats.remove(id)
  return json(res, ok ? 200 : 404, { ok })
}
