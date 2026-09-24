// The design system's button primitive is only the default if hand-rolling one
// is harder than reaching for it. This detector is the "harder" half: it finds
// rules that build a button box from scratch, wherever they are written.
//
// It keys on the chrome, not the class name. A rule matching `.foo-btn` outside
// primitives.css would be satisfied by naming the next one `.wizard-test` —
// which is exactly how .conn-btn and .wizard-test came to exist.
import test from 'node:test'
import assert from 'node:assert/strict'
import { checkRaw, countRawButtons, countRawFields, findBtnClass, findButtonChrome } from '../../scripts/button-chrome.ts'

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

// findBtnClass keeps .btn's spelling in one place, but a raw <button> with its
// own class skips the primitive altogether — 65 of them did when this landed.
// They are debt on a ratchet: counted per file, and the count only falls.

test('counts raw <button> tags, including ones that wrap onto the next line', () => {
  assert.equal(countRawButtons(`<button className="a">x</button>\n<button\n  onClick={go}\n>y</button>`), 2)
})

test('does not count <Button> or a <button> named in a comment', () => {
  const src = `// a <button> cannot save a file\n/* nor can <button> */\n{/* <button> */}\n<Button>ok</Button>`
  assert.equal(countRawButtons(src), 0)
})

test('fails a file whose raw buttons rose, or a new file with any', () => {
  const fails = checkRaw({ 'a.tsx': 3, 'b.tsx': 1 }, { 'a.tsx': 2 }, '<button>')
  assert.equal(fails.length, 2)
  assert.match(fails[0], /a\.tsx: 3 raw <button>, baseline is 2/)
  assert.match(fails[1], /b\.tsx: 1 raw <button>, baseline is 0/)
})

test('fails a baseline left looser than the file, so the ratchet stays tight', () => {
  assert.match(checkRaw({ 'a.tsx': 1 }, { 'a.tsx': 2 }, '<button>')[0], /lower a\.tsx to 1/)
  assert.match(checkRaw({}, { 'gone.tsx': 2 }, '<button>')[0], /remove gone\.tsx/)
})

test('passes when every count matches its baseline', () => {
  assert.deepEqual(checkRaw({ 'a.tsx': 2, 'b.tsx': 0 }, { 'a.tsx': 2 }, '<button>'), [])
})

test('a /* inside a string does not open a comment', () => {
  // Core.tsx's accept="image/*" once swallowed the attach button after it.
  assert.equal(countRawButtons(`<input accept="image/*" />\n<button>a</button>\n{/* note */}`), 1)
})

// Fields drifted the way buttons did — seven boxed ones in five backgrounds —
// so raw <input>, <textarea> and <select> go on the same ratchet, beside
// <Input> and <Textarea> in client/ui/.

test('counts raw fields of all three kinds, not their client/ui components', () => {
  const src = `<input value={a} />\n<textarea\n  value={b}\n/>\n<select>{o}</select>\n<Input /><Textarea />`
  assert.equal(countRawFields(src), 3)
})

test('names the tag it is ratcheting in its report', () => {
  assert.match(checkRaw({ 'a.tsx': 2 }, { 'a.tsx': 1 }, 'field')[0], /a\.tsx: 2 raw field, baseline is 1/)
})
