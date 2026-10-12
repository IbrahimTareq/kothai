// Names a screen reader gets for the app's own controls, found missing or wrong
// by the first technical audit (2026-10-11):
//   - Capture was named by its cross-fading label, both words always in the
//     DOM, so it read "Capture Added"; on a phone the label is display:none and
//     the app's primary action was announced as just "button". Its "Added"
//     confirmation was a fade, never announced.
//   - On a phone Everything's title was display:none, so the page had no
//     heading at all.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = (path: string) => readFileSync(new URL(`../../client/${path}`, import.meta.url), 'utf8')

test('the capture button has a fixed name, and announces "Added" in a live region', () => {
  const app = src('app/App.tsx')
  assert.match(app, /<button className=\{`fab[^>]*aria-label="Capture"/)
  assert.match(app, /writes\.say\('Added'\)/)
  assert.match(src('app/useItemWrites.tsx'), /className="sr-only" role="status">\s*\{spoken\}/)
})

test("on a phone Everything's title is hidden from sight, not from the accessibility tree", () => {
  const phone = src('styles/foundation/responsive.css')
  assert.doesNotMatch(phone, /\.gallery-view \.page-title[^{]*\{display:none/)
  assert.match(phone, /\.gallery-view \.page-title\{[^}]*clip-path:inset\(50%\)/)
})

// A board card and an Ask chat row were role="button" containers with real
// buttons inside them — nested interactive controls, which assistive tech
// flattens — and a card was named by its raw URL, tracking parameters and all.
// Each now opens through a link to its own address, beside its actions.
test('an item card opens through a link named by its title, beside its actions', () => {
  const cards = src('components/Cards.tsx')
  const card = cards.slice(cards.indexOf('export function ItemCard'), cards.indexOf('// ── Ask citation tiles'))
  assert.doesNotMatch(card, /role=\{openable|role="button"/)
  assert.doesNotMatch(card, /title=\{item\.url/)
  assert.match(card, /<a\s+className="card-open"[^>]*href=\{/)
})

// Every tag chip in the item view was named "Remove tag", so a list of eight
// read as eight identical buttons.
test("a tag's remove chip names the tag", () => {
  assert.match(src('views/Expanded.tsx'), /<Chip compact removable[^>]*aria-label=\{`Remove tag \$\{t\}`\}/)
})

// Import and Restore hide their file input inside a <label class="btn">: Tab
// lands on the input, which is invisible, and the label drew no ring — so a
// keyboard user could not see they were on Restore, which overwrites data.
test("a file picker shows its hidden input's keyboard focus", () => {
  assert.match(
    readFileSync(new URL('../../client/styles/views/settings.css', import.meta.url), 'utf8'),
    /\.import-pick:has\(input:focus-visible\)\s*\{[^}]*outline:\s*var\(--focus-ring\)/,
  )
})

// The link fills the card, so a ring drawn outside it lands outside the card,
// where a link tile's overflow:hidden clipped it away: Tab reached the card and
// showed nothing (seen in the browser, 2026-10-11). The card draws it instead.
test("a card's keyboard focus ring is drawn by the card, not clipped off its link", () => {
  const css = readFileSync(new URL('../../client/styles/components/card.css', import.meta.url), 'utf8')
  assert.match(css, /\.item-card:has\(> \.card-open:focus-visible\)\{outline:var\(--focus-ring\)/)
})

test('a chat row opens through a link, beside its rename and delete', () => {
  const chats = src('components/Chats.tsx')
  assert.doesNotMatch(chats, /role="button"/)
  assert.match(chats, /<a\s+className="chat-open"[^>]*href=\{chatPath\(/)
})
