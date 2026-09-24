import { test } from 'node:test'
import assert from 'node:assert/strict'
import { relTime } from '../../client/util/format.ts'

// A link saved after the page loaded read "scheduled" until a reload: `now`
// was taken once at import, so the new card's timestamp sat in its future.
test('relTime reads a note saved after the page loaded as just now', () => {
  assert.equal(relTime(Date.now() + 5), 'just now')
})

test('relTime reads a server clock slightly ahead of this one as just now', () => {
  assert.equal(relTime(Date.now() + 20_000), 'just now')
})

test('relTime still counts back from the present', () => {
  assert.equal(relTime(Date.now() - 5 * 60_000), '5m ago')
})
