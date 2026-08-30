import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToRoute, routeToPath, chatPath } from '../../client/app/router.ts'

// The router is a bijection between app `nav` state and the URL path, so a
// refresh (path → route) lands on the same screen a navigation (route → path)
// produced. These round-trip both directions for every nav kind.

test('top-level navs round-trip through the URL', () => {
  for (const nav of ['all', 'core', 'spaces', 'settings']) {
    assert.equal(pathToRoute(routeToPath(nav)).nav, nav)
  }
})

test('type galleries round-trip through the URL', () => {
  for (const nav of ['link', 'image', 'video', 'code', 'note']) {
    assert.equal(pathToRoute(routeToPath(nav)).nav, nav)
  }
})

test('a space detail nav round-trips so refresh keeps you in the space', () => {
  const nav = 'space:abc123'
  assert.equal(routeToPath(nav), '/space/abc123')
  assert.equal(pathToRoute('/space/abc123').nav, nav)
})

test('unknown paths fall back to Everything', () => {
  assert.equal(pathToRoute('/nonsense').nav, 'all')
  assert.equal(pathToRoute('/space').nav, 'all') // missing id → not a real space
})

test('an expanded tile round-trips as an /item/<id> suffix on its board', () => {
  for (const nav of ['all', 'video', 'space:abc123']) {
    const path = routeToPath(nav, 'n1')
    const r = pathToRoute(path)
    assert.equal(r.nav, nav)
    assert.equal(r.item, 'n1')
  }
})

test('the item suffix hangs off the board it was opened from', () => {
  assert.equal(routeToPath('all', 'n1'), '/item/n1')
  assert.equal(routeToPath('video', 'n1'), '/type/video/item/n1')
  assert.equal(routeToPath('space:abc123', 'n1'), '/space/abc123/item/n1')
})

test('a board path carries no item', () => {
  assert.equal(pathToRoute('/type/video').item, undefined)
  assert.equal(pathToRoute('/').item, undefined)
})

test('a dangling item segment is not an item', () => {
  assert.equal(pathToRoute('/item').item, undefined)
  assert.equal(pathToRoute('/space/item').nav, 'space:item')  // a space literally named "item"
  assert.equal(pathToRoute('/space/item').item, undefined)
})

// ---- Ask conversations ---------------------------------------------------
// An open chat is part of the location: /ask/<id> makes a conversation
// shareable, survives a refresh, and gives Back something to return from.

test('an open chat round-trips through /ask/<id>', () => {
  const id = 'a1b2c3d4-0000-4000-8000-000000000000'
  assert.equal(chatPath(id), '/ask/' + id)
  const r = pathToRoute('/ask/' + id)
  assert.equal(r.nav, 'core')
  assert.equal(r.chat, id)
})

test('a bare /ask carries no chat', () => {
  assert.equal(chatPath(null), '/ask')
  assert.equal(pathToRoute('/ask').chat, undefined)
  assert.equal(pathToRoute('/ask').nav, 'core')
})

test('a chat id is encoded on the way out and decoded on the way back', () => {
  const id = 'id with spaces'
  assert.equal(chatPath(id), '/ask/id%20with%20spaces')
  assert.equal(pathToRoute(chatPath(id)).chat, id)
})

test('a trailing slash on /ask/<id> does not change the chat', () => {
  assert.equal(pathToRoute('/ask/xyz/').chat, 'xyz')
})

test('chat ids do not leak into the other navs', () => {
  assert.equal(pathToRoute('/spaces/whatever').chat, undefined)
  assert.equal(pathToRoute('/settings/whatever').chat, undefined)
})
