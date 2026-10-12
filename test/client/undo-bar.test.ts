// A delete is held for six seconds behind an Undo, but the button that asked
// went with its card: focus fell to <body>, and the Undo sat after the whole
// board in tab order, so a keyboard user could not reach it in time
// (technical audit, 2026-10-12). The bar now takes focus when it appears, and
// its window waits while the pointer or focus is on it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../../client/app/useItemWrites.tsx', import.meta.url), 'utf8')

test('the Undo button takes focus when the bar appears and focus had nowhere to be', () => {
  assert.match(src, /ref=\{undoRef\}/)
  assert.match(src, /undoRef\.current\?\.focus\(\)/)
  // Only then: on the canvas, Backspace leaves focus where it was, and taking
  // it to Undo made every next delete start with a click back on the canvas.
  const effect = src.slice(src.indexOf('useEffect(() => {\n    const lost'), src.indexOf('}, [shown])'))
  assert.match(effect, /document\.activeElement/)
})

test('the undo window waits while the bar has the pointer or focus', () => {
  const bar = src.slice(src.indexOf('className="undo-bar"'))
  for (const ev of ['onMouseEnter', 'onMouseLeave', 'onFocus', 'onBlur']) assert.match(bar, new RegExp(`${ev}=`))
})

// Removing a tag took effect at once with no way back, one stray tap from a
// lost label (design critique, 2026-10-12). It offers Undo — and since tags are
// edited in the item view, a modal that hides and blocks everything outside
// it, the bar moves into the open dialog rather than sitting behind it.
test('removing a tag offers Undo, in the open dialog', () => {
  const update = src.slice(src.indexOf('const update ='), src.indexOf('\n  }\n', src.indexOf('const update =')))
  assert.match(update, /offer\(/)
  assert.match(src, /createPortal\(/)
  assert.match(src, /querySelector[^)]*role="dialog"/)
  // Looked for until it is there: one look a frame after opening came too
  // early, and the bar stayed behind the modal (seen in the browser, 2026-10-12);
  // and on a timer, since a hidden tab runs no animation frames.
  assert.match(src, /setTimeout\(look,/)
})
