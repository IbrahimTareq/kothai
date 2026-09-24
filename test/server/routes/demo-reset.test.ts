// The demo resets every night (and at boot): every visitor's links and chats
// go, the shared library stays, and every allowance starts again.
//
// The data dir is a temp one, set before the dynamic imports because
// server/config.ts freezes it at import time: the reset deletes upload files,
// and it must never be pointed at a real library's.
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.KOTHAI_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'kothai-demo-reset-'))
const { UPLOAD_DIR } = await import('../../../server/config.ts')
const store = await import('../../../server/data/notes.ts')
const chats = await import('../../../server/data/chats.ts')
const collections = await import('../../../server/data/collections.ts')
const { demoLimits, resetDemo } = await import('../../../server/routes/demo.ts')

import test from 'node:test'
import assert from 'node:assert/strict'

test('the reset removes every visitor’s links, files and chats, and keeps the library', async () => {
  store._reset()
  chats._reset()
  collections._reset()
  mkdirSync(UPLOAD_DIR, { recursive: true })
  const thumb = path.join(UPLOAD_DIR, 'visitor-thumb.jpg')
  writeFileSync(thumb, 'x')

  const seed = await store.addNote({ type: 'link', content: 'seed' })
  const theirs = await store.addNote({
    type: 'link',
    url: 'https://example.com',
    thumb: '/uploads/visitor-thumb.jpg',
    visitor: 'a',
  })
  const space = await collections.create({ name: 'Reading' })
  await collections.addItems(space.id, [seed.id, theirs.id])
  await chats.appendExchange(null, { role: 'user', text: 'shared' }, { role: 'ai', text: 'x' })
  await chats.appendExchange(null, { role: 'user', text: 'theirs' }, { role: 'ai', text: 'x' }, 'a')

  await resetDemo()

  assert.deepEqual(
    store.allNotes().map(n => n.id),
    [seed.id],
  )
  assert.deepEqual(collections.all()[0].itemIds, [seed.id], 'the space must not keep a dangling id')
  assert.equal(existsSync(thumb), false, 'a visitor’s files must not pile up on disk night after night')
  assert.deepEqual(
    chats.all().map(c => c.messages[0].text),
    ['shared'],
  )
})

test('the reset gives every visitor their allowance back', async () => {
  demoLimits.save.reset()
  for (let i = 0; i < 5; i++) demoLimits.save.take('a')
  assert.equal(demoLimits.save.take('a'), false)
  await resetDemo()
  assert.equal(demoLimits.save.take('a'), true)
})
