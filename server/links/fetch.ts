// The outbound half of link metadata: the one fetch every scrape goes through,
// and the thumbnail download that writes what it finds into data/uploads.
// Shared by the generic link path (meta.ts) and the Instagram one, which is
// why it is not in either.
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { UPLOAD_DIR } from '../config.ts'
import { safeFetch } from '../lib/ssrf.ts'

const FETCH_TIMEOUT_MS = 8000
export const MAX_HTML = 1024 * 1024 // only scan the first 1 MB for meta tags
const MAX_THUMB = 5 * 1024 * 1024
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
// policy its three callers each wrote out for themselves — resolve against the
// page URL, swallow anything that goes wrong, answer null. saveThumb already
// returns null for a non-image or oversized body, so null was the existing
// failure value at all three; this only stops the policy being re-decided per
// call site. (The carousel loop in fetchInstagramSlides deliberately stays
// open-coded: it needs to tell a failed slide from a skipped one to keep the
// rest of the deck.)
export async function saveThumbSafe(thumbUrl: string, base: string, key: string): Promise<string | null> {
  try {
    return await saveThumb(new URL(thumbUrl, base).href, key)
  } catch {
    return null
  }
}

export async function saveThumb(url: string, key: string): Promise<string | null> {
  const res = await get(url, 'image/*')
  const ct = res.headers.get('content-type') || ''
  if (!ct.startsWith('image/')) return null
  const buf = Buffer.from(await res.arrayBuffer())
  if (!buf.length || buf.length > MAX_THUMB) return null
  const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : ct.includes('gif') ? 'gif' : 'jpg'
  const name = `meta-${key}.${ext}`
  await writeFile(path.join(UPLOAD_DIR, name), buf)
  return `/uploads/${name}`
}
