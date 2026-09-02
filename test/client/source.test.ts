import { test } from 'node:test'
import assert from 'node:assert/strict'
import { platformBucket, SOURCES, isAwaitingContent } from '../../client/domain/source.ts'
import { sourceKey } from '../../server/data/query.js'
import type { UIItem } from '../../client/types.ts'

// Minimal UIItem-shaped fixtures (test files aren't typechecked by the build).
const mk = (o) => ({ id: 'x', ts: 0, type: 'link', tags: [], pending: false, ...o })

test('github host resolves to the GitHub bucket', () => {
  assert.deepEqual(
    platformBucket(mk({ host: 'github.com', url: 'https://github.com/a/b' })),
    { key: 'github', label: 'GitHub' },
  )
})

test('an instagram reel url resolves to Instagram Reels', () => {
  assert.deepEqual(
    platformBucket(mk({ host: 'www.instagram.com', url: 'https://www.instagram.com/reel/abc' })),
    { key: 'reels', label: 'Instagram Reels' },
  )
})

test('a plain link with a host falls under Web', () => {
  assert.deepEqual(
    platformBucket(mk({ host: 'example.com', url: 'https://example.com/x', type: 'link' })),
    { key: 'web', label: 'Web' },
  )
})

test('an instagram post url resolves to Instagram Posts', () => {
  assert.deepEqual(
    platformBucket(mk({ host: 'www.instagram.com', url: 'https://www.instagram.com/p/abc' })),
    { key: 'igposts', label: 'Instagram Posts' },
  )
})

test('an unmatched item (note, no host) falls under Other', () => {
  assert.deepEqual(platformBucket(mk({ type: 'note' })), { key: 'other', label: 'Other' })
})

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
