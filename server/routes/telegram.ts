// Connect/disconnect the Telegram capture bot from Settings — see
// server/data/telegram.ts for the config shape and server/telegram/ingest.ts
// for the pairing rule this route's pairing code feeds.
import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readTelegram, writeTelegram, clearTelegram, type TelegramConfig } from '../data/telegram.ts'
import { isCaptureStopped, startTelegramCapture } from '../telegram/index.ts'
import { getMe } from '../telegram/api.ts'
import { json, readBody } from '../lib/http.ts'

// No I/O/0/1 — a code shown on a settings screen has to survive being read
// off the screen and typed into a phone's chat keyboard without ambiguity.
const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const PAIRING_LENGTH = 6

// 256 (a byte's range) is an exact multiple of 32 (the alphabet size), so
// `byte % 32` lands on every symbol equally often — no modulo bias to correct.
function generatePairingCode(): string {
  const bytes = randomBytes(PAIRING_LENGTH)
  let code = ''
  for (const b of bytes) code += PAIRING_ALPHABET[b % PAIRING_ALPHABET.length]
  return code
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function stateOf(config: TelegramConfig | null) {
  // A 409 (another poller already consuming this bot's updates) stops the
  // loop for the rest of the process's life — see poll.ts. Folding that in
  // here is what keeps Settings from saying "Connected — saving to your
  // chat" indefinitely after capture has actually died.
  return {
    connected: Boolean(config?.botToken) && !isCaptureStopped(),
    botUsername: config?.botUsername ?? null,
    boundChatId: config?.boundChatId ?? null,
    pairingCode: config?.pairingCode ?? null,
  }
}

// The bot token is NEVER echoed back — a settings screen that returns a
// credential puts it in every screenshot, browser cache and support thread
// built from a copy-pasted response body.
export function handleGetTelegram(res: ServerResponse): void {
  json(res, 200, stateOf(readTelegram()))
}

export async function handleSaveTelegram(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req)
  const fields = isRecord(body) ? body : {}
  const botToken = typeof fields.botToken === 'string' ? fields.botToken.trim() : ''
  if (!botToken) return json(res, 400, { error: 'a bot token is required' })
  const me = await getMe(botToken)
  if (!me.ok) return json(res, 400, { error: me.error })
  // A different bot has never spoken to anyone, so carrying a binding forward
  // would point at a chat that has never messaged it — the binding resets and
  // a fresh pairing code is issued for the owner to claim it with.
  const config = writeTelegram({
    botToken,
    botUsername: me.username,
    boundChatId: null,
    pairingCode: generatePairingCode(),
  })
  startTelegramCapture()
  json(res, 200, stateOf(config))
}

export function handleClearTelegram(res: ServerResponse): void {
  clearTelegram()
  // Stops the running loop, which holds its own copy of the token: clearing
  // the file alone left the bot saving until the next restart.
  startTelegramCapture()
  json(res, 200, stateOf(null))
}
