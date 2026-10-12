// The canvas is where arranging effort builds up, and it was the one place a
// single press destroyed work with no way back: Tidy rewrote every position,
// and Backspace deleted notes, frames and lines for good and took selected
// cards out of the space — while deleting one link got a six-second Undo
// (design critique, 2026-10-12). Both now offer Undo through the same bar.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = (path: string) => readFileSync(new URL(`../../client/${path}`, import.meta.url), 'utf8')
const canvas = src('components/Canvas.tsx')

test('Tidy offers Undo that puts the previous layout back', () => {
  const tidy = canvas.slice(canvas.indexOf('onTidy='), canvas.indexOf('/>', canvas.indexOf('onTidy=')))
  assert.match(tidy, /onOffer\(/)
  assert.match(tidy, /applyDoc\(\(\) => before\)/)
})

test('Backspace offers Undo that restores the layout and the cards it took out of the space', () => {
  const del = canvas.slice(
    canvas.indexOf('const onBeforeDelete'),
    canvas.indexOf('\n  )\n', canvas.indexOf('const onBeforeDelete')),
  )
  assert.match(del, /onOffer\(/)
  assert.match(del, /onAddItem/)
  assert.match(del, /applyDoc\(\(\) => before\)/)
})

test('the space hands the canvas the app-wide undo bar and a way to re-add a card', () => {
  const lazy = src('views/Space.tsx').match(/<LazyCanvas[\s\S]*?\/>/)?.[0] ?? ''
  assert.match(lazy, /onOffer=/)
  assert.match(lazy, /onAddItem=/)
  assert.match(src('app/App.tsx'), /offer: writes\.offer/)
})
