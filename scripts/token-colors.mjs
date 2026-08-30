/* token-colors — resolve tokens.css to real colours, per theme.
 *
 * Shared by test/design-tokens.test.ts. Deliberately dependency-free and
 * deterministic: it reads the stylesheet rather than a browser, so it gives the
 * same answer on a laptop and in CI, which pixel screenshots do not.
 */
import { readFileSync } from 'node:fs'

const DECL = /(--[a-z0-9-]+)\s*:\s*([^;]+);/g

export function loadThemes (cssPath) {
  const src = readFileSync(cssPath, 'utf8')
  const block = re => Object.fromEntries(
    [...(src.match(re)?.[1] ?? '').matchAll(DECL)].map(m => [m[1], m[2].trim()]))
  const dark = block(/:root\{([\s\S]*?)\n\}/)
  // light only overrides; anything it does not restate is inherited from :root
  return { dark, light: { ...dark, ...block(/:root\[data-theme="light"\]\{([\s\S]*?)\n\}/) } }
}

/** [r, g, b, a] or null if the value is not a literal colour. */
export function parseColor (value) {
  const v = value.trim()
  const hex = v.match(/^#([0-9a-f]{3,8})$/i)
  if (hex) {
    let h = hex[1]
    if (h.length === 3) h = [...h].map(c => c + c).join('')
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16),
      h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1]
  }
  const fn = v.match(/^rgba?\(([^)]+)\)$/i)
  if (fn) {
    const p = fn[1].split(',').map(Number)
    return [p[0], p[1], p[2], p[3] ?? 1]
  }
  return null
}

/** Follow var() chains and color-mix() to a literal colour. */
export function resolve (name, theme, depth = 0) {
  if (depth > 8) return null
  const v = theme[name]
  if (!v) return null
  const mix = v.match(/^color-mix\(in srgb,\s*var\((--[a-z0-9-]+)\)\s*([0-9.]+)%,\s*var\((--[a-z0-9-]+)\)\)$/)
  if (mix) {
    const a = resolve(mix[1], theme, depth + 1)
    const b = resolve(mix[3], theme, depth + 1)
    if (!a || !b) return null
    const w = parseFloat(mix[2]) / 100
    return [0, 1, 2].map(i => a[i] * w + b[i] * (1 - w)).concat(1)
  }
  const ref = v.match(/^var\((--[a-z0-9-]+)\)$/)
  if (ref) return resolve(ref[1], theme, depth + 1)
  return parseColor(v)
}

/** Composite a possibly-translucent colour over an opaque one. */
export const flatten = (fg, bg) => fg.slice(0, 3).map((c, i) => c * fg[3] + bg[i] * (1 - fg[3]))

const luminance = rgb => {
  const [r, g, b] = rgb.map(c => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 2.1 contrast ratio. Both arguments must already be opaque. */
export function contrast (a, b) {
  const l1 = luminance(a); const l2 = luminance(b)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

/** Contrast of token `fg` over token `bg`, itself composited over --bg. */
export function pairContrast (fg, bg, theme) {
  const base = resolve('--bg', theme)
  const surface = resolve(bg, theme)
  const ink = resolve(fg, theme)
  if (!base || !surface || !ink) return null
  const opaqueSurface = flatten(surface, base)
  return contrast(flatten(ink, opaqueSurface), opaqueSurface)
}
