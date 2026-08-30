// Source/brand detection for saved items — shared by the gallery tile badge
// and the expanded view. Matched against host (falls back to url).
import type { UIItem } from '../types'

export type Brand = 'github' | 'x' | 'youtube' | 'reddit' | 'instagram' | 'tiktok'

const MATCHERS: [Brand, RegExp][] = [
  ['github', /(^|\.|\/)github\.com/],
  ['x', /(^|\.|\/)(twitter\.com|x\.com)/],
  ['youtube', /(^|\.|\/)(youtube\.com|youtu\.be)/],
  ['reddit', /(^|\.|\/)reddit\.com/],
  ['instagram', /(^|\.|\/)instagram\.com/],
  ['tiktok', /(^|\.|\/)tiktok\.com/],
]

// The brand glyph name (also the icon name) for an item, or null if unbranded.
export function sourceGlyph(item: UIItem): Brand | null {
  const h = (item.host || item.url || '').toLowerCase()
  for (const [brand, re] of MATCHERS) if (re.test(h)) return brand
  return null
}

// Platforms whose saves are the media, not a headline: a reel or a short is
// watched, and its "title" is a caption. Those keep the media-first card and
// the media stage; everything else linked (article, Reddit post, repo) leads
// with its headline. The one routing rule, shared by the gallery tile
// (Cards.tsx) and the expanded stage (Expanded.tsx) so they cannot drift.
const MEDIA_BRANDS: Brand[] = ['instagram', 'tiktok', 'youtube']

export function isMediaFirst(item: UIItem): boolean {
  const brand = sourceGlyph(item)
  return item.type === 'video' || (!!brand && MEDIA_BRANDS.includes(brand))
}

const LABELS: Record<Brand, string> = {
  github: 'GitHub', x: 'X', youtube: 'YouTube', reddit: 'Reddit', instagram: 'Instagram', tiktok: 'TikTok',
}

// Human label for the item's source (brand name, else the bare host, else 'Web').
export function sourceLabel(item: UIItem): string {
  const brand = sourceGlyph(item)
  if (brand) return LABELS[brand]
  return item.host || 'Web'
}

// Parse "owner" / "repo" from a github URL (best-effort; either may be empty).
export function githubParts(url?: string | null): { owner: string; repo: string } {
  try {
    const seg = new URL(url || '').pathname.split('/').filter(Boolean)
    return { owner: seg[0] || '', repo: seg[1] || '' }
  } catch {
    return { owner: '', repo: '' }
  }
}

// Monochrome-first per the design system; the rest stay as optional tints.
export const ACCENTS = [
  '#ffffff', // mono (default)
  '#cdd6e4', // ash
  '#38e0d4', // plasma
  '#ff9d4d', // sodium
  '#9d7dff', // ion violet
]


// Popular saved sources for the Everything-page filter pills. Each is a host/url
// predicate over a saved item — sources are just types narrowed by platform.
export interface SourceDef { key: string; label: string; dot: string; glyph?: string; test: (i: UIItem) => boolean }
export const PLATFORMS: SourceDef[] = [
  { key: 'github', label: 'GitHub', dot: '#a371f7', glyph: 'github', test: (i) => /(^|\.)github\.com$/.test(i.host || '') },
  { key: 'reels', label: 'Instagram Reels', dot: '#e1306c', glyph: 'instagram', test: (i) => /instagram\.com\/reel/i.test(i.url || '') },
  { key: 'igposts', label: 'Instagram Posts', dot: '#c13584', glyph: 'instagram', test: (i) => /instagram\.com\/p\//i.test(i.url || '') },
  { key: 'x', label: 'X', dot: '#5aa9e6', glyph: 'x', test: (i) => /(^|\.)(twitter\.com|x\.com)$/.test(i.host || '') },
  { key: 'tiktok', label: 'TikTok', dot: '#26c9c3', glyph: 'tiktok', test: (i) => /(^|\.)tiktok\.com$/.test(i.host || '') },
  { key: 'reddit', label: 'Reddit', dot: '#ff4500', glyph: 'reddit', test: (i) => /(^|\.)reddit\.com$/.test(i.host || '') },
]
export const SOURCES: SourceDef[] = [
  ...PLATFORMS,
  { key: 'web', label: 'Web', dot: '#8a94a6', glyph: 'web', test: (i) => (i.type === 'link' || i.type === 'video') && !!i.host && !PLATFORMS.some((s) => s.test(i)) },
]
export const SOURCE_BY_KEY: Record<string, SourceDef> = Object.fromEntries(SOURCES.map((s) => [s.key, s]))

// Maps an item to its platform/source bucket for the mindmap. Reuses the SOURCES
// predicate table (PLATFORMS + Web); items matching none fall under "Other".
export function platformBucket(item: UIItem): { key: string; label: string } {
  const found = SOURCES.find((s) => s.test(item))
  return found ? { key: found.key, label: found.label } : { key: 'other', label: 'Other' }
}
