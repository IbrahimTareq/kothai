// Tests for client/domain/boardQuery.ts — the chip/nav → server query mapping.
//
// These rules were four const declarations inside App's render until now, so
// nothing checked them. The one the comment in App has always asserted in prose
// — "Instagram AND TikTok widens, adding Videos narrows" — is the first test
// below, and it is the reason this module exists separately at all.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boardQuery, isBoardNav } from '../../client/domain/boardQuery.ts'

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

test('isBoardNav excludes the screens that are not a filtered board', () => {
  for (const nav of ['core', 'settings', 'spaces', 'space:abc']) {
    assert.equal(isBoardNav(nav), false, nav)
  }
  for (const nav of ['all', 'link', 'video']) {
    assert.equal(isBoardNav(nav), true, nav)
  }
})

test('sort rides through untouched', () => {
  assert.equal(q('all', [], '', 'oldest').sort, 'oldest')
})
