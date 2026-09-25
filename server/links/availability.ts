// Does a saved link's content still exist?
//
// Asked ONLY of hosts whose answer was measured to separate "this is gone"
// from "the request failed", because the cost of being wrong is deleting
// something the user chose to keep.
//
// TikTok's oEmbed qualifies: 400 for a removed video, 200 with a caption for a
// live one. Measured against a real library of 198 saved TikToks with no
// disagreement. The PAGE does not qualify and must never be used — TikTok
// serves its /404 page to any non-browser client with HTTP **200**, live
// videos included, so "does the URL 404?" would condemn an entire library.
//
// YouTube and X oEmbed, measured 2026-09-26: YouTube answers 400 for a missing
// video, X 404 for a missing tweet, both 200 for a live one. A private video or
// protected account answers 401/403 — not gone, just not public — so those
// stay "unknown" with every other failure. That measurement was taken against
// the CANONICAL watch/status link and does not generalize: a tweet's own
// /photo/1 or /video/1 share link, and YouTube's /embed/<id> or /v/<id> link,
// answer oEmbed 404 for content that is very much alive — a first pass on
// this sweep read those as 'dead' and would have deleted live saves.
// isCanonicalShape below requires each host's link to match the specific
// shape that was actually measured; anything else stays 'unknown', same as a
// host that was never checked at all.
//
// Instagram has no open oEmbed, and was excluded until 2026-09-26 on the
// belief that a soft-ban is indistinguishable from a deleted post. The public
// embed page turns out to say so explicitly: both answer 200, but a missing
// post renders <div class="EmbedBrokenMedia"> ("the post may have been
// removed") while a live one renders its Caption and EmbeddedMediaImage. A
// soft-ban or login wall renders neither, so it reads as "unknown" — and so
// does a page carrying BOTH markers, since the real embed page was never
// observed in that state and a parser that calls it certain is more likely
// wrong than the page is self-contradictory. What the marker cannot separate
// is a deleted post from one whose account went private — which is why the
// Everything page says "deleted, or no longer public". Instagram fetches go
// through the single throttled queue, never a second fetcher: a soft-ban
// would stop captions on new saves too.
import { oembedEndpoint } from './meta.ts'
import { get } from './fetch.ts'
import { parseInstagramEmbed } from './instagram.ts'
import { queueIgEmbed } from './instagram-queue.ts'

export type Availability = 'alive' | 'dead' | 'unknown'

// Statuses that mean the CONTENT is gone, as opposed to the request failing.
// A 429, a 5xx, a timeout or a DNS error is the sweep's problem, never the
// note's — those return 'unknown' and the note is left exactly as it was.
const GONE = new Set([400, 404, 410])

const BROKEN_EMBED = /class="[^"]*\bEmbedBrokenMedia\b/

// Only /p/<id> and /reel/<id> — the two shapes the embed-page reading was
// measured against (the 2026-09-26 library: 377 /p/, 1,306 /reel/). As with
// X and YouTube, a shape that was not measured stays 'unknown': /reels/<id>
// and /tv/<id> are left out, and so is everything else instagram.com serves
// under those prefixes — /reels/audio/<id>/ is a page about a SONG, not a
// post. Deliberately narrower than isInstagramPost (server/links/
// instagram.ts): that function gates import-eligibility for callers this
// module has no say over, and narrowing it to match would change what the
// rest of the app treats as a savable Instagram link.
const IG_POST_PATH = /^\/(p|reel)\/[\w-]+\/?$/

// X's own share link for a single photo or video in a tweet
// (/status/<id>/photo/1, /video/1, …) is a DIFFERENT resource from the tweet
// oEmbed was measured against, and 404s regardless of whether the tweet is
// alive — so this must stop at the status id, not just require one to be
// present somewhere in the path.
const X_STATUS_PATH = /^\/[^/]+\/status\/\d+\/?$/

