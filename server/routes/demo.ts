// The public demo's gate. Off unless KOTHAI_DEMO is set.
//
// Kothai is single-user, so a public demo is one library shared by every
// visitor. Left writable, a visitor could wipe it, re-point the inference
// endpoint, switch to an expensive model, or re-tag the whole library on the
// operator's key, and /api/setup/test would fetch any URL they typed from
// inside the host's network. So the shared library is read-only, and a visitor
// may save a link, ask a question and make a space, then change or delete
// what they made. Each of those handlers checks the thing is theirs.
import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { json } from '../lib/http.ts'
import { isSecureRequest, parseCookies } from '../lib/auth.ts'
import * as store from '../data/notes.ts'
import type { NoteRecord } from '../data/notes.ts'
import * as tagvocab from '../data/tagvocab.ts'
import * as chats from '../data/chats.ts'
import * as collections from '../data/collections.ts'
import { removeNote } from '../data/remove.ts'
import * as settings from '../data/settings.ts'
import { saveCapture } from '../capture.ts'
import { UPLOAD_DIR, getAiConfig } from '../config.ts'
import { ENDPOINTS } from '../ai/endpoints.ts'
import { EMBED_RECIPE } from '../ai/prompts.ts'

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
    /^\/api\/(notes|notes\/delta|tags|status|settings|chats|collections|enrich\/backlog|models\/files)$/,
    /^\/api\/(notes|chats)\/[^/]+$/,
  ],
  POST: [/^\/api\/(save|ask|collections)$/, /^\/api\/notes\/[^/]+\/retag$/, /^\/api\/collections\/[^/]+\/items$/],
  PATCH: [/^\/api\/(notes|chats|collections)\/[^/]+$/],
  DELETE: [/^\/api\/(notes|chats|collections)\/[^/]+$/, /^\/api\/collections\/[^/]+\/items\/[^/]+$/],
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
// tokens each; a save costs one classify and one embed. A space costs no
// inference, only a row, so its limit bounds clutter rather than the bill.
export const demoLimits = {
  save: allowance(5, 200),
  ask: allowance(10, 300),
  space: allowance(3, 300),
  // What this visitor has left today, as /api/status reports it to the client.
  leftFor: (visitor: string) => ({
    savesLeft: demoLimits.save.left(visitor),
    asksLeft: demoLimits.ask.left(visitor),
    spacesLeft: demoLimits.space.left(visitor),
  }),
}

// ---- nightly reset ----------------------------------------------------------
// Everything a visitor added goes; the shared library, which carries no
// visitor, stays. Run at boot and then daily (server/index.ts).
//
// The tag registry included: every tag in it came from a note's enrichment
// (tagvocab.ts), so the library's notes carry all of its own.
export async function resetDemo(): Promise<void> {
  for (const n of store.allNotes()) if (n.visitor) await removeNote(n.id)
  await tagvocab.clearAll(new Set(store.allNotes().flatMap(n => n.tags ?? [])))
  for (const c of chats.all()) if (c.visitor) await chats.remove(c.id)
  for (const c of collections.all()) if (c.visitor) await collections.remove(c.id)
  demoLimits.save.reset()
  demoLimits.ask.reset()
  demoLimits.space.reset()
}

// ---- a fresh deploy -----------------------------------------------------------
// A new demo has to work with nothing done by hand. The gate above refuses
// /api/setup, so a visitor could never finish the first-run screen, and an
// empty library leaves them nothing to ask about.

// Before the provider starts (server/index.ts), since it reads the model names
// once. Taken from the preset whose URL the endpoint is, so an operator sets
// only KOTHAI_AI_BASE_URL and its key; an endpoint with no preset is left for
// them, as are models already chosen.
export async function configureDemo(): Promise<void> {
  if (settings.getRemote().llm) return
  const preset = ENDPOINTS.find(e => e.baseUrl === getAiConfig().baseUrl)
  if (!preset) return
  await settings.save({ configured: true, remote: preset.defaults })
}

