// Remote model names persist in their own columns, independent of the local
// selection, so switching provider back and forth never leaves one side's
// value in the other side's column.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { _resetDb } from '../../../server/data/db.js'
import * as settings from '../../../server/data/settings.js'

beforeEach(async () => {
  _resetDb()
  settings._reset()
  await settings.load()
})

test('remote model names default to empty strings', () => {
  assert.deepEqual(settings.getRemote(), { llm: '', embed: '', vision: '' })
})

test('saving remote names round-trips through the database', async () => {
  await settings.save({ remote: { llm: 'gpt-4o-mini', embed: 'text-embedding-3-small' } })
  assert.deepEqual(settings.getRemote(), { llm: 'gpt-4o-mini', embed: 'text-embedding-3-small', vision: '' })
})

test('saving remote names leaves the local selection untouched', async () => {
  const before = settings.get()
  await settings.save({ remote: { llm: 'gpt-4o-mini' } })
  assert.deepEqual(settings.get(), before)
})

test('a partial remote patch only changes the roles it names', async () => {
  await settings.save({ remote: { llm: 'a', embed: 'b', vision: 'c' } })
  await settings.save({ remote: { embed: 'b2' } })
  assert.deepEqual(settings.getRemote(), { llm: 'a', embed: 'b2', vision: 'c' })
})

test('an empty string clears a role rather than being ignored', async () => {
  await settings.save({ remote: { llm: 'a' } })
  await settings.save({ remote: { llm: '' } })
  assert.equal(settings.getRemote().llm, '')
})
