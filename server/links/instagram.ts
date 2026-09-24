// Instagram posts: metadata from the public embed page, the throttle that
// keeps a bulk import from getting the IP soft-banned, and carousel slides.
// fetchLinkMeta in meta.ts hands every Instagram post URL straight here.
import { MAX_HTML, decodeEntities, get, isSafeFetchUrl, saveThumb, saveThumbSafe } from './fetch.ts'

// instagram.com serves a login wall to anonymous og-scrapes, so posts get
// their metadata from the public /embed/captioned/ page instead (caption +
// thumbnail, usually served without auth). Best-effort with a hard throttle:
// imports can queue hundreds of these, and hammering Meta gets the IP
// soft-banned.

export function isInstagramPost(url: string): boolean {
  try {
    const u = new URL(url)
    return /(^|\.)instagram\.com$/.test(u.hostname) && /^\/(p|reels?|tv)\//.test(u.pathname)
  } catch {
    return false
  }
}

// Built from origin+pathname rather than string-concatenating onto the raw
// URL: a naive `url.replace(/\/?$/, '/') + 'embed/'` mangles any URL that
// carries a query string (e.g. the `?igsh=...` share-link param Instagram
// appends by default) — 'https://ig.com/p/ABC/?igsh=x' becomes
// '.../?igsh=x/embed/', which 404s. Dropping query/fragment and rebuilding
// from the parsed parts sidesteps that entirely.
//
// Targets /embed/captioned/ specifically, not /embed/: the plain /embed/
// page renders the media and chrome but does NOT emit the <div
// class="Caption"> block parseInstagramEmbed looks for (that's the variant
// IG's own embed.js requests for data-instgrm-captioned) — the thumbnail
// would still work off plain /embed/, but every caption would silently come
// back null. A trailing /embed/ or /embed/captioned/ segment is stripped
// first so pasting an embed link back in (isInstagramPost matches those
// too, since they still start with /p/, /reel/, /tv/) doesn't produce
// .../embed/embed/captioned/.
// Returns null for non-URL input since this is exported and may see
// arbitrary strings.
export function instagramEmbedUrl(url: string): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  // Anchored to a leading '/' so this only strips an actual /embed/ or
  // /embed/captioned/ PATH SEGMENT — not just a trailing "embed/" substring.
  // Without the leading `\/`, a shortcode that happens to end in "embed"
  // (e.g. /p/Cxyzembed/) would have "embed/" chopped out of the middle of
  // it, corrupting the shortcode and 404ing silently.
  const pathname = u.pathname.replace(/\/?$/, '/').replace(/\/embed\/(?:captioned\/)?$/, '/')
  return `${u.origin}${pathname}embed/captioned/`
}

// True if `attrs` (the raw text of one HTML start tag) has `token` as one of
// its space-separated class names. Deliberately not a bare `\btoken\b`
// against the whole tag: Meta rewrites this markup often, and a plain
// word-boundary match is one adjacent-class-name away from either missing
// the real token or drifting onto an unrelated one (e.g. distinguishing
// "Caption" from "CaptionUsername"/"CaptionComments" reliably needs an
// actual token split, not just \b). Tolerates single or double quotes and
// any attribute order since it searches the whole tag text.
function hasClassToken(attrs: string, token: string): boolean {
  const m = /\sclass=["']([^"']*)["']/i.exec(attrs)
  return !!m && m[1].split(/\s+/).includes(token)
}

// Finds the first <tagName> start tag carrying `classToken` as one of its
// classes, tolerant of attribute order/quoting/extra classes (see
// hasClassToken). Returns the raw tag text, or null.
function findTagWithClass(html: string, tagName: string, classToken: string): string | null {
  const re = new RegExp(`<${tagName}\\b[^>]*>`, 'gi')
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (hasClassToken(m[0], classToken)) return m[0]
  }
  return null
}

// What the embed page yields: the three pieces the post's own markup carries.
// `location` is optional in practice (see below), the other two are what a
// successful parse is judged on — describeMissingPieces names whichever is
// missing.
export interface InstagramEmbed {
  caption: string | null
  thumbUrl: string | null
  location: string | null
}

