// mapNote is the one place a server note becomes what a card renders, so a
// field the server stores for the card has to survive it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapNote } from '../../client/data/api.ts'
import type { ServerNote } from '../../client/types.ts'

const base: ServerNote = {
  id: 'a',
  createdAt: '2026-01-01T00:00:00.000Z',
  type: 'link',
  category: '',
  title: 'A page',
  summary: '',
  tags: [],
  content: 'https://example.com/',
  url: 'https://example.com/',
}

// The server stores a thumbnail's width / height when it saves one (see
// server/links/fetch.ts's saveThumb). Without it on the card, the image's box
// is zero-high until the file arrives, and every card grew and repacked the
// board as its picture loaded.
test('mapNote: a thumbnail’s stored shape reaches the card', () => {
  assert.equal(mapNote({ ...base, thumb: '/uploads/meta-a.jpg', thumbRatio: 1.912 }).thumbRatio, 1.912)
  assert.equal(mapNote({ ...base, thumb: '/uploads/meta-a.jpg' }).thumbRatio, null, 'saved before shapes were')
})

// On the demo, a card and the item view unlock a link's delete, re-tag, tags
// and note only for the visitor who saved it, and they know it by this field.
test('mapNote: the demo visitor who saved a link reaches the card', () => {
  assert.equal(mapNote({ ...base, visitor: 'v1' }).visitor, 'v1')
  assert.equal(mapNote(base).visitor, undefined, 'the shared library, and every note of an ordinary install')
})
