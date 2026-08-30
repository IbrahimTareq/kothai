// Parses Instagram's official "Export your information" data (Accounts Center,
// JSON format) into neutral import items. Deliberately defensive: Meta renames
// keys between export versions, so everything degrades to "fewer fields" or
// "no collections" rather than a failed import. No credentials, no scraping.
//
// This module sits on the same trust boundary as server/lib/zip.js: the JSON
// here comes straight from a user-uploaded archive, so it's treated as
// hostile input, not just "unusual" input — see the guards below.

export const name = 'instagram'
// Shown by the route when an upload doesn't match this importer. Kept beside
// the parser (not in the route) so each future platform describes its own
// export in its own words.
export const label = 'Instagram'
export const expects = 'saved_posts.json, saved_collections.json, or the whole export ZIP'

const SAVED_POSTS_FILE = /(^|\/)saved_posts\.json$/
const COLLECTIONS_FILE = /(^|\/)saved_collections\.json$/

// Prefer a value shaped like the real permalink over "first href found" in a
// string_map_data bag — exports can list a Profile URL (or other href-bearing
// key) before "Saved on", and both key order and the "Saved on" label itself
// vary by export language/version, so picking blindly can attach the wrong
// URL — and, since href/timestamp are now read off the SAME matched entry,
// the wrong date too — to the note.
const IG_PERMALINK = /instagram\.com\/(p|reel|reels|tv)\//

// Caps mirror the trust-boundary posture of server/lib/zip.js: cheap guards
// against a hostile export, not general-purpose validation.
const MAX_ITEMS = 100_000 // shared budget across every saved_posts.json in one import (tracked in parse()) — Meta splits large exports into parts, so capping per-file would let a hostile zip multiply past this
const MAX_URL_LEN = 2048 // an oversized href flows into note.url/content, the embedding input, and an <a href> on the client — reject rather than clip, since a truncated URL is a broken link
const MAX_FIELD_LEN = 500 // caps poster/title/collection-name strings only (note.url has its own cap above); these land in the UI and in LLM enrichment prompts, so a multi-MB string field can't ride along
// `depth` bounds recursion against a maliciously deep-nested JSON (e.g. a
// 100k-deep array) that would otherwise blow the stack with a RangeError.
// JSON.parse itself won't save us here — V8's parser is NOT recursive (it
// happily parses 100k-deep nesting), so a hostile depth genuinely reaches our
// own walk below, which overflows around ~10k stack frames. Past this cap we
// just stop descending, degrading to "fewer/no collections found" rather
// than crashing. JSON.parse output is a tree with no back-references, so
// cycles are structurally impossible here — no guard needed for that.
const MAX_WALK_DEPTH = 64
const MAX_TS = 4_102_444_800 // 2100-01-01T00:00:00Z in Unix seconds — beyond this a "Saved on" date is drift or hostile input, not real
const MAX_COLLECTION_HREFS = 200_000 // total href memberships retained per saved_collections.json — an attacker-controlled Set per collection is otherwise unbounded; sized ~2x MAX_ITEMS since a post can legitimately belong to more than one collection

// A collections file ALONE is a valid Instagram import: parse() emits its
// memberships and the route resolves them against notes already in the
// database, so "posts now, collections later" works. Requiring saved_posts
// here would reject that upload as "not a recognized export".
export function sniff(files) {
  return [...files.keys()].some((k) => SAVED_POSTS_FILE.test(k) || COLLECTIONS_FILE.test(k))
}

function tryJson(buf) {
  try { return JSON.parse(buf.toString('utf8')) } catch { return null }
}

// Only accept explicit http(s) — href.startsWith('http') would also admit
// "httpfoo://" or worse, and these values eventually become clickable card
// URLs on the client, so a stray "javascript:" or "data:" URL must never
// survive the parse (defense in depth; the client should also validate).
function isHttpUrl(v) {
  return typeof v === 'string' && (v.startsWith('http://') || v.startsWith('https://'))
}

// Collapses whitespace before clipping: these strings ride into an LLM
// enrichment prompt (a poster "name" full of newlines/control whitespace is a
// cheap prompt-formatting/injection vector) as well as into the UI.
function clip(str) {
  if (typeof str !== 'string') return ''
  return str.replace(/\s+/g, ' ').trim().slice(0, MAX_FIELD_LEN)
}

