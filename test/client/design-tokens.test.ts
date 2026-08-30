// Contrast and theme-parity guard for the design tokens.
//
// The four bugs the design-system sweep uncovered all shared one shape: a value
// that was fine in the theme it was authored against and broken in the other,
// in a state nobody happened to be looking at.
//
//   - .send-btn:hover hardcoded near-white, so it vanished on a white page
//   - three Spaces popovers used --panel (~3% alpha) and were see-through
//   - --danger was a hover-tuned red that failed AA as body text on light
//   - --ok drove the "copied" confirmation as mint-on-white at 1.5:1
//
// None of those are caught by the token linter (the values were tokens, or were
// hardcoded in ways the linter now catches) and none would be caught by a unit
// test of behaviour. They are contrast and opacity facts about resolved colour,
// which is exactly what this file pins — in both themes, without a browser, so
// the answer is identical on a laptop and in CI.
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadThemes, resolve, pairContrast, contrast } from '../../scripts/token-colors.mjs'

const TOKENS = new URL('../../client/styles/foundation/tokens.css', import.meta.url)
const { dark, light } = loadThemes(TOKENS)
const THEMES: [string, Record<string, string>][] = [['dark', dark], ['light', light]]

// WCAG 2.1: 4.5:1 for body text, 3:1 for large text and UI components.
const AA_TEXT = 4.5
const AA_LARGE = 3

// Anything that can carry a sentence must clear AA as body text in both themes.
const BODY_TEXT: [string, string][] = [
  ['--ink', '--bg'], ['--ink', '--panel'],
  ['--ink-dim', '--bg'], ['--ink-dim', '--panel'],
  ['--danger', '--bg'], ['--danger', '--panel'],
  ['--warn', '--bg'], ['--ok', '--bg'],
  ['--on-accent', '--accent'],
]

for (const [themeName, theme] of THEMES) {
  test(`${themeName}: body-text tokens clear WCAG AA`, () => {
    for (const [fg, bg] of BODY_TEXT) {
      const r = pairContrast(fg, bg, theme)
      assert.ok(r !== null, `${fg} on ${bg} did not resolve in ${themeName}`)
      assert.ok(r >= AA_TEXT,
        `${fg} on ${bg} is ${r!.toFixed(2)}:1 in ${themeName}, below AA ${AA_TEXT}:1`)
    }
  })

  // --ink-mute is secondary copy, --ink-faint is decorative (micro-labels,
  // dividers, idle glyphs). Neither is for sentences. These floors stop them
  // drifting further down rather than claiming they pass AA for body text.
  test(`${themeName}: de-emphasised ink stays above its floor`, () => {
    const mute = pairContrast('--ink-mute', '--bg', theme)!
    assert.ok(mute >= AA_LARGE,
      `--ink-mute is ${mute.toFixed(2)}:1 in ${themeName}, below ${AA_LARGE}:1 for large text/UI`)
    const faint = pairContrast('--ink-faint', '--bg', theme)!
    assert.ok(faint >= 2.5,
      `--ink-faint is ${faint.toFixed(2)}:1 in ${themeName} — decorative only, but this is too low`)
  })

  test(`${themeName}: popover surfaces are opaque`, () => {
    // Three popovers once used --panel and rendered see-through over content.
    const surface = resolve('--surface-popover', theme)
    assert.ok(surface, `--surface-popover did not resolve in ${themeName}`)
    assert.ok(surface![3] >= 0.95,
      `--surface-popover has alpha ${surface![3]} in ${themeName} — content will show through`)
  })

  test(`${themeName}: accent hover stays visible against the page`, () => {
    // The send button's hover was hardcoded near-white with no light override,
    // so it disappeared against a white background.
    const hover = resolve('--accent-hover', theme)
    const bg = resolve('--bg', theme)
    assert.ok(hover && bg, `--accent-hover did not resolve in ${themeName}`)
    const r = contrast(hover!.slice(0, 3), bg!.slice(0, 3))
    assert.ok(r >= AA_LARGE,
      `--accent-hover is ${r.toFixed(2)}:1 against --bg in ${themeName} — the filled control vanishes`)
  })
}

test('every colour token resolves in both themes', () => {
  // A token defined only in :root silently keeps its dark value on light. That
  // is right for structural values and wrong for colour — this catches the next
  // --warn/--ok, which were invisible on white for exactly this reason.
  for (const name of Object.keys(dark)) {
    if (!resolve(name, dark)) continue          // not a colour token
    assert.ok(resolve(name, light),
      `${name} is a colour in :root but does not resolve under [data-theme="light"]`)
  }
})

