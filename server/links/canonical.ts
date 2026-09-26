// The key two links are "the same link" by. The importer skips an item whose
// key is already saved; /api/duplicates groups saved notes that share one.

// A note is deduped/matched by a CANONICAL form of its URL, not the raw
// string: a manually-saved link and the same post re-arriving via export
// almost never share byte-identical URLs. Real variance seen in the wild —
// Instagram's own "Copy link" appends a `?igsh=...` tracking param, `www.`
// is optional, a trailing slash is cosmetic, and the SAME post can be typed
// as either `/p/<code>/` or `/reel/<code>/` depending on where the "Saved
// on" href came from.
//
// This normalization is Instagram-specific ONLY for the shortcode collapse
// (host === instagram.com). For every other host, the query string and port
// are load-bearing and MUST be kept: `youtube.com/watch?v=AAA` and
// `?v=BBB` are different videos, `news.ycombinator.com/item?id=1` and
// `?id=2` are different threads, and `example.com:8443/a` and `:9999/a` can
// be entirely different services. Dropping them (an earlier version of this
// function did, via `.pathname` alone) silently MERGES distinct links —
// worse than the duplication problem this function exists to fix, since a
// merge drops one of the two notes entirely rather than just double-saving
// it. A small tracking-param allowlist is still stripped so the intended
// benefit (surviving a shared/copied link's tracking noise) applies outside
// Instagram too, without touching anything that could be a real identifier.
// TikTok reaches the same video by three different URLs: the export's
// `tiktokv.com/share/video/<id>/`, the canonical `tiktok.com/@user/video/<id>`
// a person would paste from the app, and the handle-less
// `tiktok.com/video/<id>` the importer rewrites to. The numeric id is the
// identity, so all three collapse to one key — without this, saving a TikTok
// by hand and then importing your favourites would store it twice.
const TT_HOST = /(^|\.)(tiktok\.com|tiktokv\.com)$/
const TT_VIDEO_ID = /\/(?:share\/)?video\/(\d+)/
const IG_HOST = /(^|\.)instagram\.com$/
const IG_SHORTCODE = /\/(?:p|reel|reels|tv)\/([^/]+)/i // path keyword case-insensitive; shortcode itself stays case-sensitive (Instagram shortcodes are)
// utm_*/igsh/fbclid are unambiguous tracking noise on ANY host. `si` is NOT —
// it's a YouTube/Spotify share-tracking param, but on an arbitrary site it
// could just as easily be a real query param (e.g. a search-index id), so
// stripping it globally would false-merge distinct links there. Scope it.
const GLOBAL_TRACKING_PARAM = /^utm_|^igsh$|^fbclid$/i
const SI_TRACKING_HOSTS = /(^|\.)(youtube\.com|youtu\.be|spotify\.com)$/

function stripTrackingParams(search: string, host: string): string {
  if (!search) return ''
  const params = new URLSearchParams(search)
  const stripSi = SI_TRACKING_HOSTS.test(host)
  for (const key of [...params.keys()]) {
    if (GLOBAL_TRACKING_PARAM.test(key) || (stripSi && key.toLowerCase() === 'si')) params.delete(key)
  }
  const s = params.toString()
  return s ? `?${s}` : ''
}

export function canonicalUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) return ''
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    // Not a parseable URL at all — fall back to a best-effort normalized
    // string rather than treating it as "no url" (which would make it
    // un-dedupeable in either direction).
    return raw.trim().toLowerCase()
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  const path = u.pathname.replace(/\/+$/, '') || '/'
  if (TT_HOST.test(host)) {
    const m = path.match(TT_VIDEO_ID)
    if (m) return `tiktok:${m[1]}`
  }
  if (IG_HOST.test(host)) {
    const m = path.match(IG_SHORTCODE)
    if (m) return `instagram:${m[1]}` // /p/, /reel/, /reels/, /tv/ for the same code are the same post
  }
  const port = u.port ? `:${u.port}` : ''
  return `${host}${port}${path}${stripTrackingParams(u.search, host)}`
}
