// nav + chips → the server query for the Everything board.
//
// This is the client half of a contract with server/data/query.ts, and it
// lived as four const declarations in the middle of App's render. The rules it
// encodes are not obvious and nothing checked them:
//
//   - Chips are multi-select and sorted into facets here. Selecting Instagram
//     AND TikTok widens to either; adding Videos then narrows that to the
//     videos among them — OR within a facet, AND across them.
//   - "unavailable" is a STATE, not a type or a source: a dead link can be any
//     type from any platform, so it rides as its own parameter and combines
//     with whatever else is selected rather than replacing it.
//   - A direct type-nav (/video) filters server-side and OUTRANKS the type
//     chips, which is why navType is checked first.
//
// `knownTypes` is passed in rather than imported so this module stays free of
// components/icons.tsx, which carries JSX and cannot be loaded by node --test.
import type { PagerQuery } from '../data/pager'

// Navs that are their own screen rather than a filtered board.
const NON_BOARD_NAVS = new Set(['core', 'settings', 'spaces'])

export function isBoardNav(nav: string): boolean {
  return !NON_BOARD_NAVS.has(nav) && !nav.startsWith('space:')
}

export function boardQuery(
  nav: string,
  chips: readonly string[],
  search: string,
  sort: string,
  knownTypes: ReadonlySet<string>,
  isSourceKey: (key: string) => boolean,
): { query: PagerQuery; active: boolean } {
  const unavailable = chips.includes('unavailable') || undefined
  const source = chips.filter(isSourceKey).join(',') || undefined
  const chipType = chips.filter(k => k !== 'unavailable' && !isSourceKey(k)).join(',') || undefined
  const navType = nav !== 'all' && !nav.startsWith('space:') && knownTypes.has(nav) ? nav : undefined
  return {
    query: { type: navType ?? chipType, source, q: search, unavailable, sort },
    active: isBoardNav(nav),
  }
}
