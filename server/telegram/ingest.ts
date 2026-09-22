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
  // Also clears the persisted pairing code, so a code cannot be replayed to
  // bind a second chat once the first has claimed it. Not obvious from the
  // name alone — callers implementing this must do both writes.
  //
  // If this throws (disk full, bad permissions) it propagates out of
  // ingestUpdate before sendMessage runs, and Task 5's poll loop will not
  // advance past this update — so the same bind attempt retries forever
  // instead of silently losing the pairing message. Acceptable: a bind that
  // cannot be persisted is not something to paper over with a "connected"
  // reply that turns out to be a lie.
  bind: (chatId: number | null) => void
}

export async function ingestUpdate(
  update: TelegramUpdate,
  state: { boundChatId: number | null; pairingCode: string | null },
  io: IngestIO,
): Promise<void> {
  const message = update.message
  if (!message) return
  const chatId = message.chat.id
  const text = (message.text ?? message.caption ?? '').trim()

  // Trust-on-first-use is not safe here. A bot's username is public from the
  // moment BotFather creates it, and the gap between creating the bot and the
  // owner's first message can be hours — so a stranger who finds the username
  // could claim the bot, gain write access to the archive, and lock the owner
  // out. Silently, because the drop rule below denies them an error too. So
  // binding takes a code only the owner can see, shown in Kothai's settings.
  //
  // A wrong code is dropped in silence for the same reason a wrong chat is:
  // an error would confirm the bot is live to whoever is guessing.
  if (state.boundChatId === null) {
    if (!state.pairingCode || text !== state.pairingCode) return
    io.bind(chatId)
    await io.sendMessage(chatId, 'Connected. Anything you send here is saved to Kothai.')
    return
  }

  // Anyone who learns the bot's username can message it. Dropped in silence:
  // a reply — even a refusal — confirms the bot is live to whoever is probing.
  if (chatId !== state.boundChatId) return

  // Telegram sends one entry per rendered size, ascending. The last is the
  // largest, which is the one worth captioning.
  const largest = message.photo?.[message.photo.length - 1]
  const image = largest ? await io.fetchPhotoDataUrl(largest.file_id) : null

  if (!text && !image) return

  await io.saveCapture({ text, image })
  await io.sendMessage(chatId, 'Saved.')
}
