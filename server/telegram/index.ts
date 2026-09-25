// Assembles the pieces and owns the mutable state: the running loop, and the
// bound chat id, which is read when the loop starts and written the first time
// the owner pairs.
import { readTelegram, writeTelegram } from '../data/telegram.ts'
import { saveCapture } from '../capture.ts'
import { getUpdates, sendMessage } from './api.ts'
import { ingestUpdate } from './ingest.ts'
import { pollOnce, startPolling } from './poll.ts'

// Read by GET /api/telegram (routes/telegram.ts) so Settings can stop
// claiming "Connected — saving to your chat" once a 409 has permanently
// stopped the loop (see poll.ts's conflict handling) — without this, the only
// evidence the owner has that capture died is one log line in the container.
let stopped = false
let stopLoop: (() => void) | null = null

export function isCaptureStopped(): boolean {
  return stopped
}

// (Re)starts capture from whatever is on disk, stopping any loop already
// running first. Called at boot and by routes/telegram.ts after every save or
// clear. Capture used to start only at boot, so connecting a bot meant a
// container restart before it answered — and disconnecting left the old loop
// saving from its own copy of the token until one.
export function startTelegramCapture(): boolean {
  stopLoop?.()
  stopLoop = null
  stopped = false
  const config = readTelegram()
  if (!config?.botToken) return false
  const token = config.botToken
  const botUsername = config.botUsername
  let bound = config.boundChatId
  // Read once and never refreshed — unlike `bound`, this one doesn't need it.
  // ingestUpdate only ever looks at pairingCode while boundChatId is null,
  // and `bind` below is the only thing that sets `bound`, permanently, for
  // the rest of this process's life. So the instant a chat binds, the copy
  // on disk goes stale (bind's writeTelegram call clears it) but this one
  // is never consulted again — there is no code path left where a second
  // chat replaying the old code could still bind.
  const pairingCode = config.pairingCode
  let offset = 0

  stopLoop = startPolling(async (giveUp, signal) => {
    const result = await pollOnce({
      offset,
      getUpdates: at => getUpdates(token, at, 30, signal),
      giveUp,
      handle: update =>
        ingestUpdate(
          update,
          { boundChatId: bound, pairingCode },
          {
            saveCapture,
            sendMessage: (chatId, text) => sendMessage(token, chatId, text),
            bind: chatId => {
              // Write before touching `bound`: if this throws (read-only volume,
              // full disk), `bound` must stay null so the redelivered pairing
              // message still takes the bind path above next pass, instead of
              // `ingestUpdate` treating the chat as already bound and saving the
              // still-live pairing code as note content — see IngestIO.bind's
              // comment in ingest.ts.
              writeTelegram({ botToken: token, botUsername, boundChatId: chatId, pairingCode: null })
              // Clearing the pairing code is what stops it being replayed — see
              // the binding rule in ingest.ts.
              bound = chatId
            },
          },
        ),
    })
    offset = result.offset
    if (result.conflict) stopped = true
    return result
  })
  return true
}
