// The outbound half of link metadata: the one fetch every scrape goes through,
// and the thumbnail download that writes what it finds into data/uploads.
// Shared by the generic link path (meta.ts) and the Instagram one, which is
// why it is not in either.
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { UPLOAD_DIR } from '../config.ts'
import { safeFetch } from '../lib/ssrf.ts'

const FETCH_TIMEOUT_MS = 8000
export const MAX_HTML = 1024 * 1024 // only scan the first 1 MB for meta tags
const MAX_THUMB = 5 * 1024 * 1024
// Long edge, in pixels, of every stored thumbnail. The largest place one is
// drawn is the 620px article hero in the expanded view, and cards are ~250px,
// so 960 covers both on a 2x screen with one file.
const THUMB_EDGE = 960
const UA = 'Mozilla/5.0 (compatible; Kothai/1.0; local notes app)'

// A cheap synchronous http(s)-only check, used to filter scraped URL lists
// (parseInstagramCarousel) before any of them is worth a fetch. It says nothing
// about where a URL points — http://169.254.169.254 passes it — so it is a
// pre-filter, never the guard. safeFetch(), inside get() below, is the guard.
export function isSafeFetchUrl(url: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol)
  } catch {
    return false
  }
}

// The one outbound fetch in the whole server: every og:image scrape, oEmbed
// lookup, Instagram embed page and thumbnail download goes through here, and
// all of those URLs come from content the user did not write. safeFetch applies
// the SSRF guard (see server/lib/ssrf.ts) to this URL and to every redirect hop.
//
// One AbortSignal covers the entire redirect chain rather than each hop, so a
// server that redirects slowly forever still cannot hold a request open past
// FETCH_TIMEOUT_MS.
//
// Exported so tests can assert the guard is actually wired in here, not just
// that the predicates themselves are correct.
export async function get(url: string, accept: string): Promise<Response> {
  const res = await safeFetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'User-Agent': UA, Accept: accept },
  })
  if (!res.ok) {
    // The status rides on the error, not only in the message: availability
    // checking has to tell a definite "this is gone" (400/404/410) from a
    // "try later" (429/5xx), and parsing that back out of a string would
    // break the moment this message is reworded.
    const err: Error & { status?: number } = new Error(`HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  return res
}

// Whether a failed get() is worth asking again later. A rate limit, a server
// error and a dropped or timed-out connection pass; a 404, an address the SSRF
// guard refuses, and bytes that do not decode as an image do not, and retrying
// them would only hammer a host for an answer that cannot change.
export function isTransient(e: unknown): boolean {
  const status = typeof e === 'object' && e !== null && 'status' in e ? e.status : undefined
  if (typeof status === 'number') return status === 408 || status === 429 || status >= 500
  return e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError' || e.message === 'fetch failed')
}

export function decodeEntities(s: string): string {
  return (s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

// `key` names the file, not just the note: a note's own thumbnail keys off the
// bare note id, its carousel slides off `<noteId>-<i>`. Every file still starts
// `meta-` so the uploads wipe and the per-note delete sweep keep matching them.
// saveThumbSafe wraps saveThumb in the "a missing thumbnail is not a failure"
// policy — resolve against the page URL, swallow anything that goes wrong,
// answer null. saveThumb already returns null for a non-image or oversized
// body, so null was the existing failure value. Two callers stay open-coded
// because they need to tell failures apart: the carousel loop in
// fetchInstagramSlides, to keep the rest of the deck past a failed slide, and
// fetchLinkMeta, to retry an image that was only rate-limited (thumb-retry.ts).
export async function saveThumbSafe(thumbUrl: string, base: string, key: string): Promise<SavedThumb | null> {
  try {
    return await saveThumb(new URL(thumbUrl, base).href, key)
  } catch {
    return null
  }
}

// Named as the note fields they land in, so a caller can assign them straight
// on. `thumbRatio` is width over height: with it a card holds its shape before
// the image arrives, where it used to grow when the image loaded and repack
// the board around it.
interface SavedThumb {
  thumb: string
  thumbRatio: number
}

export async function saveThumb(url: string, key: string): Promise<SavedThumb | null> {
  const res = await get(url, 'image/*')
  const ct = res.headers.get('content-type') || ''
  if (!ct.startsWith('image/')) return null
  const buf = Buffer.from(await res.arrayBuffer())
  if (!buf.length || buf.length > MAX_THUMB) return null
  const { data, ext, width, height } = await shrinkThumb(buf)
  const name = `meta-${key}.${ext}`
  await writeFile(path.join(UPLOAD_DIR, name), data)
  return { thumb: `/uploads/${name}`, thumbRatio: Math.round((width / height) * 1000) / 1000 }
}

// Stored as published, the demo's twenty-one thumbnails came to 3.7 MB for
// cards ~250px wide: Wikipedia sends 1280px JPEGs of up to 510 KB, and NN/g an
// 8001x4188 PNG that costs the browser ~134 MB to decode. Shrunk once here,
// every later view, and every vision call that reads the file, pays for 960px.
//
// JPEG, or PNG when the image really is see-through (a logo flattened into a
// JPEG gets a box behind it). Never WebP, though it is smaller: local vision
// decodes these files with llama.cpp's stb_image, which cannot read it.
// rotate() applies the EXIF orientation before the metadata carrying it is
// dropped, or a phone photo lands on its side.
async function shrinkThumb(buf: Buffer) {
  const { hasAlpha } = await sharp(buf).metadata()
  const img = sharp(buf).rotate().resize(THUMB_EDGE, THUMB_EDGE, { fit: 'inside', withoutEnlargement: true })
  const png = hasAlpha && !(await img.clone().stats()).isOpaque
  const { data, info } = await (png ? img.png() : img.jpeg({ quality: 80, mozjpeg: true })).toBuffer({
    resolveWithObject: true,
  })
  return { data, ext: png ? 'png' : 'jpg', width: info.width, height: info.height }
}
