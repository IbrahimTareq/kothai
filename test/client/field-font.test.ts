// Fields take the page's type. A browser gives <input> and <select> Arial and
// <textarea> monospace unless told otherwise, and base.css told only <button>:
// renaming a space swapped its Geist 600 title for an Arial 400 field.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const css = (path: string) => readFileSync(new URL(`../../client/styles/${path}`, import.meta.url), 'utf8')

/** The declarations of every rule whose selector list names `selector` exactly. */
function declarationsFor(src: string, selector: string): string[] {
  return [...src.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, sel]) =>
      sel
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split(',')
        .some(s => s.trim() === selector),
    )
    .map(([, , body]) => body)
}

test('input, textarea and select inherit the page font family from base.css', () => {
  const base = css('foundation/base.css')
  for (const el of ['input', 'textarea', 'select']) {
    assert.ok(
      declarationsFor(base, el).some(d => /font-family\s*:\s*inherit/.test(d)),
      `${el} falls back to the browser's font`,
    )
  }
})

test("a space's rename field inherits the title's weight and tracking", () => {
  const body = declarationsFor(css('views/spaces.css'), '.coll-name-input').join(';')
  assert.match(body, /(^|;)\s*font\s*:\s*inherit/)
  assert.match(body, /letter-spacing\s*:\s*inherit/)
})

// Settings wrote file names and commands in <code>, and nothing gave <code> a
// face: it rendered in the browser's own monospace, Menlo on a Mac — a third
// typeface on a page that loads two.
test('code, kbd, pre and samp take the mono face from base.css', () => {
  const base = css('foundation/base.css')
  for (const el of ['code', 'kbd', 'pre', 'samp']) {
    assert.ok(
      declarationsFor(base, el).some(d => /font-family\s*:\s*var\(--font-mono\)/.test(d)),
      `${el} falls back to the browser's monospace`,
    )
  }
})

// Type is never bold (docs/design-system.md), but a bare <b> is 700 by browser
// default: Settings' "Idle ≈ 4.8 GB" rendered its numbers at 700 because only
// .settings-row-desc b had been turned down.
test('b and strong are medium, not the browser bold', () => {
  const base = css('foundation/base.css')
  for (const el of ['b', 'strong']) {
    assert.ok(
      declarationsFor(base, el).some(d => /font-weight\s*:\s*var\(--fw-medium\)/.test(d)),
      `${el} renders at the browser's 700`,
    )
  }
})
