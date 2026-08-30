// Link/video metadata: fetched once when a note is enriched (oEmbed where the
// provider registry knows the URL, OpenGraph tags for everything else), with
// the thumbnail downloaded into data/uploads — so cards show real titles and
// previews without ever hitting the network again.
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import { findProvider } from '@extractus/oembed-extractor'
import {
  fetchTranscript,
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptNotAvailableError,
  YoutubeTranscriptNotAvailableLanguageError,
  YoutubeTranscriptVideoUnavailableError,
} from 'youtube-transcript'
import { UPLOAD_DIR } from '../data/notes.js'
import { safeFetch } from '../lib/ssrf.js'

const FETCH_TIMEOUT_MS = 8000
const MAX_HTML = 1024 * 1024 // only scan the first 1 MB for meta tags
const MAX_THUMB = 5 * 1024 * 1024
const MAX_ARTICLE = 8000 // chars of extracted body text persisted per note
const MIN_ARTICLE = 200 // below this it's a paywall/cookie-wall stub, not content
const UA = 'Mozilla/5.0 (compatible; Kothai/1.0; local notes app)'

// A cheap synchronous http(s)-only check, used to filter scraped URL lists
// (parseInstagramCarousel) before any of them is worth a fetch. It says nothing
// about where a URL points — http://169.254.169.254 passes it — so it is a
// pre-filter, never the guard. safeFetch() below is the guard.
export function isSafeFetchUrl(url) {
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol)
  } catch {
    return false
  }
}

// The one outbound fetch in the whole server: every og:image scrape, oEmbed
// lookup, Instagram embed page and thumbnail download goes through here, and
// all of those URLs come from content the user did not write. safeFetch applies
// the SSRF guard (see server/lib/ssrf.js) to this URL and to every redirect hop.
//
// One AbortSignal covers the entire redirect chain rather than each hop, so a
// server that redirects slowly forever still cannot hold a request open past
// FETCH_TIMEOUT_MS.
//
// Exported so tests can assert the guard is actually wired in here, not just
// that the predicates themselves are correct.
export async function get(url, accept) {
  const res = await safeFetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'User-Agent': UA, Accept: accept },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res
}

function decodeEntities(s) {
  return (s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
}

// <meta property="og:title" content="..."> (handles either attribute order)
function metaTag(html, prop) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, 'i')
  const m = re.exec(html)
  if (!m) return null
  const c = /content=["']([^"']*)["']/i.exec(m[0])
  return c?.[1] ? decodeEntities(c[1]).trim() : null
}

function titleTag(html) {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html)
  return m?.[1] ? decodeEntities(m[1]).trim() : null
}

// ---- oEmbed --------------------------------------------------------------
// oEmbed gives clean JSON (title, author, thumbnail) without scraping. Which
// URLs have an oEmbed endpoint is a ~300-entry registry that churns
// constantly as providers come and go — the one part of this module that is
// genuinely somebody else's maintenance burden, so it is the one place a
// dependency earns its keep in an otherwise dependency-free server. The
// hand-rolled table this replaces covered exactly two providers (YouTube and
// Vimeo); the registry brings TikTok — whose oEmbed hands back the video
// caption as `title` plus a thumbnail, the two things a saved TikTok
// otherwise has no way of getting — along with Reddit, Bluesky, Spotify,
// SoundCloud, Flickr and the rest.
//
// Only PROVIDER DISCOVERY is delegated. The package's own extract() does its
// own fetching, which would route around safeFetch and the SSRF guard, so
// this takes the endpoint and fetches it through get() like every other
// outbound call in the server.
//
// Instagram post/reel/tv URLs never reach here — fetchLinkMeta short-circuits
// to the bespoke embed-page pipeline first. Other instagram.com URLs (a bare
// profile link) would, and the registry does list them, pointing at Meta's
// graph.facebook.com endpoint — which requires an app access token and
// answers an anonymous caller with a 400/401 every single time. Skipping it
// costs nothing (the OpenGraph scrape below is what actually runs for those
// URLs either way) and saves an unauthenticated round-trip to the one domain
// this module is careful not to hammer.
const AUTHED_OEMBED_HOSTS = ['graph.facebook.com']