// Pure html → { caption, thumbUrl, location } (exported for tests; no network).
export function parseInstagramEmbed(html: string): InstagramEmbed {
  const imgTag = findTagWithClass(html, 'img', 'EmbeddedMediaImage')
  const src = imgTag ? /\ssrc=["']([^"']+)["']/i.exec(imgTag) : null

  const capTag = findTagWithClass(html, 'div', 'Caption')
  let caption: string | null = null
  if (capTag) {
    const start = html.indexOf(capTag) + capTag.length
    // The real embed page nests a <div class="CaptionComments"> ("View all
    // N comments") INSIDE the Caption block, immediately after the text —
    // so a caption ending in hashtags/links (the common case) has that
    // boilerplate start right where the caption text ends. Stopping at the
    // first </div> alone lands inside CaptionComments, bleeding "View all
    // N comments" into the extracted caption. Stopping at CaptionComments'
    // own start (when present) avoids that; any OTHER unexpected nested
    // <div> still just truncates at the first </div> as before — a
    // truncated-but-present caption beats no caption at all for the
    // login-wall case this exists to work around.
    const rest = html.slice(start)
    const commentsTag = findTagWithClass(rest, 'div', 'CaptionComments')
    const commentsStart = commentsTag ? start + rest.indexOf(commentsTag) : -1
    const closeDiv = html.indexOf('</div>', start)
    const end = commentsStart !== -1 && (closeDiv === -1 || commentsStart < closeDiv) ? commentsStart : closeDiv
    if (end !== -1) {
      const inner = html.slice(start, end)
      caption = decodeEntities(inner.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).trim() || null
    }
  }

  // The tagged location (if the poster attached one) is exact, structured
  // data Instagram already hands us — a real place name, not a guess a
  // vision/LLM model has to infer. Optional: most posts carry no location
  // tag at all, so unlike caption/thumbnail this is never treated as a
  // "missing piece" — its absence is normal, not a parse failure.
  const locTag = findTagWithClass(html, 'a', 'Location')
  let location: string | null = null
  if (locTag) {
    const start = html.indexOf(locTag) + locTag.length
    const end = html.indexOf('</a>', start)
    if (end !== -1) {
      location = decodeEntities(html.slice(start, end).replace(/<[^>]+>/g, '')).trim() || null
    }
  }

  const thumbUrl = src?.[1] ? decodeEntities(src[1]) : null
  return { caption, thumbUrl, location }
}

// Pure caption → { siteTitle, siteDesc } truncation, split out so the ≤120 /
// ≤2000 char limits are testable without a network call.
export function captionToMeta(caption: string): { siteTitle: string; siteDesc: string } {
  return {
    siteTitle: caption.split('\n')[0].slice(0, 120),
    siteDesc: caption.slice(0, 2000),
  }
}

// Pure delay math, split out from igThrottle so it's testable without real
// timers or mutating module state. lastFetch=0 (module hasn't fetched IG yet
// this session) always yields <=0: the first fetch of a session never waits.
export function nextIgFetchDelay(now: number, lastFetch: number, jitter = 0): number {
  return Math.max(0, lastFetch + 2500 + jitter - now)
}

// >=2.5s + jitter between Instagram fetches. Module-level state is fine here:
// callers (enrich.ts's dedicated Instagram meta queue, one job at a time)
// serialize every Instagram fetch onto a single FIFO, so two Instagram
// fetches never run concurrently and never race this variable.
let lastIgFetch = 0
async function igThrottle() {
  const wait = nextIgFetchDelay(Date.now(), lastIgFetch, Math.floor(Math.random() * 500))
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
  lastIgFetch = Date.now()
}

// Pure: names which piece(s) parseInstagramEmbed came back without, or null
// if both are present (exported so this — the `||` vs `&&` distinction —
// is directly testable without mocking console or the network). `||`, not
// `&&`: a fetch that finds the thumbnail but not the caption (e.g. Meta
// drops the Caption block from the markup, as MUST FIX 1 was) is exactly
// the failure mode this needs to catch — it looks like a partial success (a
// thumbnail still shows on the card), so it's the one case a "both missing"
// check would stay silent on.
export function describeMissingPieces(caption: string | null, thumbUrl: string | null): string | null {
  if (caption && thumbUrl) return null
  return [!caption && 'caption', !thumbUrl && 'thumbnail'].filter(Boolean).join(' and ')
}

// Prepend the tagged location (if any) to a caption's siteDesc, re-capped at
// captionToMeta's 2000-char limit. Pure, split out for testability — exact
// structured data (a real place name) is worth surfacing even when there's
// no caption at all to attach it to.
// Generic over the meta it is handed rather than tied to InstagramMeta: it
// reads and rewrites one field and copies the rest, so the caller's shape —
// the full Instagram meta in fetchInstagramMeta, a two-field object in the
// tests — comes back out unchanged rather than widened.
export function withLocation<T extends { siteDesc: string | null }>(meta: T, location: string | null): T {
  if (!location) return meta
  const siteDesc = [location, meta.siteDesc].filter(Boolean).join('\n\n').slice(0, 2000)
  return { ...meta, siteDesc }
}

// What an Instagram post contributes. No `article` and no `author`: the embed
// page carries a caption and a picture and nothing else, and the handle comes
// off the export instead (see fetchLinkMeta's author note). siteName is always
// the literal 'Instagram' — nothing here can report anything else.
export interface InstagramMeta {
  siteTitle: string | null
  siteDesc: string | null
  siteName: string
  thumb: string | null
}

