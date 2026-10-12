// A delete is held for six seconds behind an Undo, but the button that asked
// went with its card: focus fell to <body>, and the Undo sat after the whole
// board in tab order, so a keyboard user could not reach it in time
// (technical audit, 2026-10-12). The bar now takes focus when it appears, and
// its window waits while the pointer or focus is on it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../../client/app/useItemWrites.tsx', import.meta.url), 'utf8')

test('the Undo button takes focus when the bar appears', () => {
  assert.match(src, /ref=\{undoRef\}/)
  assert.match(src, /undoRef\.current\?\.focus\(\)/)
})

test('the undo window waits while the bar has the pointer or focus', () => {
  const bar = src.slice(src.indexOf('className="undo-bar"'))
  for (const ev of ['onMouseEnter', 'onMouseLeave', 'onFocus', 'onBlur']) assert.match(bar, new RegExp(`${ev}=`))
})
