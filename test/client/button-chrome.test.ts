// The design system's button primitive is only the default if hand-rolling one
// is harder than reaching for it. This detector is the "harder" half: it finds
// rules that build a button box from scratch, wherever they are written.
//
// It keys on the chrome, not the class name. A rule matching `.foo-btn` outside
// primitives.css would be satisfied by naming the next one `.wizard-test` —
// which is exactly how .conn-btn and .wizard-test came to exist.
import test from 'node:test'
import assert from 'node:assert/strict'
import { findBtnClass, findButtonChrome } from '../../scripts/button-chrome.ts'

test('flags a rule that builds a whole button box', () => {
  const css = `.my-btn{padding:var(--space-8) var(--space-14);border-radius:var(--radius-md);
  font-size:var(--text-sm);cursor:pointer}`
  const hits = findButtonChrome(css)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].selector, '.my-btn')
})

test('ignores a rule that is merely clickable', () => {
  // A row, a card, a tile: clickable, but not a button box.
  const css = `.chat-row{padding:var(--space-8);border-radius:var(--radius-md);cursor:pointer}`
  assert.deepEqual(findButtonChrome(css), [])
})

test('ignores a rule with no pointer cursor', () => {
  const css = `.readout{padding:var(--space-8);border-radius:var(--radius-md);font-size:var(--text-sm)}`
  assert.deepEqual(findButtonChrome(css), [])
})

test('counts a one-sided padding as padding', () => {
  // Otherwise padding-inline is a one-word hole straight through the rule.
  const css = `.sneaky{padding-inline:var(--space-14);border-radius:var(--radius-md);
  font-size:var(--text-sm);cursor:pointer}`
  assert.equal(findButtonChrome(css).length, 1)
})

test('honours token-lint-ignore anywhere in the rule', () => {
  const css = `.fab{padding:var(--space-8);border-radius:var(--radius-circle);
  font-size:var(--text-sm);cursor:pointer}  /* token-lint-ignore: floating action circle */`
  assert.deepEqual(findButtonChrome(css), [])
})

test('reports the line the selector is on', () => {
  const css = `.a{color:var(--ink)}\n\n.b{padding:var(--space-8);border-radius:var(--radius-md);\n  font-size:var(--text-sm);cursor:pointer}`
  assert.equal(findButtonChrome(css)[0].line, 3)
})

test('finds rules nested inside a media query', () => {
  const css = `@media (max-width:600px){\n.m{padding:var(--space-8);border-radius:var(--radius-md);font-size:var(--text-sm);cursor:pointer}\n}`
  assert.equal(findButtonChrome(css).length, 1)
  assert.equal(findButtonChrome(css)[0].selector, '.m')
})

// The stylesheet half above cannot see markup. <Button> in client/ui/ owns the
// .btn class list, and a hand-written className="btn btn--solid" beside it is
// the same drift one layer up: a second way to spell the primitive, which is
// how the stylesheet grew thirty button classes in the first place.

test('flags .btn applied by hand in a className', () => {
  assert.deepEqual(findBtnClass(`<button className="btn">Go</button>`), [1])
  assert.deepEqual(findBtnClass(`\n<a className="btn btn--solid" href="/x">X</a>`), [2])
})

test('flags .btn inside a template or conditional className', () => {
  assert.deepEqual(findBtnClass(`<button className={\`btn \${armed ? "on" : ""}\`} />`), [1])
  assert.deepEqual(findBtnClass(`<button className={busy ? 'btn--ghost' : 'x'} />`), [1])
})

test('ignores classes that merely end in -btn', () => {
  const src = `<button className="rail-btn" /><button className={\`seg-btn\${on ? " on" : ""}\`} />`
  assert.deepEqual(findBtnClass(src), [])
})

test('ignores the word outside a className', () => {
  assert.deepEqual(findBtnClass(`// a btn is fine to mention\n<p title="btn">btn</p>`), [])
})
