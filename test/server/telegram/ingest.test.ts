// The bot is reachable by anyone who learns its username, so the binding rule
// is the whole of its access control: one chat saves, every other chat is
// dropped WITHOUT a reply. A reply would confirm the bot exists to whoever is
// probing it. Binding itself takes a pairing code shown only on Kothai's
// settings screen — trust-on-first-message is not safe, since the username is
// public from the moment the bot is created and a stranger could otherwise
// claim it before the owner's first message.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ingestUpdate } from '../../../server/telegram/ingest.ts'
import type { IngestIO } from '../../../server/telegram/ingest.ts'
import type { TelegramUpdate } from '../../../server/telegram/api.ts'

const msg = (chatId: number, over: Record<string, unknown> = {}): TelegramUpdate => ({
  update_id: 1,
  message: { message_id: 1, chat: { id: chatId }, text: 'https://example.com', ...over },
})

function deps() {
  const saved: { text: string; image?: string | null }[] = []
  const sent: { chatId: number; text: string }[] = []
  const bound: (number | null)[] = []
  const io: IngestIO = {
    saveCapture: async (c: { text: string; image?: string | null }) => {
      saved.push(c)
      return { id: 'n1' }
    },
    sendMessage: async (chatId: number, text: string) => {
      sent.push({ chatId, text })
    },
    fetchPhotoDataUrl: async () => 'data:image/jpeg;base64,AAAA',
    bind: (chatId: number | null) => bound.push(chatId),
  }
  return { saved, sent, bound, io }
}

test('an unbound bot binds to the first chat that sends the correct pairing code and confirms', async () => {
  const d = deps()
  await ingestUpdate(msg(99, { text: 'secret-code' }), { boundChatId: null, pairingCode: 'secret-code' }, d.io)
  assert.deepEqual(d.bound, [99])
  assert.equal(d.sent.length, 1)
  assert.equal(d.saved.length, 0, 'the binding message is a handshake, not a capture')
})

test('attack: an unbound bot ignores a first message that is not the pairing code — trust-on-first-use would let a stranger who finds the username claim the bot before the owner', async () => {
  const d = deps()
  await ingestUpdate(msg(1234, { text: 'hello there' }), { boundChatId: null, pairingCode: 'secret-code' }, d.io)
  assert.deepEqual(d.bound, [], 'a guess must not claim the bot')
  assert.deepEqual(d.sent, [], 'a reply would confirm the bot exists to whoever is guessing')
})

test('an unbound bot with no pairing code set cannot be claimed by anyone', async () => {
  const d = deps()
  await ingestUpdate(msg(99, { text: 'anything' }), { boundChatId: null, pairingCode: null }, d.io)
  assert.deepEqual(d.bound, [])
  assert.deepEqual(d.sent, [])
})

test('a message from any other chat is dropped silently — no save, no reply', async () => {
  const d = deps()
  await ingestUpdate(msg(1234), { boundChatId: 99, pairingCode: null }, d.io)
  assert.deepEqual(d.saved, [])
  assert.deepEqual(d.sent, [], 'replying confirms the bot exists to whoever is probing')
  assert.deepEqual(d.bound, [])
})

test('a text message from the bound chat is saved and confirmed', async () => {
  const d = deps()
  await ingestUpdate(msg(99), { boundChatId: 99, pairingCode: null }, d.io)
  assert.equal(d.saved[0].text, 'https://example.com')
  assert.equal(d.sent[0].chatId, 99)
})

test('a photo is downloaded at its largest size and saved as an image', async () => {
  const d = deps()
  const update = msg(99, {
    text: undefined,
    photo: [
      { file_id: 'small', file_size: 100 },
      { file_id: 'large', file_size: 9000 },
    ],
  })
  await ingestUpdate(update, { boundChatId: 99, pairingCode: null }, d.io)
  assert.match(d.saved[0].image ?? '', /^data:image\/jpeg/)
})

test("a photo's caption becomes the note text", async () => {
  const d = deps()
  const update = msg(99, { text: undefined, caption: 'the good bit', photo: [{ file_id: 'a' }] })
  await ingestUpdate(update, { boundChatId: 99, pairingCode: null }, d.io)
  assert.equal(d.saved[0].text, 'the good bit')
})

