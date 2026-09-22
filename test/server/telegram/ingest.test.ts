// The bot is reachable by anyone who learns its username, so the binding rule
// is the whole of its access control: one chat saves, every other chat is
// dropped WITHOUT a reply. A reply would confirm the bot exists to whoever is
// probing it.
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
  return {
    saved,
    sent,
    bound,
    io: {
      saveCapture: async (c: { text: string; image?: string | null }) => {
        saved.push(c)
        return { id: 'n1' }
      },
      sendMessage: async (chatId: number, text: string) => {
        sent.push({ chatId, text })
      },
      fetchPhotoDataUrl: async () => 'data:image/jpeg;base64,AAAA',
      bind: (chatId: number | null) => bound.push(chatId),
    } as IngestIO,
  }
}

test('an unbound bot binds to the first chat that messages it and confirms', async () => {
  const d = deps()
  await ingestUpdate(msg(99), null, d.io)
  assert.deepEqual(d.bound, [99])
  assert.equal(d.sent.length, 1)
  assert.equal(d.saved.length, 0, 'the binding message is a handshake, not a capture')
})

test('a message from any other chat is dropped silently — no save, no reply', async () => {
  const d = deps()
  await ingestUpdate(msg(1234), 99, d.io)
  assert.deepEqual(d.saved, [])
  assert.deepEqual(d.sent, [], 'replying confirms the bot exists to whoever is probing')
  assert.deepEqual(d.bound, [])
})

test('a text message from the bound chat is saved and confirmed', async () => {
  const d = deps()
  await ingestUpdate(msg(99), 99, d.io)
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
  await ingestUpdate(update, 99, d.io)
  assert.match(d.saved[0].image ?? '', /^data:image\/jpeg/)
})

test("a photo's caption becomes the note text", async () => {
  const d = deps()
  const update = msg(99, { text: undefined, caption: 'the good bit', photo: [{ file_id: 'a' }] })
  await ingestUpdate(update, 99, d.io)
  assert.equal(d.saved[0].text, 'the good bit')
})

test('an update carrying neither text nor a photo saves nothing', async () => {
  const d = deps()
  await ingestUpdate({ update_id: 1, message: { message_id: 1, chat: { id: 99 } } }, 99, d.io)
  assert.deepEqual(d.saved, [])
})

test('a failed photo download still saves the caption as text, rather than dropping the message', async () => {
  const d = deps()
  d.io.fetchPhotoDataUrl = async () => null
  const update = msg(99, { text: undefined, caption: 'the good bit', photo: [{ file_id: 'a' }] })
  await ingestUpdate(update, 99, d.io)
  assert.equal(d.saved.length, 1, 'losing the image must not lose the message')
  assert.equal(d.saved[0].text, 'the good bit')
  assert.equal(d.saved[0].image, null)
})
