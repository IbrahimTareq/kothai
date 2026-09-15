// Contrast guard for colour pairings written in the stylesheets.
//
// design-tokens.test.ts proves each token is usable. It cannot prove the
// stylesheets pair them correctly: a rule that sets `color` and `background`
// to two tokens which happen to resolve to the same colour passes the linter
// (both values are tokens) and passes the token test (both are individually
// fine), and still renders an invisible control.
//
// That is how .conn-btn.primary shipped filling with --accent and inking with
// --accent-ink, a legacy alias that resolved to the accent itself — white on white
// in dark, near-black on near-black in light. This file reads every rule that
// declares both properties as plain var() references and pins the pair.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadThemes, pairContrast } from '../../scripts/token-colors.mjs'

const STYLES = fileURLToPath(new URL('../../client/styles/', import.meta.url))
const TOKENS = new URL('../../client/styles/foundation/tokens.css', import.meta.url)
const { dark, light } = loadThemes(TOKENS)
const THEMES: [string, Record<string, string>][] = [['dark', dark], ['light', light]]

// Two tiers, because the system has two kinds of pairing.
//
// A control that is meant to be read clears WCAG's 3:1 floor for UI components
// and large text. These pairings are buttons, chips and badges, not body copy.
const AA_LARGE = 3
// Deliberately recessive pairings — a disabled button, a placeholder glyph —
// sit below that on purpose. They still have to be *perceptible*: the floor
// here only asserts the two tokens are not the same colour wearing two names,
// which is the bug this file exists to catch.
const PERCEPTIBLE = 2

// --ink-faint is the system's decorative ink: micro-labels, dividers, idle and
// disabled glyphs. design-tokens.test.ts already pins its own floor against the
// page. Anything inked with it is recessive by construction.
const RECESSIVE_INK = new Set(['--ink-faint'])
// --overlay is a scrim over user media, so compositing it over --bg (which is
// what pairContrast does) models a backdrop that is not really there. The
// design system lists content overlays as a standing exception.
const MEDIA_BACKDROP = new Set(['--overlay'])

// tweaks.css only overrides a third-party panel that ships its own language,
// the same exclusion the token linter makes.
const SKIP = new Set(['tweaks.css'])

const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? walk(join(dir, e.name))
    : e.name.endsWith('.css') && !SKIP.has(e.name) ? [join(dir, e.name)] : [])

type Pairing = { file: string, selector: string, fg: string, bg: string }

/** Every rule declaring both colour and background as a single var() token. */
function pairings (): Pairing[] {
  const found: Pairing[] = []
  for (const path of walk(STYLES)) {
    const src = readFileSync(path, 'utf8')
    for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const [, selector, body] = m
      const fg = body.match(/(?:^|[;\s])color\s*:\s*var\((--[a-z0-9-]+)\)/)
      const bg = body.match(/(?:^|[;\s])background(?:-color)?\s*:\s*var\((--[a-z0-9-]+)\)/)
      if (!fg || !bg) continue
      found.push({
        file: relative(STYLES, path),
        selector: selector.trim().replace(/\s+/g, ' '),
        fg: fg[1],
        bg: bg[1],
      })
    }
  }
  return found
}

const RULES = pairings()

test('the scan finds rules to check', () => {
  // A regex that silently matches nothing would make every assertion below
  // vacuously true.
  assert.ok(RULES.length >= 10, `only ${RULES.length} colour pairings found — the scan is broken`)
})

for (const [themeName, theme] of THEMES) {
  test(`${themeName}: every stylesheet colour pairing stays visible`, () => {
    const failures: string[] = []
    for (const { file, selector, fg, bg } of RULES) {
      const r = pairContrast(fg, bg, theme)
      if (r === null) continue   // one side is not a colour token; not our bug class
      const floor = RECESSIVE_INK.has(fg) || MEDIA_BACKDROP.has(bg) ? PERCEPTIBLE : AA_LARGE
      if (r < floor) {
        failures.push(`${file}  ${selector}\n    ${fg} on ${bg} = ${r.toFixed(2)}:1, floor ${floor}:1`)
      }
    }
    assert.equal(failures.length, 0,
      `${failures.length} unreadable pairing(s) in ${themeName}:\n  ${failures.join('\n  ')}`)
  })
}
