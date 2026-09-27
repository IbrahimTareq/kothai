import { test } from 'node:test'
import assert from 'node:assert/strict'
import { byPath, moveTargets, spaceLabel, spacePath } from '../../client/domain/spaceTree.ts'

// Travel > Asia > Japan, Travel > Portugal, and Reading on its own.
const spaces = [
  { id: 't', name: 'Travel' },
  { id: 'a', name: 'Asia', parentId: 't' },
  { id: 'j', name: 'Japan', parentId: 'a' },
  { id: 'p', name: 'Portugal', parentId: 't' },
  { id: 'r', name: 'Reading' },
]
const ids = (xs: { id: string }[]) => xs.map(x => x.id)

test('a space’s path runs from the top level down to it', () => {
  assert.deepEqual(ids(spacePath(spaces, 'j')), ['t', 'a', 'j'])
  assert.deepEqual(ids(spacePath(spaces, 'r')), ['r'])
})

test('a path ends at a parent the list no longer holds', () => {
  assert.deepEqual(
    ids(
      spacePath(
        spaces.filter(s => s.id !== 'a'),
        'j',
      ),
    ),
    ['j'],
  )
})

test('a space is named by its path', () => {
  assert.equal(spaceLabel(spaces, 'j'), 'Travel / Asia / Japan')
  assert.equal(spaceLabel(spaces, 'r'), 'Reading')
})

test('a space moves anywhere but itself, the spaces inside it, and where it already is', () => {
  assert.deepEqual(ids(moveTargets(spaces, 't')), ['r'])
  assert.deepEqual(ids(moveTargets(spaces, 'a')), ['p', 'r'])
})

// "Travel (old)" sorts between "Travel" and "Travel / Asia" as label text,
// which split Travel's family in the menus.
test('spaces sort under their parents, compared name by name down the path', () => {
  const mixed = [...spaces, { id: 'o', name: 'Travel (old)' }]
  assert.deepEqual(ids(byPath(mixed, mixed)), ['r', 't', 'a', 'j', 'p', 'o'])
})

test('two sub-spaces with one name keep their own sub-spaces beneath them', () => {
  const twins = [
    { id: 'i1', name: 'Ideas' },
    { id: 'i2', name: 'Ideas' },
    { id: 'z', name: 'Zines', parentId: 'i1' },
    { id: 'b', name: 'Books', parentId: 'i2' },
  ]
  const order = ids(byPath(twins, twins))
  assert.equal(order.indexOf('z'), order.indexOf('i1') + 1)
  assert.equal(order.indexOf('b'), order.indexOf('i2') + 1)
})