// Meta normally encodes "Saved on" as Unix seconds, but some export versions
// (and hostile input) carry milliseconds instead — feeding that straight into
// `new Date(t * 1000)` lands the note ~54,000 years in the future and pins it
// to the top of the timeline forever. Anything above 1e11 seconds (year
// ~5138) is implausible as seconds, so we treat it as already-milliseconds.
// `savedAt` always carries Unix SECONDS, regardless of which unit Meta sent.
// This also absorbs Infinity/NaN (JSON's `1e400` parses to Infinity, which
// would otherwise sail through as "a number > 0") and anything past MAX_TS,
// so a hostile timestamp degrades to "no timestamp" (falls back to "now" in
// deriveNote) instead of producing an Invalid Date that throws downstream.
function normalizeTimestamp(t) {
  if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) return 0
  const ms = t > 1e11 ? t : t * 1000
  const seconds = ms / 1000
  if (!Number.isFinite(seconds) || seconds > MAX_TS) return 0
  return seconds
}

// A usable href is http(s) AND short enough to not become a broken/oversized
// link everywhere it flows (note.url/content, the embedding input, an
// `<a href>` on the client). Length is folded into the SELECTION predicate
// (not checked after picking an entry) so that an oversized permalink-shaped
// href can still lose to a shorter, valid href on the same row instead of
// dropping the whole row.
function isUsableHref(v) {
  return isHttpUrl(v) && v.length <= MAX_URL_LEN
}

// Shared "what's this node's collection name" heuristic: used both to decide
// whether parseCollections' walk should claim a node, and to know when
// collectHrefs should stop descending (see parseCollections below).
function nodeName(node) {
  if (!node || typeof node !== 'object') return null
  if (typeof node.title === 'string' && node.title.trim()) return clip(node.title.trim())
  const v = node?.string_map_data?.Name?.value
  if (typeof v === 'string' && v.trim()) return clip(v.trim())
  // Newer Accounts Center exports carry the name as a label_values row
  // ({ label: 'Name', value: 'Recipes' }) instead of string_map_data.
  return labelValuesName(node)
}

// A collection's name in the newer array shape. Deliberately reads ONLY
// `label_values` and not the `dict` bags nested under it — a hashtag entry is
// `{ dict: [{ label: 'Name', value: 'cinematic' }] }`, so descending into
// dicts here would invent a collection per hashtag.
function labelValuesName(node) {
  const rows = Array.isArray(node?.label_values) ? node.label_values : null
  if (!rows) return null
  const hit = rows.find((e) => e?.label === 'Name' && typeof e.value === 'string' && e.value.trim())
  return hit ? clip(hit.value.trim()) : null
}

// Two export shapes are supported, because Meta changed saved_posts.json
// between versions and both are still in the wild:
//
//   legacy: { saved_saved_media: [{ title, string_map_data: { 'Saved on': { href, timestamp } } }] }
//   current (Accounts Center): [{ timestamp, label_values: [{ label: 'URL', href }, ...] }]
//
// The current shape has no `saved_saved_media` wrapper at all, so the old
// shape-pinned reader saw a real 1,675-post export as zero rows and reported
// only "contains no recognizable saved posts". readRow() below normalizes
// either shape down to the same { href, timestamp, poster } triple; every
// guard (scheme, length, permalink preference, timestamp bounding) applies
// identically to both.
function rowsOf(json) {
  if (Array.isArray(json)) return json
  return Array.isArray(json?.saved_saved_media) ? json.saved_saved_media : []
}

// Ordered so an href always beats a bare string value, and a permalink-shaped
// candidate always beats a generic one. The `value` fallback is deliberately
// restricted to permalink-shaped strings: label names are localized, so we
// can't reliably single out the "URL" row, and a Caption that happens to be a
// bare http(s) URL must not be mistaken for the post's own link.
function pickUrl(entries) {
  const hrefs = entries.map((e) => e?.href).filter(isUsableHref)
  return hrefs.find((h) => IG_PERMALINK.test(h))
    ?? entries.map((e) => e?.value).filter((v) => isUsableHref(v) && IG_PERMALINK.test(v))[0]
    ?? hrefs[0]
}

