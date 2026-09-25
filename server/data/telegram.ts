// Telegram capture config — the bot token and the chat it is bound to.
//
// Deliberately NOT in SQLite, for the reason credentials.ts gives: /api/backup
// is a VACUUM INTO over the whole database (server/routes/backup.ts), so a
// token in a table is copied into every backup the user downloads, and
// /api/export would carry it out a second way. This token reads every message
// sent to the bot, so neither is acceptable.
import { readFileSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../config.ts'

const FILE = 'telegram.json'

export interface TelegramConfig {
  botToken: string | null
  // From getMe when the token was saved, so Settings can name the bot and
  // link to its chat. null in a file written before it was recorded.
  botUsername: string | null
  boundChatId: number | null
  // The shared secret the owner pastes into the bot chat to claim it — shown
  // only on Kothai's own settings screen, since the bot's username is public
  // from the moment BotFather creates it and trust-on-first-message would let
  // whoever finds that username bind the bot before the owner does. Cleared
  // the moment a chat binds, so it cannot be replayed.
  pairingCode: string | null
}

// Missing, unreadable or malformed all read as "not configured" rather than
// throwing — the app serves notes perfectly well with no capture channel, so a
// corrupt file must never be the reason it fails to boot.
export function readTelegram(dir: string = DATA_DIR): TelegramConfig | null {
  try {
    const parsed: Record<string, unknown> = JSON.parse(readFileSync(path.join(dir, FILE), 'utf8'))
    const botToken = typeof parsed.botToken === 'string' && parsed.botToken ? parsed.botToken : null
    const botUsername = typeof parsed.botUsername === 'string' && parsed.botUsername ? parsed.botUsername : null
    const boundChatId = typeof parsed.boundChatId === 'number' ? parsed.boundChatId : null
    const pairingCode = typeof parsed.pairingCode === 'string' && parsed.pairingCode ? parsed.pairingCode : null
    // A chat id without a token cannot poll anything, so it is not a
    // configuration — reporting it as one would start a loop with no token.
    return botToken ? { botToken, botUsername, boundChatId, pairingCode } : null
  } catch {
    return null
  }
}

// Throws on failure, deliberately: a token that appears to save and is gone
// after the next restart is worse than an error the user can see now.
//
// Replaces the whole file rather than merging in the caller's partial input —
// a write carrying only botToken clears boundChatId, and vice versa. That is
// intentional, not an oversight to fix with a read-modify-write merge: the
// settings route saves a new token by clearing the binding, because a chat id
// bound to the previous bot has never spoken to this one. A merge would leave
// a stale binding pointing at a bot that hasn't heard from that chat.
export function writeTelegram(
  { botToken = null, botUsername = null, boundChatId = null, pairingCode = null }: Partial<TelegramConfig>,
  dir: string = DATA_DIR,
): TelegramConfig {
  const file = path.join(dir, FILE)
  writeFileSync(file, JSON.stringify({ botToken, botUsername, boundChatId, pairingCode }, null, 2), { mode: 0o600 })
  // writeFileSync's `mode` applies only when it creates the file, so an
  // existing permissive file would keep its old permissions without this.
  chmodSync(file, 0o600)
  return { botToken, botUsername, boundChatId, pairingCode }
}

export function clearTelegram(dir: string = DATA_DIR): void {
  try {
    unlinkSync(path.join(dir, FILE))
  } catch {
    /* already gone */
  }
}
