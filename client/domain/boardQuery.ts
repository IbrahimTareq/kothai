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
import type { UIItem } from '../types'
import { SOURCE_BY_KEY } from './source.ts'

// Navs that are their own screen rather than a filtered board.
const NON_BOARD_NAVS = new Set(['core', 'settings', 'spaces'])

function isBoardNav(nav: string): boolean {
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

export interface PagerQuery {
  type?: string
  source?: string
  q?: string
  collection?: string
  unavailable?: boolean
  sort?: string
}

// Client mirror of the server-side filter, for deciding whether an
// optimistically saved note belongs in the current view.
export function matchesLocal(item: UIItem, query: PagerQuery): boolean {
  // Collection membership can't be mirrored client-side — an item alone
  // doesn't say which collections it belongs to, unlike type/source/q which
  // are derivable from the item itself. Without this guard, applyDelta's
  // "is this unknown note newer than what's loaded" check would treat any
  // vault-wide change as belonging to the open collection and leak unrelated
  // items into its board. Members added while a Space is open show up next
  // full fetch instead (Space.tsx's CollectionView already handles removal
  // locally via removeLocal, so this only affects the addition path).
  if (query.collection) return false
  // Mirrors applyFilters' OR-within-a-facet: a note matches if it is ANY of the
  // selected types, and from ANY of the selected sources.
  const types = (query.type || '').split(',').filter(Boolean)
  if (types.length && !types.includes(item.type)) return false
  // Mirrors applyFilters' default: a dead link stays out of an ordinary view
  // and only appears when explicitly asked for.
  if (query.unavailable ? !item.unavailable : item.unavailable) return false
  const sources = (query.source || '').split(',').filter(Boolean)
  if (sources.length && !sources.some(k => SOURCE_BY_KEY[k]?.test(item))) return false
  if (query.q?.trim()) {
    const hay = [item.title, item.note, item.host, (item.tags || []).join(' ')].filter(Boolean).join(' ').toLowerCase()
    if (!hay.includes(query.q.trim().toLowerCase())) return false
  }
  return true
}
