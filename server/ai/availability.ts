// Does a saved link's content still exist?
//
// Asked ONLY of hosts whose metadata endpoint answers unambiguously, because
// the cost of being wrong is deleting something the user chose to keep.
//
// TikTok's oEmbed qualifies: 400 for a removed video, 200 with a caption for a
// live one. Measured against a real library of 198 saved TikToks with no
// disagreement. The PAGE does not qualify and must never be used — TikTok
// serves its /404 page to any non-browser client with HTTP **200**, live
// videos included, so "does the URL 404?" would condemn an entire library.
//
// Instagram is deliberately excluded. There is no open oEmbed; the embed
// scrape sits behind a >=2.5s throttle precisely because Instagram soft-bans,
// and a soft-ban is indistinguishable from a deleted post. A wrong guess there
// is a deleted real save, so the answer is simply "unknown".
import { oembedEndpoint, get } from './meta.ts'

export const ALIVE = 'alive'
export const DEAD = 'dead'
export const UNKNOWN = 'unknown'

type Availability = typeof ALIVE | typeof DEAD | typeof UNKNOWN

const CHECKABLE_HOST = /(^|\.)tiktok\.com$/

// Statuses that mean the CONTENT is gone, as opposed to the request failing.
// A 429, a 5xx, a timeout or a DNS error is the sweep's problem, never the
// note's — those return UNKNOWN and the note is left exactly as it was.
const GONE = new Set([400, 404, 410])

// A thrown value is `unknown`, and meta.ts's get() hangs the HTTP status on
// the error it throws (see the comment there). Local rather than shared: the
// security floor in server/lib/ is the only place a shared guard would belong,
// and putting one there needs a test that fails without it.
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

// Narrows as well as answers: everything below it needs the url as a string,
// and this is where the `typeof` check that proves it already lives.
export function isCheckable(url: string | null): url is string {
  if (typeof url !== 'string' || !url) return false
  try {
    return CHECKABLE_HOST.test(new URL(url).hostname.toLowerCase()) && !!oembedEndpoint(url)
  } catch {
    return false
  }
}

export async function checkAvailability(url: string | null): Promise<Availability> {
  if (!isCheckable(url)) return UNKNOWN
  const endpoint = oembedEndpoint(url)
  if (!endpoint) return UNKNOWN
  try {
    const res = await get(endpoint, 'application/json')
    // A 200 that isn't JSON is not a confirmation of anything — an error page
    // or a captcha interstitial would sail through on status alone.
    await res.json()
    return ALIVE
  } catch (e) {
    const status = isRecord(e) ? e.status : undefined
    return typeof status === 'number' && GONE.has(status) ? DEAD : UNKNOWN
  }
}
