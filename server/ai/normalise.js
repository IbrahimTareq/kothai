// Provider-independent post-processing for model output, plus the heuristic
// fallbacks used when no model is available (or when one returns garbage).
//
// Pure: no SDK, no HTTP. Both providers run their raw model output through
// normaliseClassification, so a note classified on-device and one classified
// remotely land in the same shape with the same junk filtering applied.
import { normalizeTags } from '../lib/tags.js'
import { NOTE_TYPES } from './prompts.js'

// Platform / engagement / filler words the model tends to emit for social links.
// They carry no retrieval value, so we drop them from generated tags (not from
// user-entered ones). Kept narrow on purpose — real topic words (shop, gift,
// travel, quran) are NOT here.
const JUNK_TAGS = new Set([
  'instagram', 'insta', 'ig', 'ins', 'tiktok', 'youtube', 'reel', 'reels', 'video', 'post', 'repost',
  'link', 'url', 'website', 'social', 'socialmedia',
  'fyp', 'foryou', 'foryoupage', 'viral', 'trending', 'trend', 'explore', 'explorepage',
  'follow', 'followers', 'like', 'likes', 'share', 'comment', 'subscribe', 'giveaway',
  'ad', 'ads', 'sponsored', 'promo', 'promotion', 'packingorders', 'packing',
  'content', 'info', 'information', 'article', 'misc', 'general', 'stuff', 'random', 'update',
])

// normalizeTag always hyphenates whitespace ("social media" -> "social-media"),
// but several JUNK_TAGS entries are written as one compressed word
// ("socialmedia", "foryoupage") — comparing hyphen-stripped catches the model
// phrasing a junk concept with spaces instead of jamming it into one word,
// without needing every entry duplicated in both forms. Exported for tests —
// classify() itself does real model I/O, so this pure filter is the
// testable surface for what would otherwise be an unverified regex.
// Strip a reasoning model's chain-of-thought from a free-text answer.
//
// Qwen3-VL and friends emit a <think>…</think> block before the answer, and
// nothing downstream wants it: it gets stored on the note, embedded, and shown
// to the user as the description of their image. The completion API can
// separate it (captureThinking), but only for callers that ask — and a model
// that runs out of tokens mid-thought never closes the tag at all, which is
// why the unclosed case is handled too rather than left to leak everything.
export function stripThinking(text) {
  const s = (text || '').replace(/<think>[\s\S]*?<\/think>/gi, '')
  // An unterminated block means the whole remainder is thinking; there is no
  // answer in it to keep.
  const open = s.search(/<think>/i)
  return (open === -1 ? s : s.slice(0, open)).trim()
}

export function isJunkTag(t) {
  return JUNK_TAGS.has(t) || JUNK_TAGS.has(t.replace(/-/g, ''))
}

// Exported for tests — classify() itself does real model I/O, so this pure
// post-processing (type fallback, length caps, junk filtering) is the
// testable surface for what the model's raw JSON gets turned into.
export function normaliseClassification(p, { hasImage, isUrl, text }) {
  let type = NOTE_TYPES.includes(p.type) ? p.type : null
  // A note whose whole content is a URL is a link (or a video), as a matter of
  // fact rather than of judgement — and the model does sometimes answer "text"
  // for one, having read the fetched page and decided the *content* is prose.
  // That answer strands a saved article as a plain note: the card falls back to
  // the note layout, so the page title, the thumbnail and the article stage all
  // go unused even though enrichment fetched every one of them.
  //
  // Only "text" and "code" are overruled. "image" is a real answer for a URL
  // that points straight at a picture — one the heuristic gets wrong, since it
  // classifies by the URL alone and calls that a link.
  if ((!type || type === 'text' || type === 'code') && (isUrl || isLikelyUrl(text))) {
    type = heuristicType({ hasImage, isUrl, text })
  }
  if (!type) type = heuristicType({ hasImage, isUrl, text })
  return {
    type,
    category: (p.category || 'General').toString().slice(0, 40),
    title: (p.title || deriveTitle(text) || 'Untitled').toString().slice(0, 120),
    summary: (p.summary || '').toString().slice(0, 400),
    // max:15 pre-filter headroom, not the final 10-tag cap: the prompt asks
    // for 6-10, and junk-tag filtering below can otherwise eat into that
    // floor (e.g. the model gives 10, 2 are junk platform words, and a
    // max:10 pre-filter cap would leave only 8 — silently missing the
    // "never fewer than 6-10" target for no good reason).
    tags: normalizeTags(p.tags, { max: 15 }).filter((t) => !isJunkTag(t)).slice(0, 10),
  }
}

// ---- helpers / fallbacks ----------------------------------------------
export function heuristicType({ hasImage, isUrl, text }) {
  if (hasImage) return 'image'
  const t = (text || '').trim()
  if (isUrl || /^https?:\/\/\S+$/i.test(t)) {
    if (/youtube\.com|youtu\.be|vimeo\.com|tiktok\.com|\.mp4(\?|$)/i.test(t)) return 'video'
    return 'link'
  }
  if (/```/.test(t) || /^(function|const|let|var|import|class|def |public |#include|<\?php|SELECT )/m.test(t)) return 'code'
  return 'text'
}

export function deriveTitle(text) {
  const t = (text || '').trim().replace(/\s+/g, ' ')
  return t.slice(0, 60)
}

export function isLikelyUrl(text) {
  return /^https?:\/\/\S+$/i.test((text || '').trim())
}

// Pull the first URL out of free text (e.g. "check this out www.foo.com/bar").
// Used when classification decides a note is a link/video but the text wasn't
// purely a URL, so the card still gets something to open.
export function extractUrl(text) {
  const t = text || ''
  const m = /https?:\/\/[^\s<>"')\]]+/i.exec(t)
  if (m) return m[0].replace(/[.,;:!?]+$/, '')
  const w = /\bwww\.[^\s<>"')\]]+/i.exec(t)
  if (w) return 'https://' + w[0].replace(/[.,;:!?]+$/, '')
  // bare domain with a well-known TLD, e.g. "google.com" or "foo.dev/bar"
  const d = /\b[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)*\.(com|org|net|io|dev|app|ai|co|me|tv|gg|sh|xyz)(\/[^\s<>"')\]]*)?/i.exec(t)
  if (d) return 'https://' + d[0].replace(/[.,;:!?]+$/, '')
  return null
}
