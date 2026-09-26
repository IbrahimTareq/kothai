// Provider-independent post-processing for model output, plus the heuristic
// fallbacks used when no model is available (or when one returns garbage).
//
// Pure: no SDK, no HTTP. Both providers run their raw model output through
// normaliseClassification, so a note classified on-device and one classified
// remotely land in the same shape with the same junk filtering applied.
import type { NoteType } from '../types.ts'
import { normalizeTags } from '../data/tags.ts'

// The model's raw JSON answer, straight off a completion — every field is
// whatever came back, which is the reason this module exists at all.
interface RawClassification {
  type?: unknown
  category?: unknown
  title?: unknown
  summary?: unknown
  tags?: unknown
}

// Platform / engagement / filler words the model tends to emit for social links.
// They carry no retrieval value, so we drop them from generated tags (not from
// user-entered ones). Kept narrow on purpose — real topic words (shop, gift,
// travel, quran) are NOT here.
const JUNK_TAGS = new Set([
  'instagram',
  'insta',
  'ig',
  'ins',
  'tiktok',
  'youtube',
  'reel',
  'reels',
  'video',
  'post',
  'repost',
  'link',
  'url',
  'website',
  'social',
  'socialmedia',
  'fyp',
  'foryou',
  'foryoupage',
  'viral',
  'trending',
  'trend',
  'explore',
  'explorepage',
  'follow',
  'followers',
  'like',
  'likes',
  'share',
  'comment',
  'subscribe',
  'giveaway',
  'ad',
  'ads',
  'sponsored',
  'promo',
  'promotion',
  'packingorders',
  'packing',
  'content',
  'info',
  'information',
  'article',
  'misc',
  'general',
  'stuff',
  'random',
  'update',
  // Frame-description words. The thumbnail vision description reaches
  // classify, and its "Setting: / People: / Objects: / Activity:" headings
  // (DESCRIBE_THUMB_PROMPT names exactly those) were copied into tags
  // verbatim: in a 1,885-note library "setting" sat on 206 notes, "man" on
  // 200, "white" on 193, "wooden" on 152. None says what a save is about.
  'setting',
  'activity',
  'object',
  'person',
  'text',
  'background',
  'man',
  'woman',
  'white',
  'black',
  'wooden',
  // Filler for a link with nothing behind it yet: Instagram and TikTok saves
  // classified from the bare URL, before any caption, got "platform" (50
  // notes), "user" (14), "unknown" and "comments" — describing the link, not
  // the save.
  'platform',
  'user',
  'unknown',
  'comments',
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
export function stripThinking(text: string | null | undefined): string {
  const s = (text || '').replace(/<think>[\s\S]*?<\/think>/gi, '')
  // An unterminated block means the whole remainder is thinking; there is no
  // answer in it to keep.
  const open = s.search(/<think>/i)
  return (open === -1 ? s : s.slice(0, open)).trim()
}

export function isJunkTag(t: string): boolean {
  return JUNK_TAGS.has(t) || JUNK_TAGS.has(t.replace(/-/g, ''))
}

// Exported for tests — classify() itself does real model I/O, so this pure
// post-processing (type fallback, length caps, junk filtering) is the
// testable surface for what the model's raw JSON gets turned into.
export function normaliseClassification(p: RawClassification, text: string) {
  // Anything but a type Kothai stores — "text" or "image" despite the schema's
  // enum, a number, nothing at all — falls back to the URL heuristic.
  const type: NoteType = p.type === 'link' || p.type === 'video' ? p.type : heuristicType(text)
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
    tags: normalizeTags(p.tags, { max: 15 })
      .filter(t => !isJunkTag(t))
      .slice(0, 10),
  }
}

// ---- helpers / fallbacks ----------------------------------------------
export function heuristicType(text: string): NoteType {
  return /youtube\.com|youtu\.be|vimeo\.com|tiktok\.com|\.mp4(\?|$)/i.test(text) ? 'video' : 'link'
}

export function deriveTitle(text: string | null | undefined): string {
  const t = (text || '').trim().replace(/\s+/g, ' ')
  return t.slice(0, 60)
}

export function isLikelyUrl(text: string | null | undefined): boolean {
  return /^https?:\/\/\S+$/i.test((text || '').trim())
}
