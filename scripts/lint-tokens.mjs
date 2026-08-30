#!/usr/bin/env node
/* lint-tokens — guards the design system.
 *
 * The stylesheets are the design system's only enforcement point, so this
 * check exists to keep them deterministic: every size, colour, radius, spacing
 * step, duration and stacking level must come from a token in tokens.css.
 *
 * Run: npm run lint:tokens   (also runs as part of `npm test`)
 *
 * Escape hatch: append `/* token-lint-ignore: <reason> *​/` on the same line.
 * Use it for values that genuinely cannot be tokens — media overlays sitting on
 * imagery, brand colours, letterbox backgrounds — and always say why.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), '..', 'client')
const STYLES = join(CLIENT, 'styles')
// tweaks.css only overrides a third-party panel that ships its own language.
const SKIP = new Set(['tokens.css', 'tweaks.css'])

// Stylesheets are grouped into foundation/, components/ and views/, so walk
// the tree rather than reading one flat directory. Paths stay relative to
// STYLES, which keeps report lines readable as e.g. views/gallery.css:12.
const walkStyles = (rel = '') => readdirSync(join(STYLES, rel), { withFileTypes: true })
  .flatMap(e => (e.isDirectory() ? walkStyles(join(rel, e.name)) : [join(rel, e.name)]))

const files = walkStyles().filter(f => f.endsWith('.css') && !SKIP.has(basename(f)))
const tokensSrc = readFileSync(join(STYLES, 'foundation', 'tokens.css'), 'utf8')
const defined = new Set([...tokensSrc.matchAll(/(--[a-z0-9-]+)\s*:/g)].map(m => m[1]))

const RULES = [
  { id: 'font-size',
    re: /font-size:\s*[0-9.]+(px|rem)/g,
    msg: 'raw font-size — use a --text-* token' },
  { id: 'colour',
    re: /(?:color|background|background-color|border-color|fill|stroke)\s*:\s*(?:#[0-9a-fA-F]{3,8}|rgba?\([0-9])/g,
    msg: 'raw colour — use an --ink-*/--panel-*/--line-*/--accent-* token' },
  { id: 'radius',
    re: /border(?:-[a-z]+)?-radius:\s*[^;}]*(?<![\w.#-])[0-9]+(px|%)/g,
    msg: 'raw border-radius — use a --radius-* token' },
  { id: 'spacing',
    // only the rhythm range; >48px is layout and stays literal by design
    re: /(?:padding|margin|gap)(?:-(?:top|right|bottom|left))?:\s*[^;}]*(?<![\w.#-])(?:[0-9]|[1-4][0-9])px/g,
    msg: 'raw spacing <=48px — use a --space-* token' },
  { id: 'z-index',
    re: /z-index:\s*[0-9]/g,
    msg: 'raw z-index — use a --z-* token' },
  { id: 'duration',
    // durations under .5s are interaction feedback and must be on the scale
    re: /(?:transition|animation):[^;}]*(?<![\w.])0?\.[0-4][0-9]?s/g,
    msg: 'raw duration <.5s — use a --dur-* token' },
]

let failures = 0
const report = []

for (const file of files) {
  const lines = readFileSync(join(STYLES, file), 'utf8').split('\n')
  lines.forEach((line, i) => {
    if (line.includes('token-lint-ignore')) return
    const code = line.replace(/\/\*.*?\*\//g, '')
    for (const rule of RULES) {
      rule.re.lastIndex = 0
      const hit = rule.re.exec(code)
      if (hit) {
        report.push(`  ${file}:${i + 1}  [${rule.id}] ${rule.msg}\n      ${hit[0].trim()}`)
        failures++
      }
    }
    // a var() with no definition and no fallback silently drops the property
    for (const m of code.matchAll(/var\((--[a-z0-9-]+)\s*(,)?/g)) {
      if (!defined.has(m[1]) && !m[2]) {
        report.push(`  ${file}:${i + 1}  [undefined-token] ${m[1]} is not defined in tokens.css`)
        failures++
      }
    }
  })
}

/* ── inline styles in components ──────────────────────────────────────────
 * The stylesheets are only half the surface: a component can hardcode the same
 * values in a style={{...}} object and bypass the system entirely. Genuinely
 * dynamic values (computed positions, gradients, progress widths) are the
 * legitimate use of inline style and must not be flagged, so interpolations
 * are stripped before the literals are examined.
 *
 * Tweaks.tsx is skipped: it injects a third-party panel's own stylesheet.
 */
const SKIP_TSX = new Set(['Tweaks.tsx'])
const LAYOUT_PROP = /^(padding|margin|gap|inset|top|right|bottom|left|width|height|minWidth|minHeight|maxWidth|maxHeight|fontSize|borderRadius|zIndex|letterSpacing|lineHeight)/

function walk (dir) {
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return walk(full)
    return name.endsWith('.tsx') && !SKIP_TSX.has(name) ? [full] : []
  })
}

for (const full of walk(CLIENT)) {
  const src = readFileSync(full, 'utf8')
  const rel = full.slice(CLIENT.length + 1)
  const marker = /style=\{\{/g
  let m
  while ((m = marker.exec(src))) {
    // balance braces from the opening of the object literal
    let i = m.index + 'style={'.length, depth = 0, end = -1
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break } }
    }
    if (end < 0) continue
    const raw = src.slice(m.index, end + 1)
    const line = src.slice(0, m.index).split('\n').length
    if (src.split('\n')[line - 1].includes('token-lint-ignore')) continue

    // ${...} contents are computed at runtime — not literals
    const body = raw.replace(/\$\{[^}]*\}/g, '@')

    const say = msg => {
      report.push(`  ${rel}:${line}  [inline-style] ${msg}\n      ${raw.split('\n')[0].trim().slice(0, 72)}`)
      failures++
    }
    if (/#[0-9a-fA-F]{3,8}\b/.test(body) || /\brgba?\(\s*[0-9]/.test(body)) {
      say('literal colour in an inline style — use a token via CSS, or a var(--x) string')
    } else if (/['"`][^'"`]*?(?<![\w@])[0-9.]+px/.test(body)) {
      say('literal px in an inline style — move it to CSS and use a token')
    } else {
      for (const d of body.matchAll(/([a-zA-Z]+)\s*:\s*(-?[0-9.]+)\s*[,}]/g)) {
        if (LAYOUT_PROP.test(d[1])) { say(`literal ${d[1]}: ${d[2]} — move it to CSS and use a token`); break }
      }
    }
  }
}

if (failures) {
  console.error(`\ndesign token check FAILED — ${failures} violation(s):\n`)
  console.error(report.join('\n'))
  console.error('\nAdd the value to tokens.css, or annotate the line with')
  console.error('/* token-lint-ignore: why this cannot be a token */\n')
  process.exit(1)
}
console.log(`design token check passed — ${files.length} stylesheets and all component inline styles clean`)