// After the provider starts, so each save's enrichment has a model to run on.
// Only into an empty library: with a volume, the second boot finds the first
// one's library, and it costs a classify and an embed a line to build.
//
// The live seed is the fallback. With no volume, as on Railway, every deploy
// built the library from nothing: every link fetched, and a classify, a vision
// call and an embed per note, over a minute before the grid had its pictures
// and on the operator's key each time. So a prebuilt one (`snapshot`, made by
// scripts/demo-snapshot.ts) is restored instead whenever it still matches.
export async function seedDemo({ snapshot = SNAPSHOT }: { snapshot?: URL } = {}): Promise<void> {
  if (store.count() > 0) return
  const list = await readFile(new URL('../demo-library.txt', import.meta.url), 'utf8')
  if (!(await restoreSnapshot(snapshot, list))) {
    for (const line of list.split('\n')) {
      const url = line.trim()
      if (url && !url.startsWith('#')) await saveCapture({ url })
    }
  }
  await seedSpaces()
}

// The shared spaces, each named with the links of demo-library.txt it holds.
// Without them Spaces opened on "No spaces yet", and a visitor saw a space, or
// its canvas, only once they had made one and found links to put in it.
const SPACES: [string, string[]][] = [
  [
    'Kyoto trip',
    [
      'https://en.wikipedia.org/wiki/Kyoto',
      'https://en.wikipedia.org/wiki/T%C5%8Dfuku-ji',
      'https://www.japan-guide.com/e/e3915.html',
    ],
  ],
  [
    'Weekend baking',
    [
      'https://en.wikipedia.org/wiki/Sourdough',
      'https://www.kingarthurbaking.com/recipes/sourdough-starter-recipe',
      'https://www.kingarthurbaking.com/recipes/classic-sandwich-bread-recipe',
      'https://www.bbcgoodfood.com/recipes/best-ever-chocolate-brownies-recipe',
    ],
  ],
  [
    'Design reading',
    [
      'https://www.nngroup.com/articles/ten-usability-heuristics/',
      'https://lawsofux.com/',
      'https://www.vitsoe.com/us/about/good-design',
      'https://www.joshwcomeau.com/css/interactive-guide-to-flexbox/',
    ],
  ],
]

async function seedSpaces() {
  const byUrl = new Map(store.allNotes().map(n => [n.url, n.id]))
  // Last first: each new space goes on top, so the list reads as written.
  for (const [name, urls] of [...SPACES].reverse()) {
    const c = await collections.create({ name })
    await collections.addItems(
      c.id,
      urls.flatMap(u => byUrl.get(u) ?? []),
    )
  }
}

// ---- the prebuilt library -------------------------------------------------------
// scripts/demo-snapshot.ts writes library.json and uploads/ here: every note as
// enrichment left it, its vector and the tag registry's as base64 float32.
const SNAPSHOT = new URL('../demo-seed/', import.meta.url)

interface Snapshot {
  library: string // the demo-library.txt it was built from
  embed: string // the embedding model its vectors came from
  recipe: string // ai/prompts.ts's EMBED_RECIPE when it was built
  notes: (Omit<NoteRecord, 'embedding'> & { embedding: string })[] // oldest first
  tags: Record<string, string>
}

const vector = (b64: string) => store.decodeEmbedding(Buffer.from(b64, 'base64'))

async function restoreSnapshot(dir: URL, list: string): Promise<boolean> {
  let snap: Snapshot
  try {
    snap = JSON.parse(await readFile(new URL('library.json', dir), 'utf8'))
  } catch {
    return false // never built: the live seed is all there is
  }
  // Any of these and the vectors, or the cards themselves, are not what a live
  // seed would build now, and search would quietly compare across two spaces.
  const stale =
    snap.library !== list
      ? 'demo-library.txt has changed since'
      : snap.embed !== settings.getRemote().embed
        ? `its vectors are from ${snap.embed}`
        : snap.recipe !== EMBED_RECIPE
          ? `its vectors are from embedding recipe ${snap.recipe}`
          : null
  if (stale) {
    console.warn(`[demo] not using the prebuilt library (${stale}); seeding live. Rebuild it: scripts/demo-snapshot.ts`)
    return false
  }
  await mkdir(UPLOAD_DIR, { recursive: true })
  await cp(new URL('uploads/', dir), UPLOAD_DIR, { recursive: true })
  // The registry as it was, not rebuilt from the notes' tags: an account tag
  // never goes through canonicalize, so it has no vector here to restore.
  await tagvocab.rebuildFromNotes([{ tags: Object.keys(snap.tags) }], {
    embed: async tag => Array.from(vector(snap.tags[tag]) ?? []),
  })
  for (const { embedding, ...note } of snap.notes)
    await store.addNote({ ...note, embedding: vector(embedding) }, { persist: false })
  await store.flush()
  return true
}
