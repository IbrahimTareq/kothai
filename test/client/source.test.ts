import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SOURCES, isAwaitingContent } from '../../client/domain/source.ts'
import { sourceKey } from '../../server/data/query.ts'
import type { NoteType, UIItem } from '../../client/types.ts'
import type { ServerNote } from '../../server/types.ts'

test('server sourceKey agrees with client SOURCES on every predicate', () => {
  // Annotated, not inferred: `type` would otherwise widen to `string` and stop
  // being the NoteType both sides of this parity check are typed against.
  const fixtures: { url: string | null; type: NoteType }[] = [
    { url: 'https://www.instagram.com/reel/A/', type: 'video' },
    { url: 'https://www.instagram.com/p/B/', type: 'video' },
    { url: 'https://github.com/o/r', type: 'link' },
    { url: 'https://x.com/u/status/1', type: 'link' },
    { url: 'https://www.tiktok.com/@u/video/1', type: 'video' },
    { url: 'https://reddit.com/r/x', type: 'link' },
    { url: 'https://example.com/a', type: 'link' },
    { url: null, type: 'text' },
  ]
  for (const f of fixtures) {
    const item: UIItem = {
      id: 'x',
      ts: 0,
      type: f.type === 'text' ? 'note' : f.type,
      tags: [],
      pending: false,
      url: f.url,
      host: f.url ? new URL(f.url).hostname.replace(/^www\./, '') : undefined,
    }
    // sourceKey reads only `type` and `url`, but it is typed against the whole
    // record; the rest are filled with empty values rather than narrowing the
    // server's signature to suit a test.
    const note: ServerNote = {
      id: 'x',
      createdAt: '',
      type: f.type,
      category: '',
      title: '',
      summary: '',
      tags: [],
      content: '',
      url: f.url,
      image: null,
    }
    const clientKey = SOURCES.find(s => s.test(item))?.key ?? null
    assert.equal(sourceKey(note), clientKey, String(f.url))
  }
})

// --- isAwaitingContent -------------------------------------------------------
// Pins the gate that decides whether a tile renders as loading. Its first
// version tested `pending` alone, which lit a whole screen of a real library
// with permanently shimmering tiles: `pending` only means the model pass hasn't
// run, and a link with no picture stays pending and thumbnail-less forever.

test('a freshly imported note, before its metadata is fetched, is awaiting content', () => {
  assert.equal(isAwaitingContent({ pending: true, metaFetched: false, thumb: null, img: null }), true)
})

test('metadata already attempted means this IS the final content, however bare', () => {
  // The case that broke it: pending (the model pass is still queued) but the
  // fetch already ran and found no picture. Nothing more is coming.
  assert.equal(isAwaitingContent({ pending: true, metaFetched: true, thumb: null, img: null }), false)
})

test('a note that already has a picture is never a skeleton, even while pending', () => {
  assert.equal(isAwaitingContent({ pending: true, metaFetched: false, thumb: '/uploads/a.jpg', img: null }), false)
  assert.equal(isAwaitingContent({ pending: true, metaFetched: false, thumb: null, img: '/uploads/b.jpg' }), false)
})

test('a settled note is never a skeleton', () => {
  assert.equal(isAwaitingContent({ pending: false, metaFetched: false, thumb: null, img: null }), false)
})
