// Which tags to offer as smart rules for a space, ranked.
//
// Five behaviours in four lines, all of them previously inline in
// CollectionView's render and none of them covered:
//
//   - tags already used as a rule are excluded, so the list never offers
//     something that would be a no-op
//   - the count is how many of the space's current items carry the tag
//   - ranking is count descending, then alphabetical, so equal counts have a
//     stable order rather than Map insertion order
//   - a typed query filters by substring, not prefix
//   - "add this as a new tag" is offered only when the query is non-empty, is
//     not already a rule, and is not already in the list — otherwise the user
//     would be offered two ways to do the same thing
import type { UIItem } from '../types'

export interface TagSuggestion { tag: string; count: number }

// `poolSize` is the number of distinct candidate tags BEFORE the query filter.
// It is what lets the empty state tell "your search matched nothing" apart from
// "there is nothing here to match" — two different things to say to a reader.
export function suggestTags(
  items: readonly UIItem[],
  ruleTags: readonly string[],
  query: string,
  limit = 8,
): { suggestions: TagSuggestion[]; canAddNew: boolean; poolSize: number } {
  const rules = new Set(ruleTags)
  const q = query.trim().toLowerCase()
  const counts = new Map<string, number>()
  for (const it of items) {
    for (const t of it.tags || []) {
      if (!rules.has(t)) counts.set(t, (counts.get(t) || 0) + 1)
    }
  }
  const suggestions = [...counts.entries()]
    .filter(([t]) => !q || t.includes(q))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([tag, count]) => ({ tag, count }))
  const canAddNew = Boolean(q) && !rules.has(q) && !suggestions.some((s) => s.tag === q)
  return { suggestions, canAddNew, poolSize: counts.size }
}
