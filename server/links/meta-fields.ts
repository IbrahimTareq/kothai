// Which note fields a link-meta fetch contributes, and the copy that applies
// them to a pending patch.
//
// This list was spelled out at four call sites — the fast meta lane, the
// backfill job, enrichNote's applyLinkMeta and instagram-queue.ts's own lane — in four
// byte-identical loops, so adding a field to fetchLinkMeta meant remembering
// all four.
//
// It lives here rather than beside fetchLinkMeta in meta.ts because it is pure
// and meta.ts is not: eight test files replace meta.ts wholesale to keep the
// network out of a run, and a shape constant has no business being re-supplied
// by every one of those mocks just to let enrich.ts import it.
const META_FIELDS = ['siteTitle', 'siteDesc', 'siteName', 'thumb', 'thumbRatio', 'thumbSrc', 'article'] as const

export type MetaField = (typeof META_FIELDS)[number]

// Truthiness is the filter, not presence: a fetch that came back without a
// description must leave the one the note already has alone rather than
// blanking it. `author` is deliberately not here — it lands on a note as
// `account` under a condition (only when the note has none) that only the
// call site can judge.
export function applyMeta(
  patch: Record<string, unknown>,
  meta: Partial<Record<MetaField, unknown>>,
): Record<string, unknown> {
  for (const k of META_FIELDS) if (meta[k]) patch[k] = meta[k]
  return patch
}
