import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SOURCES, isAwaitingContent } from '../../client/domain/source.ts'
import { sourceKey } from '../../server/data/query.js'
import type { UIItem } from '../../client/types.ts'

test('server sourceKey agrees with client SOURCES on every predicate', () => {
  const fixtures = [
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
    const item = { id: 'x', ts: 0, type: f.type === 'text' ? 'note' : f.type, tags: [], pending: false,
      url: f.url, host: f.url ? new URL(f.url).hostname.replace(/^www\./, '') : undefined } as UIItem
    const clientKey = SOURCES.find((s) => s.test(item))?.key ?? null
    assert.equal(sourceKey({ type: f.type, url: f.url }), clientKey, String(f.url))
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