// Owner is a nested dict-of-dicts: { title: 'Owner', dict: [{ dict: [{ label:
// 'Username', value }, { label: 'Name', value }] }] }. Both the wrapper title
// and the labels are localized in non-English exports, so instead of keying
// off 'Owner' we scan the (small, fixed-shape) nested dicts for a Username —
// falling back to a display Name — and give up quietly if neither is there.
// Depth-bounded for the same reason parseCollections' walk is: this reads an
// untrusted upload, and a hostile export can nest `dict` arbitrarily deep.
// Past the cap we return '' (no poster) rather than overflowing the stack.
function labelIn(entries, label, depth = 0) {
  if (depth > MAX_WALK_DEPTH) return ''
  for (const e of entries) {
    if (e?.label === label && typeof e.value === 'string' && e.value.trim()) return e.value
    const inner = Array.isArray(e?.dict) ? e.dict : null
    if (inner) {
      const hit = labelIn(inner, label, depth + 1)
      if (hit) return hit
    }
  }
  return ''
}

function readRow(row) {
  if (Array.isArray(row?.label_values)) {
    const entries = row.label_values
    const href = pickUrl(entries)
    return {
      href,
      // The saved-on date lives on the row itself in this shape; an
      // entry-level timestamp is only a fallback for further drift.
      timestamp: typeof row.timestamp === 'number' ? row.timestamp : entries.find((e) => isUsableHref(e?.href) && e.href === href)?.timestamp,
      poster: labelIn(entries, 'Username') || labelIn(entries, 'Name') || row.title,
      // A row that carried an http(s) URL which just failed the length check
      // is a genuine near-miss worth warning about (see parseSavedPosts).
      // Mirrors pickUrl's candidate rules exactly — in particular a `value`
      // only counts when it's permalink-shaped, so a Caption that merely
      // opens with a link ("https://makerworld.com/... check it out") isn't
      // miscounted as a post URL we failed to read.
      hadHttpHref: entries.some((e) => isHttpUrl(e?.href) || (isHttpUrl(e?.value) && IG_PERMALINK.test(e.value))),
    }
  }
  const vals = Object.values(row?.string_map_data || {})
  // Resolve ONE entry and read both href and timestamp off it — selecting
  // them independently let a post pick up e.g. an "Owner" entry's
  // timestamp while using "Saved on"'s href, silently mismatching the two.
  const entry = vals.find((v) => isUsableHref(v?.href) && IG_PERMALINK.test(v.href)) ?? vals.find((v) => isUsableHref(v?.href))
  return {
    href: entry?.href,
    timestamp: entry?.timestamp,
    poster: row?.title,
    hadHttpHref: vals.some((v) => isHttpUrl(v?.href)),
  }
}

// `maxItems` is a remaining-budget the caller passes in (see parse()) so the
// cap applies across an entire import, not reset per file.
export function parseSavedPosts(json, maxItems = MAX_ITEMS) {
  const rows = rowsOf(json)
  const items = []
  let skipped = 0
  let unusableUrl = 0
  for (const row of rows) {
    const { href, timestamp, poster, hadHttpHref } = readRow(row)
    if (!href) {
      // Only count as "unusable" if the row DID carry an http(s) URL that
      // just failed the length check — a row with no URL at all (e.g. no
      // "Saved on" key) is simply not a saved post, not a warning-worthy failure.
      if (hadHttpHref) unusableUrl++
      continue
    }
    if (items.length >= maxItems) { skipped++; continue } // keep counting valid rows past the cap (without holding them) so parse() can report an accurate "N posts skipped"
    items.push({ url: href, poster: clip(poster), savedAt: normalizeTimestamp(timestamp) })
  }
  // Read by parse() for warnings; harmless extra properties on the array.
  items.skipped = skipped
  items.unusableUrl = unusableUrl
  return items
}

// The newer array shape needs its own reader rather than the generic walk
// below. In it, a collection's members hang off a wrapper entry literally
// titled "Media", with further wrappers titled "Hashtags"/"Owner" inside each
// post — and the generic walk treats ANY titled node as a nested collection.
// Run through it, every real collection came back empty and every post in the
// export collapsed into one bogus collection named "Media". Here, titles are
// known to be structural: only a `label_values` Name row names a collection,
// and everything below a row is that row's members.
function isLabelValuesCollections(json) {
  return Array.isArray(json) && json.some((row) => labelValuesName(row))
}

