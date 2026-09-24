// Link/video metadata: fetched once when a note is enriched (oEmbed where the
// provider registry knows the URL, OpenGraph tags for everything else), with
// the thumbnail downloaded into data/uploads — so cards show real titles and
// previews without ever hitting the network again.
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
import type { TranscriptResponse } from 'youtube-transcript'
import { MAX_HTML, decodeEntities, get, isSafeFetchUrl, saveThumbSafe } from '../links/fetch.ts'
import { fetchInstagramMeta, isInstagramPost } from '../links/instagram.ts'

const MAX_ARTICLE = 8000 // chars of extracted body text persisted per note
const MIN_ARTICLE = 200 // below this it's a paywall/cookie-wall stub, not content

// <meta property="og:title" content="..."> (handles either attribute order)
function metaTag(html: string, prop: string): string | null {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, 'i')
  const m = re.exec(html)
  if (!m) return null
  const c = /content=["']([^"']*)["']/i.exec(m[0])
  return c?.[1] ? decodeEntities(c[1]).trim() : null
}

function titleTag(html: string): string | null {
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

// The four fields of an oEmbed response this reads, out of the many the spec
// defines. Every one is `unknown`: res.json() answers unknown, and for this
// document that is the honest type — it comes from whichever site the user
// saved, and nothing here has checked it. str() below is how each is read.
interface OembedResponse {
  title?: unknown
  provider_name?: unknown
  author_name?: unknown
  thumbnail_url?: unknown
}

// The two narrowings the JSON boundary needs. Deliberately local rather than
// lifted into server/lib/: that directory is the security floor, and a change
// there needs a test that fails without it (CLAUDE.md) — which a type-only
// migration has no business writing. server/data/migrate.ts and
// server/routes/setup-test.ts each carry their own isRecord for the same
// reason; server/import/untrusted.ts exports the fourth.
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

// A non-string field reads as absent rather than being trusted into a note:
// for a string this is exactly the `field || null` the untyped version did,
// and a provider that answers `title: 42` no longer writes a number into
// siteTitle.
function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null
}

// Pure: url → the oEmbed API URL to call, or null when no provider matches
// (exported for tests; no network).
export function oembedEndpoint(url: string): string | null {
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

// ---- Reddit -------------------------------------------------------------
// Reddit posts go through the generic oEmbed + OpenGraph path below: Reddit's
// oEmbed endpoint is the one route still open to a non-browser client, and it
// returns the post title and author. The richer `.json` rendering (selftext
// and comments) answers 403 to anonymous requests, from datacenter and home
// connections alike, so the fetcher and parser built for it were removed.

export function isRedditPost(url: string): boolean {
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
// apps. The oEmbed registry's pattern wants /comments/, so a share link skips
// it and the note is left titled "Reddit" by the shell page's <title>. They
// are plain redirects to the canonical post, so one redirect-following request
// turns a share link back into a URL oEmbed recognises.
//
// The share segment has to be the LAST one: a subreddit can be named `s`, and
// `/r/s/comments/<id>/...` is an ordinary post URL, not a share link.
export function isRedditShare(url: string): boolean {
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
export async function resolveRedditShare(url: string): Promise<string | null> {
  try {
    const res = await get(url, 'text/html,*/*')
    const u = new URL(res.url)
    const canonical = `${u.origin}${u.pathname}`
    return isRedditPost(canonical) ? canonical : null
  } catch {
    return null
  }
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
export function youtubeVideoId(url: string): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (!isSafeFetchUrl(url)) return null
  const id = (v: string | null): string | null => (/^[\w-]{6,20}$/.test(v || '') ? v : null)
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

export function isYouTubeVideo(url: string): boolean {
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
export function joinCaptions(
  segments: readonly (TranscriptResponse | null | undefined)[] | null | undefined,
): string | null {
  const text = (segments || [])
    .map(s => (s?.text || '').trim())
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
// the same false-positive-vs-false-negative call enrich.ts's other markers
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
export async function fetchYouTubeCaptions(url: string): Promise<{ text: string | null; done: boolean }> {
  const id = youtubeVideoId(url)
  if (!id) return { text: null, done: false }
  try {
    let segments: TranscriptResponse[]
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
    const permanent = PERMANENT_CAPTION_ERRORS.some(E => e instanceof E)
    if (!permanent)
      console.warn('[meta] youtube captions unavailable for', url, '-', e instanceof Error ? e.message : e)
    return { text: null, done: permanent }
  }
}

// Real content wins by going first; oEmbed's author-only line (if any) still
// adds a little context rather than being thrown away. Pure, split out for
// testability — fetchLinkMeta's network calls aren't unit-tested, same as
// fetchInstagramMeta.
export function mergeSiteDesc(ogDesc: string | null, oembedDesc: string | null): string | null {
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
export function extractArticle(html: string): string | null {
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

// What a link contributes, whichever of the three routes above produced it.
// `article` and `author` are optional because only some routes can fill them:
// Instagram has neither, Reddit has an article and no author, the generic
// oEmbed + OpenGraph path has both. Callers treat the whole thing as
// optional-per-field anyway — applyMeta (ai/meta-fields.ts) copies across
// whichever fields came back truthy.
export interface LinkMeta {
  siteTitle: string | null
  siteDesc: string | null
  siteName: string | null
  thumb: string | null
  article?: string | null
  author?: string | null
}

// Returns { siteTitle, siteDesc, siteName, thumb, article } (thumb = local
// /uploads path). Throws on total failure; partial results are fine.
export async function fetchLinkMeta(rawUrl: string, noteId: string): Promise<LinkMeta> {
  if (isInstagramPost(rawUrl)) return fetchInstagramMeta(rawUrl, noteId)
  // Resolved before anything else looks at it, so oEmbed and the OpenGraph
  // scrape both see a canonical post URL — see isRedditShare.
  const url = isRedditShare(rawUrl) ? (await resolveRedditShare(rawUrl)) || rawUrl : rawUrl
  const meta: LinkMeta = { siteTitle: null, siteDesc: null, siteName: null, thumb: null, article: null, author: null }
  let thumbUrl: string | null = null

  let oembedDesc: string | null = null
  const endpoint = oembedEndpoint(url)
  if (endpoint) {
    try {
      const body: unknown = await (await get(endpoint, 'application/json')).json()
      const d: OembedResponse = isRecord(body) ? body : {}
      meta.siteTitle = str(d.title)
      meta.siteName = str(d.provider_name)
      // Kept as its own field, not only folded into oembedDesc below. The
      // creator handle is an IDENTITY: enrich promotes it to the note's
      // `account`, which drives the account tag and lets a library be
      // filtered by creator. Instagram gets this from its export; every other
      // platform can only learn it here. TikTok in particular carries the
      // handle in NEITHER its export nor the URL it redirects to (that
      // redirect lands on a literal "@/"), so without this a TikTok note has
      // no author anywhere, forever.
      const authorName = str(d.author_name)
      meta.author = authorName?.trim() || null
      oembedDesc = authorName ? `by ${authorName}` : null
      thumbUrl = str(d.thumbnail_url)
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

  if (thumbUrl) meta.thumb = await saveThumbSafe(thumbUrl, url, noteId)
  return meta
}
