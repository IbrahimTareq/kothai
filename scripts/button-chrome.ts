/* button-chrome — find buttons built from scratch.
 *
 * .btn in components/primitives.css is the app's button. This finds rules that
 * rebuild one instead: a block declaring a pointer cursor AND padding AND a
 * border radius AND a font size is a button box, whatever it is called.
 *
 * Kept separate from lint-tokens.ts, and pure, so it can be unit-tested —
 * lint-tokens.ts runs its checks at import time and cannot be imported.
 *
 * Escape hatch: put `token-lint-ignore: <reason>` anywhere inside the rule.
 *
 * findBtnClass is the same guard one layer up, in markup: <Button> in
 * client/ui/ is the only thing that may write the .btn class list.
 */

const COMMENT = /\/\*[\s\S]*?\*\//g

/** Rules that declare a complete button box. [{ selector, line }] */
export function findButtonChrome(css: string) {
  const found: { selector: string; line: number }[] = []
  for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    // The annotation may sit on the selector, inside the block, or trail the
    // closing brace, so test the whole rule plus the rest of its last line.
    const tail = css.slice(m.index + m[0].length).split('\n')[0]
    if ((m[0] + tail).includes('token-lint-ignore')) continue

    const body = m[2].replace(COMMENT, '')
    if (!/cursor\s*:\s*pointer/.test(body)) continue
    if (!/(?:^|[;\n])\s*padding(?:-[a-z]+)?\s*:/.test(body)) continue
    if (!/(?:^|[;\n])\s*border-radius\s*:/.test(body)) continue
    if (!/(?:^|[;\n])\s*font-size\s*:/.test(body)) continue

    const selector = m[1].replace(COMMENT, '').trim().replace(/\s+/g, ' ')
    if (!selector || selector.startsWith('@')) continue

    found.push({
      selector,
      line: css.slice(0, m.index + m[1].length - m[1].trimStart().length).split('\n').length,
    })
  }
  return found
}

// `btn` or `btn--x` as a whole class. The lookbehind is what lets `rail-btn`
// and `seg-btn${...}` through: they are their own components, not .btn.
const BTN_CLASS = /(?<![\w-])btn(?:--[a-z]+)?(?![\w-])/

/** Lines where a className attribute applies .btn by hand. */
export function findBtnClass(tsx: string) {
  const lines: number[] = []
  for (const m of tsx.matchAll(/className=(["'{])/g)) {
    const start = m.index + 'className='.length
    let end = start + 1
    if (m[1] === '{') {
      // balance braces: the value may hold a template literal with ${}
      for (let depth = 0; end <= tsx.length; end++) {
        if (tsx[end - 1] === '{') depth++
        else if (tsx[end - 1] === '}' && --depth === 0) break
      }
    } else {
      end = tsx.indexOf(m[1], start + 1) + 1
    }
    if (BTN_CLASS.test(tsx.slice(start, end))) lines.push(tsx.slice(0, m.index).split('\n').length)
  }
  return lines
}

// Comments are stripped first: prose explaining why something is not a
// <button> is not one. A comment must open after whitespace or `{`, so the
// `/*` in accept="image/*" and the `//` in a URL are left alone — the former
// once swallowed Core.tsx's attach button up to the next `*/`.
const COMMENTS = /(?<=^|[\s{])(?:\/\*[\s\S]*?\*\/|\/\/.*$)/gm

/** Raw <button> tags in a component — each one a box <Button> did not draw. */
export const countRawButtons = (tsx: string) => (tsx.replace(COMMENTS, '').match(/<button(?=[\s>/])/g) || []).length

/** Raw <input>, <textarea> and <select> tags — fields <Input> did not draw. */
export const countRawFields = (tsx: string) =>
  (tsx.replace(COMMENTS, '').match(/<(?:input|textarea|select)(?=[\s>/])/g) || []).length

/** Compare per-file raw counts of one control against the ratchet's baseline.
 *  It must match exactly: a count above it is new debt, and one below it is
 *  paid-down debt the baseline has to record, or the room would be spent again
 *  later. `what` names the control in the report. */
export function checkRaw(counts: Record<string, number>, baseline: Record<string, number>, what: string) {
  const failures: string[] = []
  for (const [file, n] of Object.entries(counts)) {
    const base = baseline[file] ?? 0
    if (n > base) failures.push(`${file}: ${n} raw ${what}, baseline is ${base}`)
    else if (n < base) failures.push(`${file}: down to ${n} — lower ${file} to ${n} in the baseline`)
  }
  for (const [file, base] of Object.entries(baseline))
    if (!(file in counts) && base > 0) failures.push(`${file}: no longer counted — remove ${file} from the baseline`)
  return failures
}
