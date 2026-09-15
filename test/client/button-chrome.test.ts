// The design system's button primitive is only the default if hand-rolling one
// is harder than reaching for it. This detector is the "harder" half: it finds
// rules that build a button box from scratch, wherever they are written.
//
// It keys on the chrome, not the class name. A rule matching `.foo-btn` outside
// primitives.css would be satisfied by naming the next one `.wizard-test` —
// which is exactly how .conn-btn and .wizard-test came to exist.
import test from 'node:test'
import assert from 'node:assert/strict'
import { findButtonChrome } from '../../scripts/button-chrome.mjs'

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