test('an update carrying neither text nor a photo saves nothing', async () => {
  const d = deps()
  await ingestUpdate(
    { update_id: 1, message: { message_id: 1, chat: { id: 99 } } },
    { boundChatId: 99, pairingCode: null },
    d.io,
  )
  assert.deepEqual(d.saved, [])
})

test('a failed photo download still saves the caption as text, rather than dropping the message', async () => {
  const d = deps()
  d.io.fetchPhotoDataUrl = async () => null
  const update = msg(99, { text: undefined, caption: 'the good bit', photo: [{ file_id: 'a' }] })
  await ingestUpdate(update, { boundChatId: 99, pairingCode: null }, d.io)
  assert.equal(d.saved.length, 1, 'losing the image must not lose the message')
  assert.equal(d.saved[0].text, 'the good bit')
  assert.equal(d.saved[0].image, null)
})

test('an update with no message — e.g. a channel_post — binds nothing, sends nothing, saves nothing', async () => {
  const d = deps()
  await ingestUpdate({ update_id: 1 }, { boundChatId: null, pairingCode: 'secret-code' }, d.io)
  assert.deepEqual(d.bound, [])
  assert.deepEqual(d.sent, [])
  assert.deepEqual(d.saved, [])
})

// droppedAttachmentReply's four cases below only ever fire for the BOUND
// chat — it is already authenticated, so telling it the truth costs nothing.
// A stranger probing the unbound bot still gets total silence (pinned last),
// because a reply of any kind — even "that file type isn't supported" —
// would confirm the bot is live.

test('an unsupported attachment with a caption: the caption is saved, and the reply says other files are dropped', async () => {
  const d = deps()
  const update = msg(99, { text: undefined, caption: 'read this later', document: { file_id: 'doc1' } })
  await ingestUpdate(update, { boundChatId: 99, pairingCode: null }, d.io)
  assert.equal(d.saved.length, 1, 'the caption is text — there is no reason to lose it')
  assert.equal(d.saved[0].text, 'read this later')
  assert.equal(d.saved[0].image, null)
  assert.equal(d.sent.length, 1)
  assert.equal(d.sent[0].chatId, 99)
  assert.match(d.sent[0].text, /only links, text and photos are supported/i)
  assert.match(d.sent[0].text, /saved the caption/i)
})

test('an unsupported attachment with no caption: nothing is saved, and the reply explains why instead of pretending it worked', async () => {
  const d = deps()
  const update = msg(99, { text: undefined, video: { file_id: 'vid1' } })
  await ingestUpdate(update, { boundChatId: 99, pairingCode: null }, d.io)
  assert.deepEqual(d.saved, [], 'nothing here is text, a caption or a photo')
  assert.equal(d.sent.length, 1)
  assert.equal(d.sent[0].chatId, 99)
  assert.match(d.sent[0].text, /only links, text and photos are supported/i)
  assert.doesNotMatch(d.sent[0].text, /saved/i, 'nothing was saved — the reply must not claim otherwise')
})

test('a photo download failure with a caption: the caption is saved, and the reply says the photo specifically failed', async () => {
  const d = deps()
  d.io.fetchPhotoDataUrl = async () => null
  const update = msg(99, { text: undefined, caption: 'the good bit', photo: [{ file_id: 'a' }] })
  await ingestUpdate(update, { boundChatId: 99, pairingCode: null }, d.io)
  assert.equal(d.saved.length, 1)
  assert.equal(d.saved[0].text, 'the good bit')
  assert.equal(d.sent.length, 1)
  assert.match(d.sent[0].text, /photo failed to download/i)
})

test('the silence rule for an unbound/wrong chat is unchanged by the new replies — an unsupported attachment from a stranger still gets nothing back', async () => {
  const d = deps()
  const update = msg(1234, { text: undefined, document: { file_id: 'doc1' } })
  await ingestUpdate(update, { boundChatId: 99, pairingCode: null }, d.io)
  assert.deepEqual(d.saved, [])
  assert.deepEqual(d.sent, [], 'the new honest replies must never leak to a chat that is not the bound one')
  assert.deepEqual(d.bound, [])
})
