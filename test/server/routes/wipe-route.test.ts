// Tests for server/routes/wipe.ts — POST /api/wipe erases the user's CONTENT
// (notes, spaces, chats, tag vocab, uploaded images) while deliberately
// leaving model settings and residency alone, so the app stays configured and
// no multi-GB weights need re-downloading. This is the one irreversible
// destructive route in the app, so the confirmation token is enforced
// server-side too — a stray fetch() must not be able to wipe anything.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mockReq, mockRes } from '../../helpers/http.ts'

const calls: string[] = []

const realStore = await import('../../../server/data/notes.ts')
const realCollections = await import('../../../server/data/collections.ts')
const realChats = await import('../../../server/data/chats.ts')
const realTagVocab = await import('../../../server/data/tagvocab.ts')
const realSettings = await import('../../../server/data/settings.ts')

mock.module('../../../server/data/notes.ts', {
  namedExports: {
    ...realStore,
    clearAll: async () => {
      calls.push('notes')
      return 12
    },
    // Mocked so the test never deletes anything in the real data/uploads dir.
    clearUploads: async () => {
      calls.push('uploads')
      return 5
    },
  },
})
mock.module('../../../server/data/collections.ts', {
  namedExports: {
    ...realCollections,
    clearAll: async () => {
      calls.push('collections')
      return 3
    },
  },
})
mock.module('../../../server/data/chats.ts', {
  namedExports: {
    ...realChats,
    clearAll: async () => {
      calls.push('chats')
      return 2
    },
  },
})
mock.module('../../../server/data/tagvocab.ts', {
  namedExports: {
    ...realTagVocab,
    clearAll: async () => {
      calls.push('tagvocab')
      return 40
    },
  },
})
mock.module('../../../server/data/settings.ts', {
  namedExports: {
    ...realSettings,
    clearAll: async () => {
      calls.push('settings')
      return 1
    },
  },
})

const { handleWipe, CONFIRM_TOKEN } = await import('../../../server/routes/wipe.ts')

// `body` is unknown rather than a shape: the refusal test deliberately posts
// null and a non-JSON string, which is half of what it is checking.
async function wipe(body: unknown) {
  const { res, sent } = mockRes()
  const raw = typeof body === 'string' ? body : JSON.stringify(body)
  await handleWipe(mockReq({ method: 'POST', url: '/api/wipe', body: raw }), res)
  return sent
}

test('handleWipe clears notes, spaces, chats, and tag vocab, and reports the counts', async () => {
  calls.length = 0
  const sent = await wipe({ confirm: CONFIRM_TOKEN })
  assert.equal(sent.code, 200)
  assert.deepEqual(sent.json().cleared, { notes: 12, collections: 3, chats: 2, tags: 40 })
  assert.ok(
    calls.includes('notes') && calls.includes('collections') && calls.includes('chats') && calls.includes('tagvocab'),
  )
  assert.ok(
    calls.includes('uploads'),
    'uploaded images must go too — they are only reachable from the notes just deleted',
  )
})

test('handleWipe never touches model settings — the app stays configured after a wipe', async () => {
  calls.length = 0
  await wipe({ confirm: CONFIRM_TOKEN })
  assert.ok(!calls.includes('settings'), 'settings must survive a content wipe')
})

test('handleWipe refuses without the exact confirmation token, and clears nothing', async () => {
  for (const body of [{}, { confirm: '' }, { confirm: 'delete' }, { confirm: ' DELETE ' }, null, 'not json at all']) {
    calls.length = 0
    const sent = await wipe(body)
    assert.ok(sent.code === 400, `expected 400 for ${JSON.stringify(body)}, got ${sent.code}`)
    assert.deepEqual(calls, [], `nothing may be cleared for ${JSON.stringify(body)}`)
    assert.ok(sent.json().error)
  }
})
