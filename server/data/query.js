// Pure filter / facet / page arithmetic for the notes query endpoint.
// Operates on raw ServerNote records; no store or HTTP imports, so every
// function here is unit-testable with plain arrays.

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

// Mirror of client/domain/source.ts SOURCES. Kept in sync by the parity test in
// test/source.test.ts — this is the one place those predicates are
// duplicated, and facet counts are wrong if they drift.
const PLATFORM_TESTS = [
  ['github', (n) => /(^|\.)github\.com$/.test(hostOf(n.url || ''))],
  ['reels', (n) => /instagram\.com\/reel/i.test(n.url || '')],
  ['igposts', (n) => /instagram\.com\/p\//i.test(n.url || '')],
  ['x', (n) => /(^|\.)(twitter\.com|x\.com)$/.test(hostOf(n.url || ''))],
  ['tiktok', (n) => /(^|\.)tiktok\.com$/.test(hostOf(n.url || ''))],
  ['reddit', (n) => /(^|\.)reddit\.com$/.test(hostOf(n.url || ''))],
]

export function sourceKey(n) {
  for (const [key, t] of PLATFORM_TESTS) if (t(n)) return key
  if ((n.type === 'link' || n.type === 'video') && hostOf(n.url || '')) return 'web'
  return null
}

// Case-insensitive substring over the same fields the client filter used:
// content, titles, descriptions, tags, host.
export function matchesQ(n, q) {
  const hay = [n.content, n.title, n.siteTitle, n.siteDesc, (n.tags || []).join(' '), hostOf(n.url || '')]
    .filter(Boolean).join(' ').toLowerCase()
  return hay.includes(q.toLowerCase())
}

// Narrow `notes` (already in canonical order) by any of: server type, source
// key, substring query, membership id-set. Absent params skip their filter.
// `type` and `source` accept a single value or a comma-separated list. The
// semantics are ordinary faceted search: OR **within** a facet, AND **across**
// them — picking Instagram and TikTok widens to either, while adding Videos
// narrows that to the videos among them. A list that ANDed within a facet
// would always be empty (nothing is both a video and a note).
function toList(v) {
  if (Array.isArray(v)) return v.filter(Boolean)
  if (typeof v === 'string' && v) return v.split(',').map((s) => s.trim()).filter(Boolean)
  return []
}

export function applyFilters(notes, { type, source, q, collection, unavailable } = {}) {
  let out = notes
  if (collection) out = out.filter((n) => collection.has(n.id))
  const types = toList(type)
  if (types.length) out = out.filter((n) => types.includes(n.type))
  const sources = toList(source)
  if (sources.length) out = out.filter((n) => sources.includes(sourceKey(n)))
  // Three states, not a boolean, because "don't filter on this at all" is a
  // real case: the facet base has to still SEE unavailable notes or the chip
  // that reveals them would always read 0.
  //
  //   'hide' (default) — a dead link is not something to meet in the middle of
  //                      an ordinary browse, so it is out unless asked for
  //   'only'           — what the Unavailable chip selects
  //   'all'            — no availability filtering; used for counting
  //
  // Cuts ACROSS type and source rather than being one of them: a dead link can
  // be a video or a post from any platform. It is a state of the note, not a
  // kind of note.
  const avail = unavailable === true ? 'only' : (unavailable || 'hide')
  if (avail === 'only') out = out.filter((n) => !!n.unavailable)
  else if (avail !== 'all') out = out.filter((n) => !n.unavailable)
  if (q && q.trim()) out = out.filter((n) => matchesQ(n, q.trim()))
  return out
}

// Counts describe what a chip would actually SHOW you. Since the board hides
// unavailable notes by default, the type and source counts are taken over the
// available ones only — otherwise "TikTok 198" would open a board of 177 and
// the difference would look like a bug. `unavailable` is the odd one out and is
// counted over everything, because it is the count of what is being hidden.
export function facetsOf(notes) {
  const types = {}
  const sources = {}
  let unavailable = 0
  for (const n of notes) {
    if (n.unavailable) { unavailable++; continue }
    types[n.type] = (types[n.type] || 0) + 1
    const s = sourceKey(n)
    if (s) sources[s] = (sources[s] || 0) + 1
  }
  return { types, sources, unavailable }
}

// Board ordering, by the date a note carries on its tile — `createdAt`, which
// is when it was saved originally (an importer takes it from the export, so a
// reel keeps its 2024 date rather than the day it was imported).
//
//   'newest' (default) — most recent first
//   'oldest'           — the other way round
//
// Before this the board had no sort at all: notes came back in INSERTION order
// (`ORDER BY seq DESC`), which looks right for hand-saved notes and is
// meaningless for a bulk import, where 197 rows land in one second in whatever
// order the export file listed them. That is why the top of an imported
// library was its OLDEST items, each captioned "8 months ago", while the tiles
// showed a date the order plainly did not follow.
const SORTS = new Set(['newest', 'oldest'])

function timeOf(v) {
  const t = Date.parse(v || '')
  return Number.isFinite(t) ? t : 0
}

export function sortNotes(notes, sort) {
  const oldestFirst = sort === 'oldest'
  if (!SORTS.has(sort) && sort) sort = 'newest' // unknown value: fall back rather than throw
  // Copied, never sorted in place: this array belongs to the note store, and
  // reordering it would quietly reorder every other reader's view too.
  // Ties break on INSERTION order, which is the order `notes` already arrives
  // in (the store keeps newest-first). Two reasons it has to break somewhere:
  // a bulk import gives thousands of rows the same date, and two notes saved
  // in the same second are ordinary — without a tiebreak the comparator is
  // unstable, so paging can show one note twice and drop another between
  // requests. Insertion order is the right one rather than, say, id, because
  // for same-second notes it still means "most recently added first", which is
  // what someone who just saved something expects to see at the top.
  const out = notes.map((n, i) => [n, i])
  out.sort((x, y) => {
    const d = timeOf(x[0].createdAt) - timeOf(y[0].createdAt)
    if (d) return oldestFirst ? d : -d
    return oldestFirst ? y[1] - x[1] : x[1] - y[1]
  })
  return out.map((e) => e[0])
}

export function pageOf(notes, offset, limit) {
  const off = Math.max(0, Math.floor(offset) || 0)
  return notes.slice(off, off + Math.max(1, Math.min(500, Math.floor(limit) || 120)))
}
