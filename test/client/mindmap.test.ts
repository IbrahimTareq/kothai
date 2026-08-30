import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTree } from '../../client/layout/mindmap.ts'

const mk = (o) => ({ id: o.id, ts: 0, type: o.type || 'link', tags: o.tags || [], pending: false, host: o.host, url: o.url })
// Fake platform resolver so this test never touches source.ts.
const opts = { platformOf: (it) => ({ key: 'plat:' + (it.host || 'web'), label: it.host || 'Web' }) }

test('group by type: counts and labels', () => {
  const groups = buildTree([mk({ id: '1', type: 'video' }), mk({ id: '2', type: 'video' }), mk({ id: '3', type: 'link' })], 'type', opts)
  const vid = groups.find((g) => g.key === 'type:video')
  assert.equal(vid.count, 2)
  assert.equal(vid.label, 'Video')
})

test('group by tag: a multi-tag item appears under each tag', () => {
  const groups = buildTree([mk({ id: '1', tags: ['design', 'ai'] }), mk({ id: '2', tags: ['ai'] })], 'tag', opts)
  assert.equal(groups.find((g) => g.key === 'tag:ai').count, 2)
  assert.equal(groups.find((g) => g.key === 'tag:design').count, 1)
})

test('group by tag: items with no tags fall under untagged', () => {
  const groups = buildTree([mk({ id: '1', tags: [] })], 'tag', opts)
  assert.equal(groups[0].key, 'tag:untagged')
})

test('group by platform uses the injected resolver', () => {
  const groups = buildTree([mk({ id: '1', host: 'github.com' })], 'platform', opts)
  assert.equal(groups[0].key, 'plat:github.com')
})

test('groups are sorted by descending count', () => {
  const groups = buildTree([mk({ id: '1', type: 'link' }), mk({ id: '2', type: 'link' }), mk({ id: '3', type: 'video' })], 'type', opts)
  assert.equal(groups[0].key, 'type:link')
})

import { computeRadialLayout } from '../../client/layout/mindmap.ts'

// Hand-crafted branches (only ids matter for layout).
const G = (key, label, n) => ({ key, label, items: Array.from({ length: n }, (_, i) => ({ id: key + i })), count: n })

test('collapsed layout: one space node + one node per branch', () => {
  const { nodes, edges } = computeRadialLayout([G('a', 'A', 2), G('b', 'B', 3)], new Set(), { spaceName: 'S' })
  assert.equal(nodes.filter((n) => n.type === 'space').length, 1)
  assert.equal(nodes.filter((n) => n.type === 'group').length, 2)
  assert.equal(nodes.filter((n) => n.type === 'item').length, 0)
  assert.equal(edges.length, 2)
})

test('expanding a branch adds its item leaves and edges', () => {
  const { nodes, edges } = computeRadialLayout([G('a', 'A', 3)], new Set(['a']), { spaceName: 'S' })
  assert.equal(nodes.filter((n) => n.type === 'item').length, 3)
  assert.equal(edges.length, 4) // space->a, a->(3 items)
})

test('cap: an over-limit branch shows cap items + one more node', () => {
  const { nodes } = computeRadialLayout([G('a', 'A', 15)], new Set(['a']), { spaceName: 'S', cap: 12 })
  assert.equal(nodes.filter((n) => n.type === 'item').length, 12)
  const more = nodes.find((n) => n.type === 'more')
  assert.ok(more)
  assert.equal(more.data.count, 3)
})

test('uncapped branch reveals all items and drops the more node', () => {
  const { nodes } = computeRadialLayout([G('a', 'A', 15)], new Set(['a']), { spaceName: 'S', cap: 12, uncapped: new Set(['a']) })
  assert.equal(nodes.filter((n) => n.type === 'item').length, 15)
  assert.equal(nodes.filter((n) => n.type === 'more').length, 0)
})

test('the space node carries the space name', () => {
  const { nodes } = computeRadialLayout([G('a', 'A', 1)], new Set(), { spaceName: 'My Space' })
  assert.equal(nodes.find((n) => n.type === 'space').data.label, 'My Space')
})
