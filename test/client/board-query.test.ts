// Tests for client/domain/boardQuery.ts — the chip/nav → server query mapping.
//
// These rules were four const declarations inside App's render until now, so
// nothing checked them. The one the comment in App has always asserted in prose
// — "Instagram AND TikTok widens, adding Videos narrows" — is the first test
// below, and it is the reason this module exists separately at all.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boardQuery, matchesLocal } from '../../client/domain/boardQuery.ts'
import type { UIItem } from '../../client/types.ts'

const TYPES = new Set(['link', 'video'])
const SOURCES = new Set(['instagram', 'tiktok', 'youtube', 'github'])
const isSource = (k: string) => SOURCES.has(k)
const q = (nav: string, chips: string[] = [], search = '', sort = 'newest') =>
  boardQuery(nav, chips, search, sort, TYPES, isSource).query

test('OR within a facet, AND across them — two sources widen, a type then narrows', () => {
  assert.equal(q('all', ['instagram', 'tiktok']).source, 'instagram,tiktok')
  assert.equal(q('all', ['instagram', 'tiktok']).type, undefined, 'no type constraint yet')

  const narrowed = q('all', ['instagram', 'tiktok', 'video'])
  assert.equal(narrowed.source, 'instagram,tiktok', 'both sources survive')
  assert.equal(narrowed.type, 'video', 'and the type rides alongside, not instead')
})

test('unavailable is a state, so it combines rather than replacing', () => {
  const both = q('all', ['unavailable', 'instagram'])
  assert.equal(both.unavailable, true)
  assert.equal(both.source, 'instagram', 'the source selection survives alongside it')
  assert.equal(both.type, undefined, 'and it never leaks into the type list')
})

test('a direct type-nav outranks the type chips', () => {
  assert.equal(q('link', ['video']).type, 'link')
})

test('a type-nav does not suppress source or search', () => {
  const out = q('video', ['instagram'], 'sourdough')
  assert.equal(out.type, 'video')
  assert.equal(out.source, 'instagram')
  assert.equal(out.q, 'sourdough')
})

test('"all" and a space nav are never treated as a type', () => {
  assert.equal(q('all').type, undefined)
  assert.equal(q('space:abc').type, undefined)
})

test('an unknown nav contributes no type filter', () => {
  assert.equal(q('nonsense').type, undefined)
})

test('empty selections come through as undefined, not empty strings', () => {
  const out = q('all', [])
  assert.equal(out.type, undefined)
  assert.equal(out.source, undefined)
  assert.equal(out.unavailable, undefined)
})

const active = (nav: string) => boardQuery(nav, [], '', 'newest', TYPES, isSource).active

test('the board query is inactive on the screens that are not a filtered board', () => {
  for (const nav of ['core', 'settings', 'spaces', 'space:abc']) {
    assert.equal(active(nav), false, nav)
  }
  for (const nav of ['all', 'link', 'video']) {
    assert.equal(active(nav), true, nav)
  }
})

test('sort rides through untouched', () => {
  assert.equal(q('all', [], '', 'oldest').sort, 'oldest')
})

// --- matchesLocal ------------------------------------------------------------
const item = (id: string, o: Partial<UIItem> = {}): UIItem => ({
  id,
  ts: 0,
  type: 'link',
  tags: [],
  pending: false,
  ...o,
})

test('matchesLocal mirrors the server filter for optimistic inserts', () => {
  const reel = item('r', { type: 'video', url: 'https://www.instagram.com/reel/A/', host: 'instagram.com' })
  assert.ok(matchesLocal(reel, {}))
  assert.ok(matchesLocal(reel, { type: 'video' }))
  assert.ok(!matchesLocal(reel, { type: 'link' }))
  assert.ok(matchesLocal(reel, { source: 'reels' }))
  assert.ok(!matchesLocal(item('t', { title: 'hello' }), { q: 'xyz' }))
  assert.ok(matchesLocal(item('t', { title: 'hello world' }), { q: 'world' }))
})

// A collection-scoped query can't be mirrored client-side: an item carries no
// record of which collections it belongs to (unlike type/source/q, which are
// derivable from the item itself). Without this, applyDelta would treat any
// vault-wide change as belonging to whatever Space is currently open.
test('matchesLocal never optimistically matches a collection-scoped query', () => {
  const it = item('x', { type: 'video', tags: ['whatever'] })
  assert.ok(!matchesLocal(it, { collection: 'c1' }))
  assert.ok(!matchesLocal(it, { collection: 'c1', type: 'video' })) // even if every other clause matches
})

// --- multi-select filters ----------------------------------------------------
// matchesLocal mirrors the server's applyFilters so an optimistically saved note
// lands in (or stays out of) the current view without a round trip. When the
// filters became multi-select, a mirror still comparing one value would have
// silently dropped every optimistic note from any multi-chip view.

test('matchesLocal: a note matches if it is ANY of the selected types', () => {
  const vid = { id: 'a', type: 'video', pending: false, ts: 0, tags: [] } as UIItem
  const link = { id: 'b', type: 'link', pending: false, ts: 0, tags: [] } as UIItem
  assert.equal(matchesLocal(vid, { type: 'video,link' }), true)
  assert.equal(matchesLocal(link, { type: 'video,link' }), true)
  assert.equal(matchesLocal(vid, { type: 'link' }), false)
})

test('matchesLocal: a note matches if it is from ANY of the selected sources', () => {
  const tt = {
    id: 'a',
    type: 'video',
    host: 'www.tiktok.com',
    url: 'https://www.tiktok.com/video/1',
    pending: false,
    ts: 0,
    tags: [],
  } as UIItem
  assert.equal(matchesLocal(tt, { source: 'tiktok' }), true)
  assert.equal(matchesLocal(tt, { source: 'reels,tiktok' }), true)
  assert.equal(matchesLocal(tt, { source: 'reels' }), false)
})

test('matchesLocal: facets AND together', () => {
  const tt = {
    id: 'a',
    type: 'video',
    host: 'www.tiktok.com',
    url: 'https://www.tiktok.com/video/1',
    pending: false,
    ts: 0,
    tags: [],
  } as UIItem
  assert.equal(matchesLocal(tt, { source: 'tiktok', type: 'video' }), true)
  assert.equal(matchesLocal(tt, { source: 'tiktok', type: 'link' }), false)
})

test('matchesLocal: unavailable combines with the rest, and is hidden by default', () => {
  const dead = { id: 'a', type: 'video', unavailable: true, pending: false, ts: 0, tags: [] } as UIItem
  const live = { id: 'b', type: 'video', pending: false, ts: 0, tags: [] } as UIItem
  assert.equal(matchesLocal(dead, { unavailable: true, type: 'video' }), true)
  assert.equal(matchesLocal(live, { unavailable: true, type: 'video' }), false)
  // The default direction: a dead note stays out of an ordinary view.
  assert.equal(matchesLocal(dead, { type: 'video' }), false)
  assert.equal(matchesLocal(dead, {}), false)
  assert.equal(matchesLocal(live, {}), true)
})

test('matchesLocal: an empty selection filters nothing', () => {
  const vid = { id: 'a', type: 'video', pending: false, ts: 0, tags: [] } as UIItem
  assert.equal(matchesLocal(vid, {}), true)
  assert.equal(matchesLocal(vid, { type: '' }), true)
})
