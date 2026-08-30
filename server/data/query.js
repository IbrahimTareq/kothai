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
export function applyFilters(notes, { type, source, q, collection } = {}) {
  let out = notes
  if (collection) out = out.filter((n) => collection.has(n.id))
  if (type) out = out.filter((n) => n.type === type)
  if (source) out = out.filter((n) => sourceKey(n) === source)
  if (q && q.trim()) out = out.filter((n) => matchesQ(n, q.trim()))
  return out
}

export function facetsOf(notes) {
  const types = {}
  const sources = {}
  for (const n of notes) {
    types[n.type] = (types[n.type] || 0) + 1
    const s = sourceKey(n)
    if (s) sources[s] = (sources[s] || 0) + 1
  }
  return { types, sources }
}

export function pageOf(notes, offset, limit) {
  const off = Math.max(0, Math.floor(offset) || 0)
  return notes.slice(off, off + Math.max(1, Math.min(500, Math.floor(limit) || 120)))
}