function parseCollectionsLabelValues(rows) {
  const map = new Map()
  let truncated = false
  let retained = 0

  // Same depth/count bounding as the generic walk — this reads the same
  // untrusted upload, so a hostile export must degrade, not crash.
  function collect(node, out, depth) {
    if (depth > MAX_WALK_DEPTH) { truncated = true; return }
    if (Array.isArray(node)) { for (const v of node) collect(v, out, depth + 1); return }
    if (!node || typeof node !== 'object') return
    if (isUsableHref(node.href)) out.push(node.href)
    for (const v of Object.values(node)) collect(v, out, depth + 1)
  }

  for (const row of rows) {
    const name = labelValuesName(row)
    if (!name) continue
    const hrefs = []
    collect(row, hrefs, 0)
    if (!hrefs.length) continue
    const set = map.get(name) || new Set()
    for (const h of hrefs) {
      if (retained >= MAX_COLLECTION_HREFS) { truncated = true; break }
      if (!set.has(h)) retained++
      set.add(h)
    }
    if (set.size) map.set(name, set)
  }
  map.truncated = truncated
  return map
}

// Collections shapes vary by export version, so instead of pinning a schema we
// deep-walk: any object owning a name-ish string AND (transitively) a list of
// instagram hrefs becomes a collection. Unknown shapes → empty map, never an error.
export function parseCollections(json) {
  if (isLabelValuesCollections(json)) return parseCollectionsLabelValues(json)
  const map = new Map()
  let truncated = false
  let retained = 0 // total distinct href memberships committed to `map` so far — see MAX_COLLECTION_HREFS

  // Stops descending into a child node that carries its own name AND is not
  // itself a link entry — that child is a nested collection in its own right
  // (walk() below visits it separately), so its hrefs must not also be
  // attributed to the wrapper. Without this, `{title:'Saved',
  // groups:[{title:'Recipes',...}]}` would transitively own every href in
  // every nested collection.
  //
  // A node that itself carries an href is a LEAF LINK ENTRY, never a
  // collection — `title` is ubiquitous in Meta exports (it's the poster
  // username on every saved_posts.json row too), so without this exception a
  // collection like `{title:'Recipes', list:[{title:'natgeo', href:A}]}`
  // would have its href stolen into an invented "natgeo" collection instead
  // of staying under "Recipes".
  function collectHrefs(node, out, depth, isTop) {
    if (depth > MAX_WALK_DEPTH) { truncated = true; return }
    if (Array.isArray(node)) { for (const v of node) collectHrefs(v, out, depth + 1, false); return }
    if (node && typeof node === 'object') {
      if (!isTop && !isHttpUrl(node.href) && nodeName(node)) return // nested wrapper collection — claimed separately by walk()
      if (isHttpUrl(node.href)) out.push(node.href)
      for (const v of Object.values(node)) collectHrefs(v, out, depth + 1, false)
    }
  }

  const walk = (node, depth) => {
    if (depth > MAX_WALK_DEPTH) { truncated = true; return }
    if (Array.isArray(node)) { for (const v of node) walk(v, depth + 1); return }
    if (!node || typeof node !== 'object') return
    // An href-bearing node is a link entry, not a collection, even if it
    // happens to carry a `title` (the poster's username, typically).
    const name = isHttpUrl(node.href) ? null : nodeName(node)
    if (name) {
      const hrefs = []
      collectHrefs(node, hrefs, depth + 1, true)
      if (hrefs.length) {
        const set = map.get(name) || new Set()
        for (const h of hrefs) {
          if (retained >= MAX_COLLECTION_HREFS) { truncated = true; break }
          if (!set.has(h)) retained++
          set.add(h)
        }
        if (set.size) map.set(name, set)
      }
    }
    // Keep walking children even after claiming — a claimed node's own
    // children can be separate nested collections (see collectHrefs above).
    for (const v of Object.values(node)) walk(v, depth + 1)
  }
  walk(json, 0)
  map.truncated = truncated // read by parse() for the "too deeply nested" warning; a harmless extra property on the Map
  return map
}

