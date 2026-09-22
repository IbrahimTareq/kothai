// One update in, one of three outcomes: bind, drop, or save.
//
// IO is injected rather than imported so the binding rule can be tested with
// no network and no database — it is the bot's entire access control and the
// one thing here that must not regress.
import type { TelegramUpdate } from './api.ts'

export interface IngestIO {
  saveCapture: (c: { text: string; image?: string | null }) => Promise<{ id: string }>
  sendMessage: (chatId: number, text: string) => Promise<void>
  fetchPhotoDataUrl: (fileId: string) => Promise<string | null>
  bind: (chatId: number | null) => void
}

export async function ingestUpdate(update: TelegramUpdate, boundChatId: number | null, io: IngestIO): Promise<void> {
  const message = update.message
  if (!message) return
  const chatId = message.chat.id

  // First contact claims the bot. Whoever sets the token is the person who
  // messages it first; there is no window in which a stranger can beat them to
  // it without already knowing a token that was generated seconds earlier.
  if (boundChatId === null) {
    io.bind(chatId)
    await io.sendMessage(chatId, 'Connected. Anything you send here is saved to Kothai.')
    return
  }

  // Anyone who learns the bot's username can message it. Dropped in silence:
  // a reply — even a refusal — confirms the bot is live to whoever is probing.
  if (chatId !== boundChatId) return

  const text = (message.text ?? message.caption ?? '').trim()
  // Telegram sends one entry per rendered size, ascending. The last is the
  // largest, which is the one worth captioning.
  const largest = message.photo?.[message.photo.length - 1]
  const image = largest ? await io.fetchPhotoDataUrl(largest.file_id) : null

  if (!text && !image) return

  await io.saveCapture({ text, image })
  await io.sendMessage(chatId, 'Saved.')
}
