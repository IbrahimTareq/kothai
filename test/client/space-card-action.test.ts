// A space is a view onto the archive, so the action in a card's corner there
// takes the item out of the space, not out of Kothai. Space.tsx handed every
// card App's archive-wide deleteItem under a trash icon titled "Release": in a
// collection, trash reads as "take it out of here", and the item went from
// everywhere — the likeliest real data loss in the app, found by the first
// design critique (2026-10-11).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = (path: string) => readFileSync(new URL(`../../client/${path}`, import.meta.url), 'utf8')

/** The JSX of the first `<ItemCard … />` in a source file. */
function itemCard(file: string): string {
  const s = src(file)
  const at = s.indexOf('<ItemCard')
  assert.ok(at >= 0, `${file} renders no <ItemCard>`)
  return s.slice(at, s.indexOf('/>', at))
}

test('a card inside a space is not handed the archive-wide delete', () => {
  const card = itemCard('views/Space.tsx')
  assert.doesNotMatch(card, /onDelete=/)
  assert.match(card, /space=\{/)
})

test('the card names removal from a space and deletion plainly', () => {
  const cards = src('components/Cards.tsx')
  assert.match(cards, /'Remove from space'/)
  assert.doesNotMatch(cards, /"Release"|'Release'/, 'one action, one verb: Delete')
})
