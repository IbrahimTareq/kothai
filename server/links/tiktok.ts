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
import { captionToMeta } from './instagram.ts'

// Lazy to the first </script>: TikTok writes every slash inside the JSON as
// a unicode escape, so no caption can contain a literal </script> and close
// the tag early.
const DATA = /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/

// tiktok.com and its subdomains (www., m., vm. short links). Any other site
// carrying a script by this id is not TikTok and is not read as a post.
const isTikTok = (url: string) => URL.canParse(url) && /(^|\.)tiktok\.com$/.test(new URL(url).hostname)

function at(v: unknown, keys: string[]): unknown {
  for (const k of keys) v = typeof v === 'object' && v !== null ? Reflect.get(v, k) : undefined
  return v
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

interface TikTokPost {
  siteTitle: string | null
  siteDesc: string | null
  author: string | null
  cover: string | null
}

// Null off TikTok. On it, every field is null when the page has no post — a
// removed video's page has no itemInfo — and the caller must then not fall
// back to the page's <title>: on TikTok that is always the shell's "TikTok -
// Make Your Day", never the post's.
//
// The caption is clipped as Instagram's is (captionToMeta): captions run to
// thousands of characters over many lines, and siteTitle becomes the card's
// provisional title. The author is the handle (uniqueId), not the display
// name: it is what the TikTok importer stores as `account`, and it lands
// there too, so anything that is not handle-shaped (letters, digits, _ and .)
// reads as absent.
export function tiktokPost(url: string, html: string): TikTokPost | null {
  if (!isTikTok(url)) return null
  let doc: unknown = null
  try {
    doc = JSON.parse(DATA.exec(html)?.[1] || 'null')
  } catch {
    // Not the page this was written against; nothing to read.
  }
  const post = at(doc, ['__DEFAULT_SCOPE__', 'webapp.video-detail', 'itemInfo', 'itemStruct'])
  // Logged, not thrown: a removed video lands here too, but so does TikTok
  // closing this path, and that would otherwise only show as blank cards.
  if (post === undefined) console.warn('[meta] no TikTok post data on the page for', url)
  const caption = str(at(post, ['desc']))
  const handle = str(at(post, ['author', 'uniqueId']))
  return {
    ...(caption ? captionToMeta(caption) : { siteTitle: null, siteDesc: null }),
    author: handle && /^[\w.]{1,64}$/.test(handle) ? handle : null,
    cover: str(at(post, ['video', 'cover'])),
  }
}
