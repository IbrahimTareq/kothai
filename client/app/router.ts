// router.ts — tiny history-based router mapping URL paths to Kothai's nav.
// No dependency: the whole app is one <App> switching on `nav`, so routing is
// just a bijection between that state and the pathname.

export interface Route { nav: string; item?: string; chat?: string }

// Storable types get their own filtered gallery at /type/<type>.
const TYPES = ['link', 'image', 'video', 'code', 'note']

// URL path → app state. Home and any unknown path land on Everything.
export function pathToRoute(pathname: string): Route {
  const seg = pathname.replace(/^\/+|\/+$/g, '').split('/')
  // An expanded tile is a trailing `/item/<id>` on whatever view it was opened
  // from (/item/<id>, /type/video/item/<id>, /space/<cid>/item/<id>), so the
  // underlying board survives a refresh and Back just closes the overlay.
  let item: string | undefined
  const at = seg.lastIndexOf('item')
  if (at >= 0 && seg.length === at + 2 && seg[at + 1]) {
    item = decodeURIComponent(seg[at + 1])
    seg.splice(at, 2)
    if (!seg.length) seg.push('')
  }
  const nav = navOf(seg)
  // An open conversation is part of the location: /ask/<chatId> makes a chat
  // shareable, survives a refresh, and gives Back something to return from.
  if (nav === 'core' && seg[1]) return { nav, chat: decodeURIComponent(seg[1]) }
  return item ? { nav, item } : { nav }
}

function navOf(seg: string[]): string {
  switch (seg[0]) {
    case '': return 'all'
    case 'everything': return 'all'
    case 'ask': return 'core'
    case 'spaces': return 'spaces'
    case 'settings': return 'settings'
    case 'type': return TYPES.includes(seg[1]) ? seg[1] : 'all'
    case 'space': return seg[1] ? 'space:' + seg[1] : 'all'
    default: return 'all'
  }
}

// App state → URL path. `core` is the Ask screen (the only remaining core view).
export function routeToPath(nav: string, item?: string): string {
  const base = baseOf(nav)
  if (!item) return base
  return (base === '/' ? '' : base) + '/item/' + encodeURIComponent(item)
}

// The Ask screen with a conversation open. Separate from routeToPath because a
// chat id hangs off /ask directly, where an item id hangs off /item.
export function chatPath(chatId: string | null): string {
  return chatId ? '/ask/' + encodeURIComponent(chatId) : '/ask'
}

function baseOf(nav: string): string {
  switch (nav) {
    case 'core': return '/ask'
    case 'all': return '/'
    case 'spaces': return '/spaces'
    case 'settings': return '/settings'
    default: return nav.startsWith('space:') ? '/space/' + nav.slice(6) : '/type/' + nav
  }
}
