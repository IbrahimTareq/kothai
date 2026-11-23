// A TikTok post read off its own video page.
//
// TikTok's oEmbed stopped returning title, author_name and thumbnail_url
// around 2026-11-19 — it now answers with an iframe and nothing else — so a
// TikTok save was left titled by the shell page's "TikTok - Make Your Day",
// with no account and no picture. The video page still carries the post:
// asked for with Kothai's own UA it is server-rendered, the post sitting as
// JSON in a __UNIVERSAL_DATA_FOR_REHYDRATION__ script. A browser UA gets a
// 1.4 KB JS challenge instead, so swapping fetch.ts's UA for a browser's would
// break this. Checked live 2026-11-23, including the "@/" URL TikTok's share
// redirects land on. fetchLinkMeta fetches that page for its OpenGraph scrape
// anyway, so reading it costs no request of its own.
//
// The page is TikTok's to reshape: every field is read as unknown, and one
// that moved or changed type reads as absent rather than landing in a note.

// Lazy to the first </script>: the JSON escapes its own slashes as /,
// so a caption cannot close the tag early.
const DATA = /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/

function at(v: unknown, keys: string[]): unknown {
  for (const k of keys) v = typeof v === 'object' && v !== null ? Reflect.get(v, k) : undefined
  return v
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

// The handle (uniqueId), not the display name: it is what the TikTok importer
// stores as `account`, and the one that names the creator in their URLs. A
// removed video's page has no itemInfo, so all three come back null.
export function tiktokPost(html: string): { caption: string | null; author: string | null; cover: string | null } {
  let doc: unknown = null
  try {
    doc = JSON.parse(DATA.exec(html)?.[1] || 'null')
  } catch {
    // Not the page this was written against; nothing to read.
  }
  const post = at(doc, ['__DEFAULT_SCOPE__', 'webapp.video-detail', 'itemInfo', 'itemStruct'])
  return {
    caption: str(at(post, ['desc'])),
    author: str(at(post, ['author', 'uniqueId'])),
    cover: str(at(post, ['video', 'cover'])),
  }
}
