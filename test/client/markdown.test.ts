import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMarkdown, parseInline } from '../../client/util/markdown.ts'
import type { Block, Inline } from '../../client/util/markdown.ts'

// The Ask view renders answers through this parser. Its job is narrow: catch
// the handful of marks a local answer model emits, and leave everything else
// alone rather than guess.

const text = (spans: Inline[]) => spans.map((s) => (s.kind === 'br' ? '\n' : s.text)).join('')

test('plain prose is one paragraph', () => {
  const b = parseMarkdown('The notes do not mention Kubernetes.')
  assert.equal(b.length, 1)
  assert.equal(b[0].kind, 'p')
  assert.equal(text((b[0] as Extract<Block, { kind: 'p' }>).spans), 'The notes do not mention Kubernetes.')
})

test('a blank line starts a new paragraph', () => {
  const b = parseMarkdown('First point.\n\nSecond point.')
  assert.deepEqual(b.map((x) => x.kind), ['p', 'p'])
})

test('a single newline inside a paragraph is a hard break, not a lost line', () => {
  const b = parseMarkdown('Line one\nLine two')
  assert.equal(b.length, 1)
  const spans = (b[0] as Extract<Block, { kind: 'p' }>).spans
  assert.ok(spans.some((s) => s.kind === 'br'))
  assert.equal(text(spans), 'Line one\nLine two')
})

test('empty input produces no blocks', () => {
  assert.deepEqual(parseMarkdown(''), [])
  assert.deepEqual(parseMarkdown('   \n\n  '), [])
})

test('consecutive bullets collapse into one list', () => {
  const b = parseMarkdown('- alpha\n- beta\n- gamma')
  assert.equal(b.length, 1)
  const list = b[0] as Extract<Block, { kind: 'ul' }>
  assert.equal(list.kind, 'ul')
  assert.deepEqual(list.items.map(text), ['alpha', 'beta', 'gamma'])
})

test('numbered lists keep the number they started at', () => {
  const list = parseMarkdown('3. third\n4. fourth')[0] as Extract<Block, { kind: 'ol' }>
  assert.equal(list.kind, 'ol')
  assert.equal(list.start, 3)
  assert.deepEqual(list.items.map(text), ['third', 'fourth'])
})

test('a paragraph before a list is not absorbed into it', () => {
  const b = parseMarkdown('Here is what I found:\n- alpha\n- beta')
  assert.deepEqual(b.map((x) => x.kind), ['p', 'ul'])
})

test('headings become headings instead of literal hashes', () => {
  const h = parseMarkdown('## Saved notes')[0] as Extract<Block, { kind: 'h' }>
  assert.equal(h.kind, 'h')
  assert.equal(h.level, 2)
  assert.equal(text(h.spans), 'Saved notes')
})

test('a fenced block keeps its body verbatim and records the language', () => {
  const pre = parseMarkdown('```js\nconst a = 1\n\nconst b = 2\n```')[0] as Extract<Block, { kind: 'pre' }>
  assert.equal(pre.kind, 'pre')
  assert.equal(pre.lang, 'js')
  assert.equal(pre.text, 'const a = 1\n\nconst b = 2')
})

test('an unclosed fence still yields a code block rather than eating the answer', () => {
  const pre = parseMarkdown('```\nconst a = 1')[0] as Extract<Block, { kind: 'pre' }>
  assert.equal(pre.kind, 'pre')
  assert.equal(pre.text, 'const a = 1')
})

test('markdown inside a fence is left alone', () => {
  const pre = parseMarkdown('```\n- not a list\n**not bold**\n```')[0] as Extract<Block, { kind: 'pre' }>
  assert.equal(pre.text, '- not a list\n**not bold**')
})

test('a horizontal rule is dropped rather than shown as dashes', () => {
  const b = parseMarkdown('before\n\n---\n\nafter')
  assert.deepEqual(b.map((x) => x.kind), ['p', 'p'])
})

test('bold, italic and code spans are recognised', () => {
  assert.deepEqual(parseInline('a **b** c *d* e `f` g'), [
    { kind: 'text', text: 'a ' },
    { kind: 'strong', text: 'b' },
    { kind: 'text', text: ' c ' },
    { kind: 'em', text: 'd' },
    { kind: 'text', text: ' e ' },
    { kind: 'code', text: 'f' },
    { kind: 'text', text: ' g' },
  ])
})

test('bold is not read as two italics', () => {
  assert.deepEqual(parseInline('**loud**'), [{ kind: 'strong', text: 'loud' }])
})

test('a code span wins over emphasis inside it', () => {
  assert.deepEqual(parseInline('`a * b * c`'), [{ kind: 'code', text: 'a * b * c' }])
})

test('stray asterisks stay literal', () => {
  assert.deepEqual(parseInline('2 * 3 * 4'), [{ kind: 'text', text: '2 * 3 * 4' }])
  assert.deepEqual(parseInline('a * b'), [{ kind: 'text', text: 'a * b' }])
})

test('underscores are never emphasis — snake_case survives', () => {
  assert.deepEqual(parseInline('call site_name_here now'), [{ kind: 'text', text: 'call site_name_here now' }])
})

test('a bold run at the start of a line is not mistaken for a bullet', () => {
  const b = parseMarkdown('**Summary:** two notes matched.')
  assert.equal(b[0].kind, 'p')
  assert.equal((b[0] as Extract<Block, { kind: 'p' }>).spans[0].kind, 'strong')
})

test('citation markers pass through untouched for the linkifier', () => {
  const spans = parseInline('The note [1] and the other [2].')
  assert.equal(text(spans), 'The note [1] and the other [2].')
})
