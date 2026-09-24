// legacy-notes.ts brings rows older versions of Kothai wrote up to the current
// shape as the store loads them. Each test writes one such row straight into
// the table and reads it back through load(), the only path that upgrades it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as store from '../../../server/data/notes.ts'
import { getDb } from '../../../server/data/db.ts'

async function loadRow(data: object) {
  store._reset({ loaded: false })
  const db = await getDb()
  db.prepare('INSERT INTO notes (id, data) VALUES (?, ?)').run('old', JSON.stringify({ id: 'old', ...data }))
  await store.load()
  return store.getNote('old')
}

// ---- account from the title ----------------------------------------------
// Notes imported before `account` was a first-class field carry the poster
// only inside the title deriveNote wrote.

test('a legacy import title yields its account', async () => {
  assert.equal((await loadRow({ type: 'video', title: '@chefsteps · Reel' }))?.account, 'chefsteps')
  assert.equal((await loadRow({ type: 'link', title: '@natgeo · Post' }))?.account, 'natgeo')
})

test('a title not in the exact import shape yields no account', async () => {
  for (const title of ['Untitled', '@partial · ', '', null]) {
    assert.equal((await loadRow({ type: 'link', title }))?.account, null, `title ${JSON.stringify(title)}`)
  }
})
