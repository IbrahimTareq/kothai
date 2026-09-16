/* button-chrome — find buttons built from scratch.
 *
 * .btn in components/primitives.css is the app's button. This finds rules that
 * rebuild one instead: a block declaring a pointer cursor AND padding AND a
 * border radius AND a font size is a button box, whatever it is called.
 *
 * Kept separate from lint-tokens.mjs, and pure, so it can be unit-tested —
 * lint-tokens.mjs runs its checks at import time and cannot be imported.
 *
 * Escape hatch: put `token-lint-ignore: <reason>` anywhere inside the rule.
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
