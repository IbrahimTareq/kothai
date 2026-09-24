// The public demo's gate. Off unless KOTHAI_DEMO is set.
//
// Kothai is single-user, so a public demo is one library shared by every
// visitor. Left writable, a visitor could wipe it, re-point the inference
// endpoint, switch to an expensive model, or re-tag the whole library on the
// operator's key, and /api/setup/test would fetch any URL they typed from
// inside the host's network. So the demo is read-only apart from the two
// things it exists to show: saving a link and asking a question.
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { json } from '../lib/http.ts'
import { isSecureRequest, parseCookies } from '../lib/auth.ts'
import * as store from '../data/notes.ts'
import * as chats from '../data/chats.ts'
import { removeNote } from '../data/remove.ts'

// Read here rather than in config.ts, which holds paths and the port: this
// module is where the demo lives, and every later demo check imports it from
// here. The same narrow spellings as KOTHAI_ALLOW_PRIVATE_FETCH, so a value of
// 0 or false reads as off rather than on.
export const DEMO = ['1', 'true'].includes((process.env.KOTHAI_DEMO || '').toLowerCase())

// An allowlist, not a denylist. GET /api/export and /api/backup hand over the
// whole library, so "every GET is safe" is already false, and a route added
// later must not reach the public demo because nobody remembered to list it.
const ALLOWED: Record<string, RegExp[]> = {
  GET: [
    /^\/api\/(notes|notes\/delta|status|settings|chats|collections|enrich\/backlog|models\/files)$/,
    /^\/api\/(notes|chats)\/[^/]+$/,
  ],
  POST: [/^\/api\/(save|ask)$/],
}

// True when it has answered the request itself. Only /api/ is gated: the app
// shell and /uploads are what a visitor comes to see.
export function demoGate(req: IncomingMessage, res: ServerResponse, p: string): boolean {
  if (!p.startsWith('/api/')) return false
  if (ALLOWED[req.method ?? '']?.some(re => re.test(p))) return false
  json(res, 403, { error: 'Not available in the demo.', code: 'demo' })
  return true
}

// ---- visitors ---------------------------------------------------------------
// Each visitor's links are theirs alone. One library shared by everyone would
// put every stranger's test link, and anything worse, in front of the next
// visitor until the nightly reset.
//
// The id is a random uuid in a cookie, not a login: knowing it is what makes
// you that visitor, the way a session token works. Nothing else is accepted,
// so a hand-written cookie is simply replaced with a new id.
const VISITOR_COOKIE = 'kothai_visitor'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const VISITOR_MAX_AGE_SEC = 30 * 24 * 60 * 60

// Typed like routes/auth.ts's GateRequest, for the same reason: `encrypted`
// lives on a TLS socket, which a plain IncomingMessage does not declare.
export function visitorOf(req: IncomingMessage & { socket: { encrypted?: boolean } }, res: ServerResponse): string {
  const held = parseCookies(req.headers.cookie)[VISITOR_COOKIE]
  if (held && UUID.test(held)) return held
  const id = randomUUID()
  // HttpOnly and SameSite=Lax for the same reasons as the session cookie in
  // lib/auth.ts, and Secure only when the request was, or a demo served over
  // plain HTTP would drop it and hand every request a new visitor.
  const bits = [`${VISITOR_COOKIE}=${id}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${VISITOR_MAX_AGE_SEC}`]
  if (isSecureRequest(req)) bits.push('Secure')
  res.setHeader('Set-Cookie', bits.join('; '))
  return id
}

// Whether a note or chat is shown to this viewer: the shared library (no
// visitor) to everyone, a visitor's own to them alone. On an ordinary install
// the viewer is null and nothing carries a visitor, so everything is shown.
export const visibleTo =
  (viewer: string | null) =>
  (item: { visitor?: string }): boolean =>
    !item.visitor || item.visitor === viewer

// ---- limits -----------------------------------------------------------------
// Per visitor cookie, not per IP: behind a PaaS proxy every visitor arrives
// from the proxy's address, and x-forwarded-for is not trusted (routes/auth.ts
// says why), so a per-IP bucket would be one bucket for everyone. A visitor who
// clears cookies does get a fresh allowance, which is why each limit also has a
// daily total across every visitor: that total bounds the inference bill,
// whatever anyone does with cookies. Both start again at the nightly reset.
function allowance(perVisitor: number, perDay: number) {
  const used = new Map<string, number>()
  let total = 0
  return {
    take(visitor: string): boolean {
      const mine = used.get(visitor) ?? 0
      if (mine >= perVisitor || total >= perDay) return false
      used.set(visitor, mine + 1)
      total++
      return true
    },
    left(visitor: string): number {
      return Math.max(0, Math.min(perVisitor - (used.get(visitor) ?? 0), perDay - total))
    },
    reset() {
      used.clear()
      total = 0
    },
  }
}

// 300 questions is about 30 cents a day on a gpt-4o-mini-class model at ~4k
// tokens each; a save costs one classify and one embed.
export const demoLimits = { save: allowance(5, 200), ask: allowance(10, 300) }

// ---- nightly reset ----------------------------------------------------------
// Everything a visitor added goes; the shared library, which carries no
// visitor, stays. Run at boot and then daily (server/index.ts).
export async function resetDemo(): Promise<void> {
  for (const n of store.allNotes()) if (n.visitor) await removeNote(n.id)
  for (const c of chats.all()) if (c.visitor) await chats.remove(c.id)
  demoLimits.save.reset()
  demoLimits.ask.reset()
}
