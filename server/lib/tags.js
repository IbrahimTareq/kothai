// Single source of truth for tag handling. Pure — no store/model dependency —
// so generation (qvac), collection matching, and manual edits all canonicalize
// tags the exact same way. Conservative normalization only: no singularization,
// no synonym maps (deferred).

// Canonicalize one tag: lowercase, trim, collapse internal whitespace runs to a
// single hyphen, collapse repeated hyphens, strip stray leading/trailing ones.
// Returns '' for empty/junk input.
export function normalizeTag(tag) {
  return String(tag == null ? '' : tag)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// Normalize a list: drop empties, dedup preserving first-seen order, cap to max.
export function normalizeTags(tags, { max } = {}) {
  const out = []
  const seen = new Set()
  for (const t of Array.isArray(tags) ? tags : []) {
    const n = normalizeTag(t)
    if (!n || seen.has(n)) continue
    seen.add(n)
    out.push(n)
  }
  return max ? out.slice(0, max) : out
}

// Pull #hashtag tokens out of free text (an Instagram caption, say) as
// candidate tags. The creator already labeled these — classify() gets a
// head start reusing them directly instead of having to notice and
// re-extract them from unstructured prose. Deliberately not auto-applied as
// real tags: the caller still runs these through the LLM (and its junk-tag
// filter) same as any other candidate, since a hashtag can just as easily be
// engagement/platform noise (#fyp, #viral) as a real topic. Unicode-aware so
// non-Latin hashtags (Arabic, Indonesian, ...) aren't silently dropped.
export function extractHashtags(text) {
  const out = []
  const seen = new Set()
  for (const m of String(text || '').matchAll(/#([\p{L}\p{N}_]+)/gu)) {
    const t = normalizeTag(m[1])
    if (t && !seen.has(t)) {
      seen.add(t)
      out.push(t)
    }
  }
  return out
}

// Top-N most-used tags across all notes, normalized then counted so variants
// (e.g. "ML" and "ml") tally together. Ordered by count desc, then name asc for
// deterministic output. Fed to the classify prompt to encourage reuse.
export function buildVocabulary(notes, { limit = 60 } = {}) {
  const counts = new Map()
  for (const n of Array.isArray(notes) ? notes : []) {
    for (const t of normalizeTags(n?.tags)) {
      counts.set(t, (counts.get(t) || 0) + 1)
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([tag]) => tag)
}

// Prepend a note's source account as a literal `@handle` tag. Deterministic —
// bypasses the LLM, the junk-tag filter, and tagvocab's embedding-based
// canonicalization entirely, since a handle is an identity, not a concept to
// judge as junk or snap to a semantic neighbor. No-op if there's no account
// or the tag is already present (idempotent across repeated classify runs).
export function withAccountTag(tagList, account) {
  if (!account) return tagList
  const t = normalizeTag('@' + account)
  if (!t || tagList.includes(t)) return tagList
  return [t, ...tagList]
}