// /shorts/<id> and /live/<id> behave like /watch?v=<id> and were measured to
// match it. Bare /live (no id — a channel's live-now redirect), /live_chat,
// /embed/<id>, /v/<id> and /playlist all fall through to `false` below: none
// of them were part of the 2026-09-26 measurement, and /embed and /v in
// particular were found to 404 on live content.
const YT_SHORT_LIVE_PATH = /^\/(shorts|live)\/[\w-]+\/?$/

// youtu.be's whole path IS the video id (optionally with a trailing slash),
// so unlike youtube.com there is no separate "wrong resource under the same
// host" shape to exclude.
const YOUTU_BE_PATH = /^\/[\w-]+\/?$/

// A thrown value is `unknown`, and meta.ts's get() hangs the HTTP status on
// the error it throws (see the comment there). Local rather than shared: the
// security floor in server/lib/ is the only place a shared guard would belong,
// and putting one there needs a test that fails without it.
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function isCheckableInstagramPost(url: string): boolean {
  try {
    const u = new URL(url)
    return /(^|\.)instagram\.com$/.test(u.hostname.toLowerCase()) && IG_POST_PATH.test(u.pathname)
  } catch {
    return false
  }
}

// The host-plus-path shapes the oEmbed measurement actually covers (see the
// header). TikTok is exempt from the path check — its oEmbed was measured
// against the full range of real paths in a 198-post library, not one
// canonical shape.
function isCanonicalShape(u: URL): boolean {
  const host = u.hostname.toLowerCase()
  if (/(^|\.)tiktok\.com$/.test(host)) return true
  if (/(^|\.)(x\.com|twitter\.com)$/.test(host)) return X_STATUS_PATH.test(u.pathname)
  if (/(^|\.)youtube\.com$/.test(host)) {
    return (u.pathname === '/watch' && !!u.searchParams.get('v')) || YT_SHORT_LIVE_PATH.test(u.pathname)
  }
  if (/(^|\.)youtu\.be$/.test(host)) return YOUTU_BE_PATH.test(u.pathname)
  return false
}

// Narrows as well as answers: everything below it needs the url as a string,
// and this is where the `typeof` check that proves it already lives.
export function isCheckable(url: string | null): url is string {
  if (typeof url !== 'string' || !url) return false
  if (isCheckableInstagramPost(url)) return true
  try {
    return isCanonicalShape(new URL(url)) && !!oembedEndpoint(url)
  } catch {
    return false
  }
}

export async function checkAvailability(url: string | null): Promise<Availability> {
  if (!isCheckable(url)) return 'unknown'
  // Routes off the same check isCheckable used, rather than isInstagramPost,
  // so the two can never disagree about which URLs get the markup-reading
  // Instagram path versus the oEmbed one below.
  if (isCheckableInstagramPost(url)) return checkInstagram(url)
  const endpoint = oembedEndpoint(url)
  if (!endpoint) return 'unknown'
  try {
    const res = await get(endpoint, 'application/json')
    // A 200 that isn't JSON is not a confirmation of anything — an error page
    // or a captcha interstitial would sail through on status alone.
    await res.json()
    return 'alive'
  } catch (e) {
    const status = isRecord(e) ? e.status : undefined
    return typeof status === 'number' && GONE.has(status) ? 'dead' : 'unknown'
  }
}

// Read off the markup, never the status — the embed page answers 200 either
// way (see the header). Parses BEFORE deciding: a page with the broken
// marker and a caption/thumbnail (never seen for real, but not provably
// impossible) is 'unknown' rather than 'dead' — the marker alone is only
// trusted when nothing else on the page contradicts it.
async function checkInstagram(url: string): Promise<Availability> {
  let html: string
  try {
    html = await queueIgEmbed(url)
  } catch {
    return 'unknown'
  }
  const broken = BROKEN_EMBED.test(html)
  const { caption, thumbUrl } = parseInstagramEmbed(html)
  const hasContent = !!(caption || thumbUrl)
  if (broken) return hasContent ? 'unknown' : 'dead'
  return hasContent ? 'alive' : 'unknown'
}
