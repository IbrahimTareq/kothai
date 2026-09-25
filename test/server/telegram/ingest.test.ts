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
  const saved: { url: string }[] = []
  const sent: { chatId: number; text: string }[] = []
  const bound: (number | null)[] = []
  const io: IngestIO = {
    saveCapture: async (c: { url: string }) => {
      saved.push(c)
      return { id: 'n1' }
    },
    sendMessage: async (chatId: number, text: string) => {
      sent.push({ chatId, text })
    },
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

// Settings' t.me link carries the code as the start payload, which Telegram
// delivers as "/start CODE" once the owner taps Start.
test('an unbound bot binds to a chat that sends /start with the pairing code', async () => {
  const d = deps()
  await ingestUpdate(msg(99, { text: '/start secret-code' }), { boundChatId: null, pairingCode: 'secret-code' }, d.io)
  assert.deepEqual(d.bound, [99])
  assert.equal(d.sent.length, 1)
})

test('attack: /start with a wrong code, or with none, binds nothing and gets no reply', async () => {
  for (const text of ['/start wrong-code', '/start', '/start ', '/startsecret-code']) {
    const d = deps()
    await ingestUpdate(msg(1234, { text }), { boundChatId: null, pairingCode: 'secret-code' }, d.io)
    assert.deepEqual(d.bound, [], `${JSON.stringify(text)} must not claim the bot`)
    assert.deepEqual(d.sent, [], `${JSON.stringify(text)} must get the same silence as a wrong code`)
  }
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

test('a link from the bound chat is saved and confirmed', async () => {
  const d = deps()
  await ingestUpdate(msg(99), { boundChatId: 99, pairingCode: null }, d.io)
  assert.deepEqual(d.saved, [{ url: 'https://example.com' }])
  assert.equal(d.sent[0].chatId, 99)
  assert.match(d.sent[0].text, /saved/i)
})

// Kothai saves links only. The bound chat is owed an honest refusal — silence
// reads to the owner as "not bound, or wrong code" (docs/telegram.md).
test('plain text from the bound chat is refused, with a reply that says so', async () => {
  const d = deps()
  await ingestUpdate(msg(99, { text: 'a thought' }), { boundChatId: 99, pairingCode: null }, d.io)
  assert.deepEqual(d.saved, [])
  assert.equal(d.sent.length, 1)
  assert.match(d.sent[0].text, /links only/i)
  assert.doesNotMatch(d.sent[0].text, /saved\./i)
})

test('a photo is not saved, even with a caption', async () => {
  const d = deps()
  const update = msg(99, { text: undefined, caption: 'the good bit', photo: [{ file_id: 'a' }] })
  await ingestUpdate(update, { boundChatId: 99, pairingCode: null }, d.io)
  assert.deepEqual(d.saved, [])
  assert.match(d.sent[0].text, /links only/i)
})

test('a link captioning an attachment is saved, and the reply says the attachment was dropped', async () => {
  const d = deps()
  const update = msg(99, { text: undefined, caption: 'https://example.com/a', photo: [{ file_id: 'a' }] })
  await ingestUpdate(update, { boundChatId: 99, pairingCode: null }, d.io)
  assert.deepEqual(d.saved, [{ url: 'https://example.com/a' }])
  assert.match(d.sent[0].text, /attachment was dropped/i)
})

test('an update carrying no text at all saves nothing', async () => {
  const d = deps()
  await ingestUpdate(
    { update_id: 1, message: { message_id: 1, chat: { id: 99 } } },
    { boundChatId: 99, pairingCode: null },
    d.io,
  )
  assert.deepEqual(d.saved, [])
})

test('an update with no message — e.g. a channel_post — binds nothing, sends nothing, saves nothing', async () => {
  const d = deps()
  await ingestUpdate({ update_id: 1 }, { boundChatId: null, pairingCode: 'secret-code' }, d.io)
  assert.deepEqual(d.bound, [])
  assert.deepEqual(d.sent, [])
  assert.deepEqual(d.saved, [])
})

// The replies above only ever go to the BOUND chat — it is already
// authenticated, so telling it the truth costs nothing. A stranger probing the
// unbound bot still gets total silence, because a reply of any kind — even
// "that isn't supported" — would confirm the bot is live.

test('an unsupported attachment with no caption: nothing is saved, and the reply explains why instead of pretending it worked', async () => {
  const d = deps()
  const update = msg(99, { text: undefined, video: { file_id: 'vid1' } })
  await ingestUpdate(update, { boundChatId: 99, pairingCode: null }, d.io)
  assert.deepEqual(d.saved, [])
  assert.equal(d.sent.length, 1)
  assert.match(d.sent[0].text, /links only/i)
  assert.doesNotMatch(d.sent[0].text, /saved\./i, 'nothing was saved — the reply must not claim otherwise')
})

test('the silence rule for an unbound/wrong chat is unchanged by the new replies — an unsupported attachment from a stranger still gets nothing back', async () => {
  const d = deps()
  const update = msg(1234, { text: undefined, document: { file_id: 'doc1' } })
  await ingestUpdate(update, { boundChatId: 99, pairingCode: null }, d.io)
  assert.deepEqual(d.saved, [])
  assert.deepEqual(d.sent, [], 'the new honest replies must never leak to a chat that is not the bound one')
  assert.deepEqual(d.bound, [])
})
