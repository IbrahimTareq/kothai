// Reddit's orange is a third-party brand colour, allowed as a literal
// (token-lint-ignore). As 16px text on the light theme's white it is 3.44:1,
// under AA for text that size (technical audit, 2026-10-11). The orange header
// stays; on light the word takes the page's ink.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { contrast } from '../../scripts/token-colors.ts'

const css = readFileSync(new URL('../../client/styles/views/expanded.css', import.meta.url), 'utf8')

test('Reddit orange as text fails AA on white, so light theme does not use it', () => {
  assert.ok(contrast([255, 69, 0], [255, 255, 255]) < 4.5)
  assert.match(css, /:root\[data-theme="light"\] \.exp-reddit-tag\{color:var\(--ink\)\}/)
})
