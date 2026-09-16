// Tests for client/domain/tagSuggest.ts — the smart-rule tag picker's ranking.
//
// Five behaviours that were inline in CollectionView's render with no coverage:
// exclusion of existing rules, the count, the two-key sort, substring matching,
// and when "add this as a new tag" is offered.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { suggestTags } from '../../client/domain/tagSuggest.ts'
import type { UIItem } from '../../client/types.ts'

const item = (id: string, tags: string[]): UIItem => ({ id, tags, type: 'note', title: id, ts: 0 }) as unknown as UIItem

const ITEMS = [item('a', ['pasta', 'dinner', 'quick']), item('b', ['pasta', 'dinner']), item('c', ['pasta', 'baking'])]

test('counts how many items carry each tag', () => {
  const { suggestions } = suggestTags(ITEMS, [], '')
  assert.deepEqual(suggestions[0], { tag: 'pasta', count: 3 })
  assert.deepEqual(suggestions[1], { tag: 'dinner', count: 2 })
})

test('tags already used as a rule are never offered', () => {
  const { suggestions } = suggestTags(ITEMS, ['pasta'], '')
  assert.ok(!suggestions.some(s => s.tag === 'pasta'), 'the existing rule is gone')
  assert.equal(suggestions[0].tag, 'dinner', 'and the next one takes the top slot')
})

test('equal counts are ordered alphabetically, not by insertion', () => {
  // baking and quick both appear once; 'quick' is seen first walking the items.
  const { suggestions } = suggestTags(ITEMS, [], '')
  const ones = suggestions.filter(s => s.count === 1).map(s => s.tag)
  assert.deepEqual(ones, ['baking', 'quick'], 'alphabetical breaks the tie')
})

test('the query filters by substring, not prefix', () => {
  const { suggestions } = suggestTags(ITEMS, [], 'ast')
  assert.deepEqual(
    suggestions.map(s => s.tag),
    ['pasta'],
  )
})

test('canAddNew is offered for a genuinely new tag', () => {
  const { canAddNew } = suggestTags(ITEMS, [], 'brunch')
  assert.equal(canAddNew, true)
})

test('canAddNew is withheld when the tag is already suggested or already a rule', () => {
  assert.equal(suggestTags(ITEMS, [], 'pasta').canAddNew, false, 'already in the list')
  assert.equal(suggestTags(ITEMS, ['pasta'], 'pasta').canAddNew, false, 'already a rule')
  assert.equal(suggestTags(ITEMS, [], '').canAddNew, false, 'nothing typed')
  assert.equal(suggestTags(ITEMS, [], '   ').canAddNew, false, 'whitespace is nothing typed')
})

test('the list is capped', () => {
  const many = [
    item(
      'x',
      Array.from({ length: 30 }, (_, i) => `t${String(i).padStart(2, '0')}`),
    ),
  ]
  assert.equal(suggestTags(many, [], '').suggestions.length, 8)
  assert.equal(suggestTags(many, [], '', 3).suggestions.length, 3)
})

test('poolSize reports the unfiltered candidates, so the empty state can tell the two cases apart', () => {
  assert.equal(suggestTags(ITEMS, [], 'zzz').poolSize, 4, 'matched nothing, but there was something to match')
  assert.equal(suggestTags(ITEMS, [], 'zzz').suggestions.length, 0)
  assert.equal(suggestTags([], [], '').poolSize, 0, 'genuinely nothing here')
})

test('items with no tags at all are harmless', () => {
  const { suggestions, poolSize } = suggestTags([item('n', [])], [], '')
  assert.deepEqual(suggestions, [])
  assert.equal(poolSize, 0)
})