export function parse(files) {
  let items = []
  const collections = new Map()
  const warnings = []
  let remaining = MAX_ITEMS
  let itemsSkippedByCap = 0
  let itemsWithUnusableUrl = 0
  let collectionsTruncated = false

  for (const [key, buf] of files) {
    if (SAVED_POSTS_FILE.test(key)) {
      const json = tryJson(buf)
      if (!json) { warnings.push(`${key} could not be parsed`); continue }
      const parsed = parseSavedPosts(json, remaining)
      items = items.concat(parsed)
      remaining -= parsed.length
      itemsSkippedByCap += parsed.skipped || 0
      itemsWithUnusableUrl += parsed.unusableUrl || 0
      // A file that parses fine but yields nothing recognizable (wrong
      // top-level shape, or every row lacking a usable href) would otherwise
      // silently report "imported 0" with no explanation — unless that's
      // already explained by one of the cap/unusable-url warnings above.
      if (parsed.length === 0 && !parsed.skipped && !parsed.unusableUrl) {
        warnings.push(`${key} contains no recognizable saved posts`)
      }
    } else if (COLLECTIONS_FILE.test(key)) {
      const json = tryJson(buf)
      if (!json) { warnings.push(`${key} could not be parsed`); continue }
      const parsed = parseCollections(json)
      if (parsed.truncated) collectionsTruncated = true
      for (const [n, set] of parsed) {
        const existing = collections.get(n)
        if (existing) for (const h of set) existing.add(h)
        else collections.set(n, set)
      }
    }
  }

  // Corrupt JSON, unrecognized shapes, the item cap, oversized URLs, and the
  // walk-depth cap all still produce a well-formed result below — without
  // these, silent truncation would read as full success to the user (e.g.
  // 150k saved posts quietly becoming 100k). Task 5's route surfaces these.
  if (itemsSkippedByCap > 0) warnings.push(`item cap reached; ${itemsSkippedByCap} posts skipped`)
  if (itemsWithUnusableUrl > 0) warnings.push(`${itemsWithUnusableUrl} posts had an unusable URL`)
  if (collectionsTruncated) warnings.push('some collections were too deeply nested to read')

  // Membership is emitted as { name, urls } — the collection's OWN hrefs —
  // rather than joined onto the items above. The route resolves each url
  // against its canonical-url index, which is seeded from every note already
  // in the database as well as the ones added by this run. Joining here
  // instead would silently make the feature order-dependent: a
  // saved_collections.json imported after its posts carries no items of its
  // own, so every Space would come back empty even though every post it
  // names is already saved.
  //
  // A post can legitimately live in several IG collections at once, and
  // Kothai's own collections already support multi-membership (see
  // server/data/collections.js), so a url simply appears under each.
  return {
    items,
    collections: [...collections].map(([name, set]) => ({ name, urls: [...set] })),
    warnings,
  }
}

// Classifies by URL PATHNAME only — matching against the raw URL string would
// let a query string like `?ref=/tv/` on a plain post link misclassify it as
// a video.
function isReelUrl(url) {
  let pathname = url
  try { pathname = new URL(url).pathname } catch { /* keep raw string if URL parsing ever fails post-validation */ }
  return /\/(reels?|tv)\//.test(pathname)
}

// Import item → phase-one note fields (store.addNote spread overrides its
// defaults, so createdAt here wins — imports keep their IG saved-on date and
// interleave into the timeline where they belong).
export function deriveNote(item) {
  const isReel = isReelUrl(item.url)
  // Total guard: deriveNote can be called directly (e.g. in tests, or by a
  // future caller) with input that bypassed parseSavedPosts' own timestamp
  // sanitization, so re-run the same MAX_TS/finiteness bounding here rather
  // than trusting the caller. A bare `Number.isFinite` check is NOT enough —
  // it still admits e.g. 1e300, and `new Date(1e300 * 1000).toISOString()`
  // throws RangeError just like Infinity does (anything past ~8.64e12
  // seconds is out of Date's representable range). normalizeTimestamp is
  // idempotent on an already-normalized value, so re-applying it here is safe.
  const savedAt = normalizeTimestamp(item.savedAt)
  return {
    type: isReel ? 'video' : 'link',
    title: `@${item.poster || 'instagram'} · ${isReel ? 'Reel' : 'Post'}`,
    content: item.url, // enrich reads `content` as the note's text
    url: item.url,
    tags: ['instagram'],
    account: item.poster || null,
    createdAt: savedAt > 0 ? new Date(savedAt * 1000).toISOString() : new Date().toISOString(),
    importedAt: new Date().toISOString(),
    pending: true,
  }
}

// One-time migration for notes imported before `account` was a first-class
// field: the poster username only ever landed inside the title string
// (`@handle · Reel`/`@handle · Post`, see deriveNote above). Anchored to the
// exact shape deriveNote produces so it can't misfire on an unrelated title
// that merely starts with "@something". Used by notes.js's load() migration,
// mirroring backlog.js's deriveAiMarkers pattern.
const TITLE_ACCOUNT_RE = /^@(\S+) · (?:Reel|Post)$/
export function deriveAccountFromTitle(title) {
  const m = TITLE_ACCOUNT_RE.exec(String(title || ''))
  return m ? m[1] : null
}