// Pure: url → the oEmbed API URL to call, or null when no provider matches
// (exported for tests; no network).
export function oembedEndpoint(url) {
  if (!isSafeFetchUrl(url)) return null
  const provider = findProvider(url)
  if (!provider) return null
  try {
    // URL + searchParams rather than string concatenation: a handful of
    // registry endpoints already carry a query string of their own (e.g.
    // hearthis.at's `/oembed/?format=json`), which a naive `?url=` append
    // would corrupt into a second question mark.
    const api = new URL(provider.endpoint)
    if (AUTHED_OEMBED_HOSTS.includes(api.hostname)) return null
    api.searchParams.set('url', url)
    api.searchParams.set('format', 'json')
    return api.href
  } catch {
    return null
  }
}

// ---- Instagram ---------------------------------------------------------
// instagram.com serves a login wall to anonymous og-scrapes, so posts get
// their metadata from the public /embed/captioned/ page instead (caption +
// thumbnail, usually served without auth). Best-effort with a hard throttle:
// imports can queue hundreds of these, and hammering Meta gets the IP
// soft-banned.

export function isInstagramPost(url) {
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
export function instagramEmbedUrl(url) {
  let u
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
function hasClassToken(attrs, token) {
  const m = /\sclass=["']([^"']*)["']/i.exec(attrs)
  return !!m && m[1].split(/\s+/).includes(token)
}

// Finds the first <tagName> start tag carrying `classToken` as one of its
// classes, tolerant of attribute order/quoting/extra classes (see
// hasClassToken). Returns the raw tag text, or null.
function findTagWithClass(html, tagName, classToken) {
  const re = new RegExp(`<${tagName}\\b[^>]*>`, 'gi')
  let m
  while ((m = re.exec(html))) {
    if (hasClassToken(m[0], classToken)) return m[0]
  }
  return null
}

// Pure html → { caption, thumbUrl, location } (exported for tests; no network).
export function parseInstagramEmbed(html) {
  const imgTag = findTagWithClass(html, 'img', 'EmbeddedMediaImage')
  const src = imgTag ? /\ssrc=["']([^"']+)["']/i.exec(imgTag) : null

  const capTag = findTagWithClass(html, 'div', 'Caption')
  let caption = null
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
  let location = null
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
export function captionToMeta(caption) {
  return {
    siteTitle: caption.split('\n')[0].slice(0, 120),
    siteDesc: caption.slice(0, 2000),
  }
}

// Pure delay math, split out from igThrottle so it's testable without real
// timers or mutating module state. lastFetch=0 (module hasn't fetched IG yet
// this session) always yields <=0: the first fetch of a session never waits.
export function nextIgFetchDelay(now, lastFetch, jitter = 0) {
  return Math.max(0, lastFetch + 2500 + jitter - now)
}

// >=2.5s + jitter between Instagram fetches. Module-level state is fine here:
// callers (enrich.js's dedicated Instagram meta queue, one job at a time)
// serialize every Instagram fetch onto a single FIFO, so two Instagram
// fetches never run concurrently and never race this variable.
let lastIgFetch = 0
async function igThrottle() {
  const wait = nextIgFetchDelay(Date.now(), lastIgFetch, Math.floor(Math.random() * 500))
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
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
export function describeMissingPieces(caption, thumbUrl) {
  if (caption && thumbUrl) return null
  return [!caption && 'caption', !thumbUrl && 'thumbnail'].filter(Boolean).join(' and ')
}

// Prepend the tagged location (if any) to a caption's siteDesc, re-capped at
// captionToMeta's 2000-char limit. Pure, split out for testability — exact
// structured data (a real place name) is worth surfacing even when there's
// no caption at all to attach it to.
export function withLocation(meta, location) {
  if (!location) return meta
  const siteDesc = [location, meta.siteDesc].filter(Boolean).join('\n\n').slice(0, 2000)
  return { ...meta, siteDesc }
}

async function fetchInstagramMeta(url, noteId) {
  await igThrottle()
  const embedUrl = instagramEmbedUrl(url)
  // Same MAX_HTML-after-.text() tradeoff as the generic HTML branch below:
  // the whole body is buffered into memory before slicing. Matching existing
  // behavior rather than introducing a streaming reader just for this path.
  const html = (await (await get(embedUrl, 'text/html,*/*')).text()).slice(0, MAX_HTML)
  const { caption, thumbUrl, location } = parseInstagramEmbed(html)
  const missing = describeMissingPieces(caption, thumbUrl)
  if (missing) console.warn(`[meta] instagram embed parse missing ${missing} for`, url)
  let meta = { siteTitle: null, siteDesc: null, siteName: 'Instagram', thumb: null }
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
  if (thumbUrl) {
    try {
      meta.thumb = await saveThumb(new URL(thumbUrl, url).href, noteId)
    } catch {
      /* no thumbnail is fine */
    }
  }
  return meta
}

// ---- Reddit -------------------------------------------------------------
// Reddit serves a full JSON rendering of any post at the same URL with
// `.json` appended — no API key, no OAuth, no package. That payload carries
// the selftext and the comment thread, which is the whole substance of a
// Reddit save.
//
// It is also, as of testing this against the live site, walled: www and
// api.reddit.com answer an anonymous request with 403, and old.reddit
// redirects to a login page. The plain HTML page is no better — Reddit serves
// a shell with `<title>Reddit</title>` and no og: tags at all to a
// non-browser client. The one route still open is Reddit's own oEmbed
// endpoint, which the provider registry already resolves and which returns
// the post title and author.
//
// So this is written to DEGRADE rather than to succeed or fail: it tries the
// rich JSON first and, on any failure, hands the URL back to the generic
// oEmbed + OpenGraph path below. A Reddit save then gets its real title
// instead of nothing, and if Reddit ever reopens the endpoint — or the
// operator runs somewhere it is not blocked — the full body and comments
// come back with no further change. Throwing instead would leave the note
// with no metadata whatsoever AND burn its five metaTries retries on a wall
// that is not going to move.
//
// No dedicated throttle here, unlike Instagram: link enrichment runs one job
// at a time on the FIFO chain (see enrich.js), and Reddit saves are a trickle
// rather than the bulk imports that made Instagram's 2.5s spacing necessary.

export function isRedditPost(url) {
  try {
    const u = new URL(url)
    // Matches /r/<sub>/comments/<id>/... and the bare /comments/<id> form,
    // on reddit.com and its subdomains (old., new., np., www.).
    return /(^|\.)reddit\.com$/.test(u.hostname) && /(^|\/)comments\/[^/]+/.test(u.pathname)
  } catch {
    return false
  }
}

// Reddit's share sheet hands out /r/<sub>/s/<id> links, and those — not the
// canonical /comments/ ones — are what actually gets pasted in from the mobile
// apps. Nothing below recognises them: the oEmbed registry's pattern wants
// /comments/, and `<share-link>.json` is not a rendering of anything, so the
// whole Reddit path is skipped and the note is left titled "Reddit" by the
// shell page's <title>. They are plain redirects to the canonical post, so one
// redirect-following request turns a share link back into a URL every path
// here already handles.
//
// The share segment has to be the LAST one: a subreddit can be named `s`, and
// `/r/s/comments/<id>/...` is an ordinary post URL, not a share link.
export function isRedditShare(url) {
  try {
    const u = new URL(url)
    return /(^|\.)reddit\.com$/.test(u.hostname) && /\/s\/[^/]+\/?$/.test(u.pathname)
  } catch {
    return false
  }
}

// Follows a share link and returns the canonical post URL, minus the share_id
// and utm_* params Reddit appends (they are tracking, and they would end up in
// the oEmbed lookup key). Returns null when it does not resolve to a post — a
// share link to a subreddit or a profile, or a dead id — so the caller can fall
// back to the URL it already had.
export async function resolveRedditShare(url) {
  try {
    const res = await get(url, 'text/html,*/*')
    const u = new URL(res.url)
    const canonical = `${u.origin}${u.pathname}`
    return isRedditPost(canonical) ? canonical : null
  } catch {
    return null
  }
}

// Built from origin+pathname for the same reason instagramEmbedUrl is: a
// share URL usually carries tracking query params, and `url + '.json'` would
// append the suffix after the query string where Reddit never looks for it.
// `raw_json=1` stops Reddit HTML-escaping & < > inside every body it
// returns, which would otherwise land in the note verbatim.
export function redditJsonUrl(url, { limit = 20 } = {}) {
  let u
  try {
    u = new URL(url)
  } catch {
    return null
  }
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}.json?raw_json=1&limit=${limit}`
}

const MAX_COMMENTS = 8
const MAX_COMMENT_CHARS = 600

// Pure payload → { siteTitle, siteDesc, siteName, article, thumbUrl }
// (exported for tests; no network).
//
// Reddit answers a post URL with a two-element array of Listings: the post
// itself, then its comment tree. Every field is optional in practice —
// deleted posts, removed bodies, quarantined subs and link posts with no
// selftext all arrive as the same shape with holes in it — so this reads
// defensively throughout and returns nulls rather than throwing.
export function parseRedditPost(payload) {
  const empty = { siteTitle: null, siteDesc: null, siteName: 'Reddit', article: null, thumbUrl: null }
  const post = payload?.[0]?.data?.children?.[0]?.data
  if (!post) return empty

  const selftext = clean(post.selftext)
  const parts = []
  if (post.subreddit) parts.push(`r/${post.subreddit}${post.author ? ` — posted by u/${post.author}` : ''}`)
  if (selftext) parts.push(selftext)

  // The thread is often where the actual answer lives — a "what is this
  // plant" post's whole value is the reply naming it. Stickied bot posts and
  // deleted bodies carry none of that and are dropped.
  const comments = (payload?.[1]?.data?.children || [])
    .map((c) => c?.data)
    .filter((c) => c && c.body && !c.stickied && !['[deleted]', '[removed]'].includes(c.body.trim()))
    .slice(0, MAX_COMMENTS)
    .map((c) => `u/${c.author || 'someone'}: ${clean(c.body).slice(0, MAX_COMMENT_CHARS)}`)
  if (comments.length) parts.push('Top comments:\n' + comments.join('\n'))

  return {
    siteTitle: clean(post.title)?.slice(0, 300) || null,
    // The post body, capped like an Instagram caption is — the short,
    // creator-written field. The uncapped version lives in `article`.
    siteDesc: selftext ? selftext.slice(0, 2000) : null,
    siteName: 'Reddit',
    article: parts.length ? parts.join('\n\n').slice(0, MAX_ARTICLE) : null,
    thumbUrl: redditThumbUrl(post),
  }
}

function clean(text) {
  const t = (text || '').toString().trim()
  return t || null
}

// `thumbnail` is a sentinel word ('self', 'default', 'nsfw', 'spoiler') for
// anything Reddit did not generate a preview for, so the preview block is
// tried first and the sentinel forms are rejected rather than fetched.
function redditThumbUrl(post) {
  const preview = post.preview?.images?.[0]?.source?.url
  if (preview && isSafeFetchUrl(preview)) return preview
  if (post.thumbnail && isSafeFetchUrl(post.thumbnail)) return post.thumbnail
  // A direct image submission: the post's own url IS the picture.
  if (post.url && /\.(jpe?g|png|gif|webp)(\?|$)/i.test(post.url) && isSafeFetchUrl(post.url)) return post.url
  return null
}

// Returns null when the JSON route is unavailable, so fetchLinkMeta can fall
// through to the generic path rather than leaving the note with nothing.
async function fetchRedditMeta(url, noteId) {
  let parsed
  try {
    const payload = await (await get(redditJsonUrl(url), 'application/json')).json()
    parsed = parseRedditPost(payload)
  } catch (e) {
    console.warn('[meta] reddit json unavailable for', url, '-', e.message, '— falling back to oEmbed/OpenGraph')
    return null
  }
  // A payload that parses to nothing is the same situation as a failed fetch:
  // a login wall can answer 200 with a body that has no post in it.
  if (!parsed.siteTitle && !parsed.article) return null

  const { thumbUrl, ...meta } = parsed
  const out = { ...meta, thumb: null }
  if (thumbUrl) {
    try {
      out.thumb = await saveThumb(new URL(thumbUrl, url).href, noteId)
    } catch {
      /* no thumbnail is fine */
    }
  }
  return out
}

// ---- YouTube captions ----------------------------------------------------
// A saved YouTube video has almost no retrievable text: oEmbed gives a title
// and a channel name, and the watch page's og:description is a truncated
// stub. The transcript is the actual content — and YouTube already publishes
// one for most videos, so it costs a single request with no download and no
// speech-to-text anywhere in the picture.
//
// youtube-transcript is the second (and last) deliberate exception to the
// dependency-free house rule. What it transfers is upkeep, not code: it
// tracks how YouTube's caption endpoint is reached, which Google reshapes
// periodically. Vetted at 1.3.1: MIT, ZERO dependencies, 64 KB, ESM with a
// real exports map, node >= 18 — so the lite image gains a rounding error.
// youtubei.js was the alternative and was rejected: 16 MB unpacked and three
// transitive dependencies, for a full InnerTube client when all that is
// needed here is one endpoint.
//
// The video id is extracted and validated HERE, before the package is called,
// so it never sees an arbitrary user-supplied URL — its requests go to
// youtube.com and nowhere else. (It fetches with global fetch, outside
// safeFetch; constraining the input to a validated video id is what keeps
// that acceptable.)

// Pure: url → the 11-ish-char video id, or null for anything that isn't a
// YouTube video URL (exported for tests; no network).
export function youtubeVideoId(url) {
  let u
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (!isSafeFetchUrl(url)) return null
  const id = (v) => (/^[\w-]{6,20}$/.test(v || '') ? v : null)
  const host = u.hostname.replace(/^(www|m)\./, '')
  if (host === 'youtu.be') return id(u.pathname.slice(1).split('/')[0])
  if (host === 'youtube.com' || host === 'music.youtube.com') {
    if (u.pathname === '/watch') return id(u.searchParams.get('v'))
    // /shorts/, /embed/, /live/ and the legacy /v/ all carry the id inline.
    const m = /^\/(?:shorts|embed|live|v)\/([^/?#]+)/.exec(u.pathname)
    if (m) return id(m[1])
  }
  return null
}

export function isYouTubeVideo(url) {
  return youtubeVideoId(url) !== null
}

// Pure: transcript segments → one block of prose (exported for tests).
// Segments arrive as one short phrase per caption cue, so they are joined
// with spaces rather than newlines — the result is read as text by classify
// and embedText, not displayed.
//
// Capped at MAX_ARTICLE like every other article body. Worth knowing: embed
// providers clip their input at 4000 chars, so only roughly the first half of
// a long transcript reaches the embedding. That is deliberate rather than a
// bug to fix here — chunking a note into multiple vectors is explicitly out
// of scope — and the full 8000 still serves textSearch and the answer prompt.
export function joinCaptions(segments) {
  const text = (segments || [])
    .map((s) => (s?.text || '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text ? text.slice(0, MAX_ARTICLE) : null
}

// Errors that mean this video will NEVER have captions, as opposed to "not
// right now". The distinction is what the caller's idempotency marker turns
// on: a permanent answer is worth recording so the video is never asked
// about again, while a rate-limit or a network blip must stay retryable —
// the same false-positive-vs-false-negative call enrich.js's other markers
// make, resolved the same way.
const PERMANENT_CAPTION_ERRORS = [
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptNotAvailableError,
  YoutubeTranscriptNotAvailableLanguageError,
  YoutubeTranscriptVideoUnavailableError,
]

// English is asked for FIRST, with a fall back to whatever the video has.
// Without the preference the package takes captionTracks[0], which is
// whatever order YouTube happened to return — a real video in this library
// came back with its Arabic track, so the note's article, its tags and its
// embedding were all built from a translation while every question about it
// would be asked in English. A missing English track is not a failure, so the
// fallback keeps whatever does exist: a transcript in the wrong language
// still beats none.
const CAPTION_LANG = 'en'

// Returns { text, done }. `text` is null whenever there is nothing to store —
// absence of captions is a normal outcome for a YouTube video, not a failure,
// so this never throws. `done` says whether the answer is final.
export async function fetchYouTubeCaptions(url) {
  const id = youtubeVideoId(url)
  if (!id) return { text: null, done: false }
  try {
    let segments
    try {
      segments = await fetchTranscript(id, { lang: CAPTION_LANG })
    } catch (e) {
      // "no English track" specifically — any other failure is the real one
      // and must not be masked by a second attempt.
      if (!(e instanceof YoutubeTranscriptNotAvailableLanguageError)) throw e
      segments = await fetchTranscript(id)
    }
    return { text: joinCaptions(segments), done: true }
  } catch (e) {
    const permanent = PERMANENT_CAPTION_ERRORS.some((E) => e instanceof E)
    if (!permanent) console.warn('[meta] youtube captions unavailable for', url, '-', e.message)
    return { text: null, done: permanent }
  }
}

// Real content wins by going first; oEmbed's author-only line (if any) still
// adds a little context rather than being thrown away. Pure, split out for
// testability — fetchLinkMeta's network calls aren't unit-tested, same as
// fetchInstagramMeta.
export function mergeSiteDesc(ogDesc, oembedDesc) {
  return [ogDesc, oembedDesc].filter(Boolean).join('\n\n') || null
}

// Pure html → article body text (exported for tests; no network).
//
// Readability is doing the actual work here: separating the article body from
// nav, related-post widgets, comment threads and ad slots is a genuinely hard
// structural problem, and the regex-scraping approach the og-tag helpers above
// use does not generalize to it.
//
// Returns null rather than throwing on anything unusable, matching how the
// rest of this module treats optional enrichment (see saveThumb's callers):
// a missing article is fine, it just means classify/embed fall back to the
// og-description as before.
export function extractArticle(html) {
  try {
    const { document } = parseHTML(html)
    const parsed = new Readability(document).parse()
    const text = (parsed?.textContent || '').replace(/\s+/g, ' ').trim()
    if (text.length < MIN_ARTICLE) return null
    return text.slice(0, MAX_ARTICLE)
  } catch {
    return null
  }
}

// Returns { siteTitle, siteDesc, siteName, thumb, article } (thumb = local
// /uploads path). Throws on total failure; partial results are fine.
export async function fetchLinkMeta(rawUrl, noteId) {
  if (isInstagramPost(rawUrl)) return fetchInstagramMeta(rawUrl, noteId)
  // Resolved before anything else looks at it, so oEmbed, the .json fetch and
  // the OpenGraph scrape all see a canonical post URL — see isRedditShare.
  const url = isRedditShare(rawUrl) ? (await resolveRedditShare(rawUrl)) || rawUrl : rawUrl
  if (isRedditPost(url)) {
    const reddit = await fetchRedditMeta(url, noteId)
    if (reddit) return reddit
    // else: fall through to oEmbed + OpenGraph, which is what still works.
  }
  const meta = { siteTitle: null, siteDesc: null, siteName: null, thumb: null, article: null }
  let thumbUrl = null

  let oembedDesc = null
  const endpoint = oembedEndpoint(url)
  if (endpoint) {
    try {
      const d = await (await get(endpoint, 'application/json')).json()
      meta.siteTitle = d.title || null
      meta.siteName = d.provider_name || null
      oembedDesc = d.author_name ? `by ${d.author_name}` : null
      thumbUrl = d.thumbnail_url || null
    } catch {
      /* fall through to HTML scrape */
    }
  }

  // Always try the page's own og:description too, even when oEmbed already
  // supplied a title/thumbnail: oEmbed's author_name ("by MrBeast") carries
  // almost no topical signal for classify/embed — the actual video
  // description is what's worth having, and oEmbed never provides it.
  try {
    const res = await get(url, 'text/html,*/*')
    const html = (await res.text()).slice(0, MAX_HTML)
    if (!meta.siteTitle) meta.siteTitle = metaTag(html, 'og:title') || metaTag(html, 'twitter:title') || titleTag(html)
    if (!meta.siteName) meta.siteName = metaTag(html, 'og:site_name')
    meta.siteDesc = mergeSiteDesc(metaTag(html, 'og:description') || metaTag(html, 'description'), oembedDesc)
    thumbUrl = thumbUrl || metaTag(html, 'og:image') || metaTag(html, 'twitter:image')

    // Only parse when the body is actually HTML — a PDF or JSON response can
    // reach here (nothing upstream constrains the URL to a web page), and
    // handing either to Readability is wasted work at best. Mirrors the
    // content-type check saveThumb already does for images.
    if ((res.headers.get('content-type') || '').includes('html')) {
      meta.article = extractArticle(html)
    }
  } catch {
    // oEmbed's weaker signal (if any) is still better than nothing.
    meta.siteDesc = oembedDesc
  }

  if (thumbUrl) {
    try {
      meta.thumb = await saveThumb(new URL(thumbUrl, url).href, noteId)
    } catch (e) {
      /* no thumbnail is fine */
    }
  }
  return meta
}

// `key` names the file, not just the note: a note's own thumbnail keys off the
// bare note id, its carousel slides off `<noteId>-<i>`. Every file still starts
// `meta-` so the uploads wipe and the per-note delete sweep keep matching them.
async function saveThumb(url, key) {
  const res = await get(url, 'image/*')
  const ct = res.headers.get('content-type') || ''
  if (!ct.startsWith('image/')) return null
  const buf = Buffer.from(await res.arrayBuffer())
  if (!buf.length || buf.length > MAX_THUMB) return null
  const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : ct.includes('gif') ? 'gif' : 'jpg'
  const name = `meta-${key}.${ext}`
  await writeFile(path.join(UPLOAD_DIR, name), buf)
  return `/uploads/${name}`
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
export function unescapeEmbedUrl(raw) {
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
export function parseInstagramCarousel(html) {
  const at = html.indexOf('edge_sidecar_to_children')
  if (at === -1) return []
  const re = /display_url\\*"\s*:\s*\\*"([^"]+)/g
  re.lastIndex = at
  const out = []
  const seen = new Set()
  let m
  while ((m = re.exec(html)) && out.length < MAX_SLIDES) {
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
export async function fetchInstagramSlides(url, noteId) {
  await igThrottle()
  const html = (await (await get(instagramEmbedUrl(url), 'text/html,*/*')).text()).slice(0, MAX_HTML)
  const slides = []
  for (const [i, src] of parseInstagramCarousel(html).entries()) {
    try {
      const local = await saveThumb(new URL(src, url).href, `${noteId}-${i}`)
      if (local) slides.push(local)
    } catch {
      /* one unreachable slide shouldn't sink the rest of the deck */
    }
  }
  return slides
}
