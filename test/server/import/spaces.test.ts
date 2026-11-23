// fileIntoSpaces owns the Space-filing block the import route used to carry.
// Tested directly rather than through the route: the route tests register
// only the real importers, and a mock.module of the importer registry is
// per test file, so a test-only importer would replace the real ones for
// every other test in import-route.test.ts.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

// Fake collections store mirroring server/data/collections.ts: create()
// UNSHIFTS (all() is newest-first) and starts with itemIds/removedIds [],
// addItems() has attach() semantics. collections.ts leaves its Collection
// interface unexported, so the fields the filing code reads are spelled here.
interface Space {
  id: string
  name: string
  tags: string[]
  itemIds: string[]
  removedIds: string[]
}
let spaces: Space[] = []
let nextId = 1

const realCollections = await import('../../../server/data/collections.ts')
mock.module('../../../server/data/collections.ts', {
  namedExports: {
    ...realCollections,
    all: () => spaces.map(s => ({ ...s })),
    create: async ({ name, tags = [] }: { name: string; tags?: string[] }) => {
      const s: Space = { id: `space-${nextId++}`, name, tags, itemIds: [], removedIds: [] }
      spaces.unshift(s)
      return { ...s }
    },
    addItems: async (id: string, itemIds: string[]) => {
      const s = spaces.find(x => x.id === id)
      if (!s) return null
      for (const itemId of itemIds) {
        if (!s.itemIds.includes(itemId)) s.itemIds.unshift(itemId)
        s.removedIds = s.removedIds.filter(x => x !== itemId)
      }
      return { ...s }
    },
  },
})

const { canonicalUrl } = await import('../../../server/links/canonical.ts')
const { fileIntoSpaces } = await import('../../../server/import/spaces.ts')

const URL_ = 'https://example.com/a'
// urlIndex is keyed by canonical url, as the route builds it.
const urlIndex = new Map([[canonicalUrl(URL_) as string, 'note-1']])

test('a name collision with a smart Space mirrors into "<name> (<label>)"', async () => {
  spaces = [{ id: 'smart-1', name: 'Recipes', tags: ['cooking'], itemIds: ['hand'], removedIds: [] }]
  nextId = 1
  const result = await fileIntoSpaces([{ name: 'Recipes', urls: [URL_] }], urlIndex, 'Raindrop')
  assert.deepEqual(result, { touched: 1, unresolved: 0 })
  const mirror = spaces.find(s => s.name === 'Recipes (Raindrop)')
  assert.ok(mirror, 'the mirror Space should name the importing platform')
  assert.deepEqual(mirror.itemIds, ['note-1'])
  assert.deepEqual(spaces.find(s => s.id === 'smart-1')?.itemIds, ['hand'], 'the smart Space is untouched')
})

test('members whose notes do not exist are counted as unresolved', async () => {
  spaces = []
  nextId = 1
  const result = await fileIntoSpaces(
    [{ name: 'Misc', urls: [URL_, 'https://example.com/missing'] }],
    urlIndex,
    'Raindrop',
  )
  assert.deepEqual(result, { touched: 1, unresolved: 1 })
})
