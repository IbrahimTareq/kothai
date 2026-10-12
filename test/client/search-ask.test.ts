// Kothai means "where", but its two ways of finding were strangers: the
// gallery's search matches text, Ask matches meaning, and a search with no
// results ended there, a dead end with no way on (design critique, 2026-10-12).
// Now no results — or Enter on none — offers to ask the question instead, in a
// conversation of its own; and the query lives in the URL, so a refresh or
// Back keeps it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = (path: string) => readFileSync(new URL(`../../client/${path}`, import.meta.url), 'utf8')

test('a search with no results offers to ask it, and Enter on none asks it', () => {
  const gallery = src('views/Gallery.tsx')
  assert.match(gallery, /onClick=\{\(\) => onAsk\(search\)\}/)
  assert.match(gallery, /e\.key === 'Enter'[\s\S]{0,80}onAsk\(search\)/)
})

test('asking from search starts a new conversation rather than adding to the last', () => {
  const chat = src('data/useChat.ts')
  const fresh = chat.slice(chat.indexOf('const askFresh'), chat.indexOf('\n  }\n', chat.indexOf('const askFresh')))
  assert.match(fresh, /clearChat\(\)/)
  assert.match(fresh, /sendQuestion\([^)]*, null\)/)
  assert.match(src('app/App.tsx'), /onAsk: \(q: string\) => \{[\s\S]{0,80}chat\.askFresh\(q\)/)
})

test('the search query is read from and kept in the URL', () => {
  const app = src('app/App.tsx')
  assert.match(app, /new URLSearchParams\(location\.search\)\.get\('q'\)/)
  assert.match(app, /\?q=\$\{encodeURIComponent\(search\)\}/)
  // Back and Forward restore it as well as the board.
  const onPop = app.slice(app.indexOf('const onPop'), app.indexOf("window.addEventListener('popstate'"))
  assert.match(onPop, /setSearch\(new URLSearchParams\(location\.search\)\.get\('q'\)/)
})
