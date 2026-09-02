// Parses TikTok's "Download your data" JSON export into neutral import items.
// Same trust posture as server/import/instagram.js: this JSON arrives from a
// user-uploaded file, so it's treated as hostile input, and every unexpected
// shape degrades to "fewer items" rather than a failed import.
//
// Scope is FAVORITES ONLY — the videos you deliberately saved. A TikTok export
// also carries a Like List and (in fuller exports) browsing history; likes are
// a cheap gesture rather than a keep, and history is everything the algorithm
// showed you. Importing either would flood the store with thousands of notes
// and pay for an LLM enrichment pass on each one.
//
// Verified against a real export (197 favorites, 13 collections, Aug 2026).

export const name = 'tiktok'
export const label = 'TikTok'
export const expects = 'user_data_tiktok.json from a JSON export (or the export ZIP)'

// The whole export is ONE file whose name varies by export version, and people
// rename downloads — so the name is a hint, not the test. `sniff` also probes
// the bytes for TikTok's own list key, which no other platform's export
// carries. Buffer#includes is a native scan: no JSON.parse, no allocation, so
// this stays cheap even on a large export we're about to reject.
const USER_DATA_FILE = /(^|\/)user_data(_tiktok)?\.json$/i
const FAVORITES_MARKER = Buffer.from('FavoriteVideoList')

// The list keys themselves have been stable across export versions; only the
// WRAPPER around them drifts (older exports nest under "Activity", the current
// one under "Likes and Favorites"). So we pin the list keys and walk to find
// them, rather than pinning a path that the next version renames — the exact
// mistake that made a real 1,675-post Instagram export parse to zero.
const VIDEO_LIST_KEY = 'FavoriteVideoList'
const COLLECTION_LIST_KEY = 'FavoriteCollectionList'

// Caps mirror server/import/instagram.js — cheap guards against a hostile
// export, not general-purpose validation.
const MAX_ITEMS = 100_000
const MAX_URL_LEN = 2048
const MAX_FIELD_LEN = 500
const MAX_WALK_DEPTH = 64
const MAX_TS = 4_102_444_800 // 2100-01-01Z in Unix seconds

// Export links look like https://www.tiktokv.com/share/video/<id>/ — a host
// that is NOT tiktok.com and has no oEmbed provider. Imported verbatim, all
// 197 notes come back with no title, no thumbnail and no author, because
// TikTok's oEmbed endpoint rejects that form outright (a plain 400). The
// numeric id is the video's real identity, so we rebuild the canonical form,
// which oEmbed does answer — with the caption as title, a thumbnail, and the
// author handle that the export itself never carries.
const TIKTOK_VIDEO_ID = /\/(?:share\/)?video\/(\d+)/
const TIKTOK_HOST = /(^|\.)(tiktok\.com|tiktokv\.com)$/

export function sniff(files) {
  for (const [key, buf] of files) {
    if (USER_DATA_FILE.test(key)) return true
    if (Buffer.isBuffer(buf) && buf.includes(FAVORITES_MARKER)) return true
  }
  return false
}

function tryJson(buf) {
  try { return JSON.parse(buf.toString('utf8')) } catch { return null }
}

function clip(str) {
  if (typeof str !== 'string') return ''
  return str.replace(/\s+/g, ' ').trim().slice(0, MAX_FIELD_LEN)
}

// Collects every array stored under `key`, at any depth. Depth-bounded for the
// same reason instagram.js's walks are: JSON.parse is not recursive in V8, so a
// maliciously deep document genuinely reaches our own walk and would otherwise
// overflow the stack. Past the cap we stop descending and report truncation.
function findLists(node, key, out, depth = 0) {
  if (depth > MAX_WALK_DEPTH) return true // truncated
  let truncated = false
  if (Array.isArray(node)) {
    for (const v of node) truncated = findLists(v, key, out, depth + 1) || truncated
    return truncated
  }
  if (!node || typeof node !== 'object') return false
  for (const [k, v] of Object.entries(node)) {
    if (k === key && Array.isArray(v)) out.push(v)
    else truncated = findLists(v, key, out, depth + 1) || truncated
  }
  return truncated
}

// TikTok writes "2025-08-09 10:20:53" — a bare string with no zone. It is UTC.
// Parsing it with `new Date(str)` would read it as LOCAL time, silently
// shifting every imported note by the user's offset (and putting notes in the
// wrong day at the edges), so the zone is made explicit here.
export function parseTikTokDate(str) {
  if (typeof str !== 'string') return 0
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(str.trim())
  if (!m) return 0
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
  if (!Number.isFinite(ms)) return 0
  const seconds = ms / 1000
  return seconds > 0 && seconds <= MAX_TS ? seconds : 0
}

// Only explicit http(s) on a TikTok host, short enough not to become a broken
// link everywhere it flows. A stray "javascript:" or an off-platform URL must
// never survive the parse — these become clickable card URLs on the client.
function isUsableLink(v) {
  if (typeof v !== 'string' || v.length > MAX_URL_LEN) return false
  if (!v.startsWith('http://') && !v.startsWith('https://')) return false
  try { return TIKTOK_HOST.test(new URL(v).hostname.toLowerCase()) } catch { return false }
}