export async function fetchInstagramMeta(url: string, noteId: string): Promise<InstagramMeta> {
  await igThrottle()
  const embedUrl = instagramEmbedUrl(url)
  // Unreachable: the only caller reaches here past isInstagramPost(), which
  // already parsed this URL, and instagramEmbedUrl returns null only for a
  // string that is not a URL at all. The check is here because the type
  // cannot say that — and it throws rather than skipping, which is what the
  // untyped version did anyway (get(null) built 'null' as a URL and threw).
  if (!embedUrl) throw new Error(`not a URL: ${url}`)
  // Same MAX_HTML-after-.text() tradeoff as the generic HTML branch in meta.ts:
  // the whole body is buffered into memory before slicing. Matching existing
  // behavior rather than introducing a streaming reader just for this path.
  const html = (await (await get(embedUrl, 'text/html,*/*')).text()).slice(0, MAX_HTML)
  const { caption, thumbUrl, location } = parseInstagramEmbed(html)
  const missing = describeMissingPieces(caption, thumbUrl)
  if (missing) console.warn(`[meta] instagram embed parse missing ${missing} for`, url)
  let meta: InstagramMeta = { siteTitle: null, siteDesc: null, siteName: 'Instagram', thumb: null }
  if (caption) {
    // Only siteDesc is kept — captionToMeta's siteTitle is just the caption's
    // FIRST LINE, which for a real Instagram caption is almost always the
    // poster's username (see parseInstagramEmbed's CaptionUsername handling),
    // not a real title. The client prefers `note.siteTitle` over the LLM's
    // generated `note.title` for card display (mapNote in client/data/api.ts)
    // — so setting siteTitle here would show the handle instead of a real
    // title on every Instagram card. Leaving it unset lets a real generated
    // title through; the username itself is still in siteDesc (the full
    // caption, username line included) so classify() still sees it.
    meta.siteDesc = captionToMeta(caption).siteDesc
  }
  meta = withLocation(meta, location)
  if (thumbUrl) Object.assign(meta, await saveThumbSafe(thumbUrl, url, noteId))
  return meta
}

// ---- Instagram carousels ------------------------------------------------
// A multi-photo ("sidecar") post renders only its FIRST slide as an <img> on
// the embed page — that one image is what parseInstagramEmbed picks up for the
// card thumbnail. The rest of the slides are in the page's embedded
// `edge_sidecar_to_children` JSON blob, which reaches us double-escaped (it is
// a JSON string inside a JSON string inside HTML): a slide URL sits in the raw
// text as `display_url\":\"https:\\\/\\\/…`. Rather than try to locate and
// parse that whole blob — Meta reshapes the surrounding structure often — this
// scrapes the `display_url` values directly and unescapes each one.
const MAX_SLIDES = 20

// Undo the double escaping on one captured URL. Order matters: \uXXXX first, so
// `\u00253D` becomes `%3D` (and not a stray `%` next to an orphaned `3D`),
// then escaped slashes, then anything left over.
export function unescapeEmbedUrl(raw: string): string {
  return raw
    .replace(/\\+$/, '')
    .replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\+\//g, '/')
    .replace(/\\+/g, '')
}

// Pure html → ordered slide URLs, empty for a single-image post (exported for
// tests; no network). The capture runs to the next bare `"` — a slide URL never
// contains one, since the quote that ends it is itself escaped — and document
// order is post order.
//
// Scoped to the text from `edge_sidecar_to_children` onward, because
// `display_url` is not unique to slides: the top-level media node carries one
// (the post cover, normally a duplicate of slide one) BEFORE the sidecar block,
// and the profile hover-card further down the page carries thumbnails of the
// account's OTHER posts. Anchoring past the sidecar key excludes the cover, and
// the hover-card images are plain `src=` attributes this pattern never matches.
export function parseInstagramCarousel(html: string): string[] {
  const at = html.indexOf('edge_sidecar_to_children')
  if (at === -1) return []
  const re = /display_url\\*"\s*:\s*\\*"([^"]+)/g
  re.lastIndex = at
  const out: string[] = []
  const seen = new Set<string>()
  for (let m = re.exec(html); m && out.length < MAX_SLIDES; m = re.exec(html)) {
    const url = unescapeEmbedUrl(m[1])
    if (!isSafeFetchUrl(url) || seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}

// Download every slide of a carousel post to /uploads. Returns local web paths
// in post order. One slide failing to download is survivable — a short deck
// beats no deck — but a slide that fails is dropped rather than left as a hole.
export async function fetchInstagramSlides(url: string, noteId: string): Promise<string[]> {
  await igThrottle()
  const embedUrl = instagramEmbedUrl(url)
  // Unreachable, and thrown rather than skipped — see fetchInstagramMeta.
  if (!embedUrl) throw new Error(`not a URL: ${url}`)
  const html = (await (await get(embedUrl, 'text/html,*/*')).text()).slice(0, MAX_HTML)
  const slides: string[] = []
  for (const [i, src] of parseInstagramCarousel(html).entries()) {
    try {
      const local = await saveThumb(new URL(src, url).href, `${noteId}-${i}`)
      if (local) slides.push(local.thumb)
    } catch {
      /* one unreachable slide shouldn't sink the rest of the deck */
    }
  }
  return slides
}
