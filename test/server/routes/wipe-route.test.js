// Tests for server/routes/wipe.js — POST /api/wipe erases the user's CONTENT
// (notes, spaces, chats, tag vocab, uploaded images) while deliberately
// leaving model settings and residency alone, so the app stays configured and
// no multi-GB weights need re-downloading. This is the one irreversible
// destructive route in the app, so the confirmation token is enforced
// server-side too — a stray fetch() must not be able to wipe anything.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

const calls = []

const realStore = await import('../../../server/data/notes.js')
const realCollections = await import('../../../server/data/collections.js')
const realChats = await import('../../../server/data/chats.js')
const realTagVocab = await import('../../../server/data/tagvocab.js')
const realSettings = await import('../../../server/data/settings.js')

mock.module('../../../server/data/notes.js', {
  namedExports: {
    ...realStore,
    clearAll: async () => { calls.push('notes'); return 12 },
    // Mocked so the test never deletes anything in the real data/uploads dir.
    clearUploads: async () => { calls.push('uploads'); return 5 },
  },
})
mock.module('../../../server/data/collections.js', {
  namedExports: { ...realCollections, clearAll: async () => { calls.push('collections'); return 3 } },
})
mock.module('../../../server/data/chats.js', {
  namedExports: { ...realChats, clearAll: async () => { calls.push('chats'); return 2 } },
})
mock.module('../../../server/data/tagvocab.js', {
  namedExports: { ...realTagVocab, clearAll: async () => { calls.push('tagvocab'); return 40 } },
})
mock.module('../../../server/data/settings.js', {
  namedExports: { ...realSettings, clearAll: async () => { calls.push('settings'); return 1 } },
})

const { handleWipe, CONFIRM_TOKEN } = await import('../../../server/routes/wipe.js')

function fakeReq(body) {
  const r = Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))])
  return Object.assign(r, { method: 'POST', headers: {} })
}
function fakeRes() {
  return {
    statusCode: null, headers: null, body: null,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers },
    end(str) { this.body = str },
  }
}
async function wipe(body) {
  const res = fakeRes()
  await handleWipe(fakeReq(body), res)
  return { res, json: res.body ? JSON.parse(res.body) : null }
}

test('handleWipe clears notes, spaces, chats, and tag vocab, and reports the counts', async () => {
  calls.length = 0
  const { res, json } = await wipe({ confirm: CONFIRM_TOKEN })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(json.cleared, { notes: 12, collections: 3, chats: 2, tags: 40 })
  assert.ok(calls.includes('notes') && calls.includes('collections') && calls.includes('chats') && calls.includes('tagvocab'))
  assert.ok(calls.includes('uploads'), 'uploaded images must go too — they are only reachable from the notes just deleted')
})

test('handleWipe never touches model settings — the app stays configured after a wipe', async () => {
  calls.length = 0
  await wipe({ confirm: CONFIRM_TOKEN })
  assert.ok(!calls.includes('settings'), 'settings must survive a content wipe')
})

test('handleWipe refuses without the exact confirmation token, and clears nothing', async () => {
  for (const body of [{}, { confirm: '' }, { confirm: 'delete' }, { confirm: ' DELETE ' }, null, 'not json at all']) {
    calls.length = 0
    const { res, json } = await wipe(body)
    assert.ok(res.statusCode === 400, `expected 400 for ${JSON.stringify(body)}, got ${res.statusCode}`)
    assert.deepEqual(calls, [], `nothing may be cleared for ${JSON.stringify(body)}`)
    assert.ok(json.error)
  }
})