// Share URL → the canonical form oEmbed answers. Anything already in a
// canonical shape (or that carries no readable id) is returned untouched
// rather than guessed at.
export function canonicalVideoUrl(link) {
  const m = TIKTOK_VIDEO_ID.exec(link)
  if (!m) return link
  return `https://www.tiktok.com/video/${m[1]}`
}

export function parseFavorites(rows, maxItems = MAX_ITEMS) {
  const items = []
  let skipped = 0
  let unusableUrl = 0
  for (const row of rows) {
    const link = row?.Link ?? row?.link
    if (!isUsableLink(link)) {
      // Only worth reporting when the row carried SOMETHING url-shaped that we
      // then refused — a row with no Link at all simply isn't a saved video.
      if (typeof link === 'string' && link.trim()) unusableUrl++
      continue
    }
    // Keep counting valid rows past the cap (without holding them) so parse()
    // can report an accurate "N skipped".
    if (items.length >= maxItems) { skipped++; continue }
    items.push({
      url: canonicalVideoUrl(link),
      poster: clip(row?.Author || ''), // absent in every export seen so far; enrichment fills the handle in from oEmbed
      savedAt: parseTikTokDate(row?.Date),
    })
  }
  items.skipped = skipped
  items.unusableUrl = unusableUrl
  return items
}

// Collection NAMES, which is all the export carries: each row is
// { Date, FavoriteCollection: "Umrah" } — when the collection was created,
// never which videos are in it. See parse() for what that costs.
export function parseCollectionNames(rows) {
  const names = []
  for (const row of rows) {
    const n = clip(row?.FavoriteCollection ?? row?.Name ?? '')
    if (n && !names.includes(n)) names.push(n)
  }
  return names
}

export function parse(files) {
  let items = []
  const collectionNames = []
  const warnings = []
  let remaining = MAX_ITEMS
  let itemsSkippedByCap = 0
  let itemsWithUnusableUrl = 0
  let truncated = false
  let sawFavoritesFile = false

  for (const [key, buf] of files) {
    if (!USER_DATA_FILE.test(key) && !(Buffer.isBuffer(buf) && buf.includes(FAVORITES_MARKER))) continue
    const json = tryJson(buf)
    if (!json) { warnings.push(`${key} could not be parsed`); continue }
    sawFavoritesFile = true

    const videoLists = []
    truncated = findLists(json, VIDEO_LIST_KEY, videoLists) || truncated
    for (const rows of videoLists) {
      const parsed = parseFavorites(rows, remaining)
      items = items.concat(parsed)
      remaining -= parsed.length
      itemsSkippedByCap += parsed.skipped || 0
      itemsWithUnusableUrl += parsed.unusableUrl || 0
    }

    const collectionLists = []
    truncated = findLists(json, COLLECTION_LIST_KEY, collectionLists) || truncated
    for (const rows of collectionLists) {
      for (const n of parseCollectionNames(rows)) if (!collectionNames.includes(n)) collectionNames.push(n)
    }
  }

  if (sawFavoritesFile && items.length === 0 && !itemsSkippedByCap && !itemsWithUnusableUrl) {
    warnings.push('That export contains no favourited videos. Favourites are the ones you saved with the bookmark icon — likes and watch history are deliberately not imported.')
  }
  if (itemsSkippedByCap > 0) warnings.push(`item cap reached; ${itemsSkippedByCap} videos skipped`)
  if (itemsWithUnusableUrl > 0) warnings.push(`${itemsWithUnusableUrl} videos had an unusable link`)
  if (truncated) warnings.push('parts of the export were too deeply nested to read')

  // TikTok's export names your collections but never says which videos are in
  // them: a collection row is { Date, FavoriteCollection } and a video row is
  // { Date, Link }, with nothing joining the two. So unlike Instagram, there
  // is no membership to mirror into Spaces — say so plainly rather than
  // creating a set of empty Spaces that look broken, or silently dropping the
  // fact that the grouping the user built exists and could not come across.
  if (collectionNames.length) {
    warnings.push(
      `${collectionNames.length} TikTok collection(s) found (${collectionNames.slice(0, 3).join(', ')}${collectionNames.length > 3 ? ', …' : ''}), but TikTok's export doesn't record which videos belong to them — your favourites came in as one list.`,
    )
  }

  // Always empty: parse()'s contract is [{ name, urls }], and a name with no
  // urls would have the route create a Space it can never fill.
  return { items, collections: [], warnings }
}

// Import item → phase-one note fields. Every favourite is a video, and the
// export carries no caption or handle, so title is a placeholder that the
// background enrich pass replaces with the real caption (and `account` with
// the real handle) once oEmbed answers for the canonical URL built above.
export function deriveNote(item) {
  const savedAt = parseTikTokDate(item.savedAt) || (typeof item.savedAt === 'number' ? item.savedAt : 0)
  const seconds = Number.isFinite(savedAt) && savedAt > 0 && savedAt <= MAX_TS ? savedAt : 0
  return {
    type: 'video',
    title: item.poster ? `@${item.poster} · TikTok` : 'TikTok video',
    content: item.url, // enrich reads `content` as the note's text
    url: item.url,
    tags: ['tiktok'],
    account: item.poster || null,
    createdAt: seconds > 0 ? new Date(seconds * 1000).toISOString() : new Date().toISOString(),
    importedAt: new Date().toISOString(),
    pending: true,
  }
}
