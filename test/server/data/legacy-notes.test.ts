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

// ---- types retired by links-only -------------------------------------------
// Notes saved before Kothai kept links only (4c6d41f) can carry a type no card
// renders: the old classifier answered "image" for Instagram reels and posts,
// and "text" for articles it judged to be prose. Each one reached the board as
// an empty zero-height card — seven of the first seventeen in one space.

test('a legacy "image" note loads with the type a fresh save of its URL gets', async () => {
  const url = 'https://www.instagram.com/reel/DbEewfgTeDk/'
  const note = await loadRow({ type: 'image', url, content: url, title: 'Kaaba at dawn' })
  assert.equal(note?.type, 'link')
})

test('a legacy "text" note with a video URL loads as a video', async () => {
  const url = 'https://www.youtube.com/watch?v=abc'
  const note = await loadRow({ type: 'text', url, content: url })
  assert.equal(note?.type, 'video')
})

test('a legacy note with no URL falls back to its content', async () => {
  const note = await loadRow({ type: 'text', url: null, content: 'This is a note about myself' })
  assert.equal(note?.type, 'link')
})

test('a current type is left as it is', async () => {
  // An Instagram reel the importer typed as a video; the URL heuristic alone
  // would call it a link, so re-deriving every type would demote it.
  const url = 'https://www.instagram.com/reel/DbEewfgTeDk/'
  const note = await loadRow({ type: 'video', url, content: url })
  assert.equal(note?.type, 'video')
})
