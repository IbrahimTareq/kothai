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
