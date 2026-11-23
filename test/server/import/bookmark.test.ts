import test from 'node:test'
import assert from 'node:assert/strict'
import { usableUrl, importTags, importDate, clipText } from '../../../server/import/untrusted.ts'
import { deriveBookmarkNote, type BookmarkItem } from '../../../server/import/bookmark.ts'

test('usableUrl: http(s) only, capped, trimmed', () => {
  assert.equal(usableUrl('javascript:alert(1)'), null)
  assert.equal(usableUrl('ftp://x'), null)
  assert.equal(usableUrl(`https://a.com/${'x'.repeat(2040)}`), null)
  assert.equal(usableUrl(' https://a.com/x '), 'https://a.com/x')
  assert.equal(usableUrl(42), null)
  // Nothing after the scheme: canonicalUrl returns null, and the route counted
  // it as "already saved".
  assert.equal(usableUrl('https://'), null)
  assert.equal(usableUrl('http:// '), null)
})

test('clipText: keeps newlines, collapses spaces, strips control characters, slices', () => {
  assert.equal(clipText('  a \t  b\u0000\nc\u0007  ', 100), 'a b\nc')
  assert.equal(clipText('abcdef', 3), 'abc')
  assert.equal(clipText(null, 3), '')
})

test('importTags: splits, trims, lower-cases, dedupes and caps', () => {
  assert.deepEqual(importTags('Design| Fonts|design|', '|'), ['design', 'fonts'])
  assert.equal(
    importTags(
      Array.from({ length: 25 }, (_, i) => `t${i}`),
      ',',
    ).length,
    20,
  )
  assert.deepEqual(importTags(['  A   B ', 7, ''], ','), ['a b'])
  assert.equal(importTags('x'.repeat(100), ',')[0]!.length, 60)
})

test('importDate: seconds, milliseconds, numeric string and ISO; zero for junk', () => {
  assert.equal(importDate(1684913522), 1684913522)
  assert.equal(importDate(1684913522000), 1684913522)
  assert.equal(importDate('1684913522'), 1684913522)
  assert.equal(importDate('2026-09-20T10:15:00.000Z'), Date.UTC(2026, 8, 20, 10, 15) / 1000)
  assert.equal(importDate('nonsense'), 0)
  assert.equal(importDate('2200-01-01T00:00:00Z'), 0)
})

const item = (over: Partial<BookmarkItem> = {}): BookmarkItem => ({
  url: 'https://example.com/a',
  title: 'A title',
  tags: [],
  note: '',
  savedAt: 1684913522,
  ...over,
})

test('deriveBookmarkNote: a tagged item keeps its tags and marks them user-edited', () => {
  const n = deriveBookmarkNote(item({ tags: ['x', 'y'] }))
  assert.deepEqual(n.tags, ['x', 'y'])
  assert.deepEqual(n.ai, { tagsEdited: true })
})

test('deriveBookmarkNote: an untagged item has no ai key', () => {
  const n = deriveBookmarkNote(item())
  assert.deepEqual(n.tags, [])
  assert.equal('ai' in n, false)
})

test('deriveBookmarkNote: an empty title falls back to deriveTitle(url)', () => {
  assert.equal(deriveBookmarkNote(item({ title: '' })).title, 'https://example.com/a')
})

test('deriveBookmarkNote: a YouTube URL is a video', () => {
  assert.equal(deriveBookmarkNote(item({ url: 'https://youtu.be/abc' })).type, 'video')
  assert.equal(deriveBookmarkNote(item()).type, 'link')
})

test('deriveBookmarkNote: savedAt 0 means now; otherwise the saved date', () => {
  const now = Date.parse(deriveBookmarkNote(item({ savedAt: 0 })).createdAt!)
  assert.ok(Math.abs(now - Date.now()) < 5000)
  assert.equal(deriveBookmarkNote(item()).createdAt, new Date(1684913522 * 1000).toISOString())
})

test('deriveBookmarkNote: a note becomes mindNote, capped; none means no key', () => {
  assert.equal(deriveBookmarkNote(item({ note: 'hello' })).mindNote, 'hello')
  assert.equal(deriveBookmarkNote(item({ note: 'x'.repeat(5000) })).mindNote!.length, 4000)
  assert.equal('mindNote' in deriveBookmarkNote(item()), false)
})

test('deriveBookmarkNote: always content = url, url and pending', () => {
  const n = deriveBookmarkNote(item())
  assert.equal(n.content, 'https://example.com/a')
  assert.equal(n.url, 'https://example.com/a')
  assert.equal(n.pending, true)
})
