// The wiring contract: startTelegramCapture must not start the poll loop when
// there is nothing to poll with, and must start it the moment a token exists.
// The pieces it assembles (poll.ts, ingest.ts, api.ts) are tested on their own
// — except for the closure startTelegramCapture builds around them, which is
// this bot's entire access control (see index.ts's `bind`) and was, until the
// tests below, never actually exercised: the old pollOnce stub here returned
// a fixed result without ever calling `handle`, so the `run` callback passed
// to startPolling was captured but never invoked.
//
// Mocks are installed before the subject is imported — mock.module only
// affects modules resolved after it runs.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import type { TelegramUpdate } from '../../../server/telegram/api.ts'

type PollResult = { offset: number; conflict: boolean; failed: boolean }
type Config = {
  botToken: string | null
  botUsername: string | null
  boundChatId: number | null
  pairingCode: string | null
}

let telegramConfig: Config | null = null
let pollStarted = 0
let pollStopped = 0
let capturedRun: ((giveUp: boolean) => Promise<PollResult>) | null = null

const writes: Config[] = []
let throwOnWrite = false

mock.module('../../../server/data/telegram.ts', {
  namedExports: {
    readTelegram: () => telegramConfig,
    // Records exactly what index.ts's `bind` passed in, with no defaulting of
    // its own — the real writeTelegram defaults a missing pairingCode to
    // null, which would quietly launder a call site that forgot to clear it.
    // Recording the raw call is what lets a test assert on the literal
    // property rather than on a value production's own defaulting supplies.
    writeTelegram: (cfg: Partial<Config>) => {
      if (throwOnWrite) throw new Error('disk full')
      writes.push({ ...cfg } as Config)
      return cfg as Config
    },
  },
})

// pollOnce here is a deliberately minimal stand-in, not a copy of poll.ts's
// real retry/backoff logic (that's covered by poll.test.ts): it exists only
// to feed `handle` — the closure startTelegramCapture builds — a scripted
// batch of updates, serially and awaited, so a bind that happens partway
// through a batch is visible to the update processed right after it, the
// same way it would be inside the real pollOnce's loop.
let nextUpdates: TelegramUpdate[] = []
mock.module('../../../server/telegram/poll.ts', {
  namedExports: {
    pollOnce: async ({ handle }: { handle: (u: TelegramUpdate) => Promise<void> }): Promise<PollResult> => {
      for (const u of nextUpdates) {
        try {
          await handle(u)
        } catch {
          return { offset: u.update_id, conflict: false, failed: true }
        }
      }
      return { offset: 0, conflict: false, failed: false }
    },
    startPolling: (run: (giveUp: boolean) => Promise<PollResult>) => {
      pollStarted++
      capturedRun = run
      return () => {
        pollStopped++
      }
    },
  },
})

const sent: { chatId: number; text: string }[] = []
mock.module('../../../server/telegram/api.ts', {
  namedExports: {
    getUpdates: async () => ({ ok: true, updates: [] }),
    sendMessage: async (_token: string, chatId: number, text: string) => {
      sent.push({ chatId, text })
    },
    fetchPhotoDataUrl: async () => null,
  },
})

const { startTelegramCapture } = await import('../../../server/telegram/index.ts')

test('startTelegramCapture: no config on disk — returns false and never polls', () => {
  telegramConfig = null
  pollStarted = 0
  assert.equal(startTelegramCapture(), false)
  assert.equal(pollStarted, 0)
})

test('startTelegramCapture: a config with no token — returns false and never polls', () => {
  telegramConfig = { botToken: null, botUsername: null, boundChatId: null, pairingCode: null }
  pollStarted = 0
  assert.equal(startTelegramCapture(), false)
  assert.equal(pollStarted, 0)
})

test('startTelegramCapture: a token is configured — returns true and starts polling', () => {
  telegramConfig = { botToken: '123:abc', botUsername: 'kothai_bot', boundChatId: null, pairingCode: 'swordfish' }
  pollStarted = 0
  assert.equal(startTelegramCapture(), true)
  assert.equal(pollStarted, 1)
})

// Settings calls startTelegramCapture after every save and clear, so the
// running loop — which holds its own copy of the token — has to go first.
// Before, capture started only at boot: a new token did nothing until a
// restart, and a cleared one kept saving until then.
test('startTelegramCapture: a second start stops the running loop before polling again', () => {
  telegramConfig = { botToken: '123:abc', botUsername: 'kothai_bot', boundChatId: null, pairingCode: 'swordfish' }
  startTelegramCapture()
  pollStarted = 0
  pollStopped = 0
  telegramConfig = { botToken: '456:def', botUsername: 'other_bot', boundChatId: null, pairingCode: 'marlin' }
  assert.equal(startTelegramCapture(), true)
  assert.equal(pollStopped, 1, 'the old loop must stop')
  assert.equal(pollStarted, 1, 'and exactly one new loop starts')
})

test('startTelegramCapture: with the config cleared, the running loop stops and none replaces it', () => {
  telegramConfig = { botToken: '123:abc', botUsername: 'kothai_bot', boundChatId: 42, pairingCode: null }
  startTelegramCapture()
  pollStarted = 0
  pollStopped = 0
  telegramConfig = null
  assert.equal(startTelegramCapture(), false)
  assert.equal(pollStopped, 1, 'a disconnected bot must stop saving now, not at the next restart')
  assert.equal(pollStarted, 0)
})

test('startTelegramCapture: a second chat replaying the pairing code after the first has bound is dropped, and the bind persists pairingCode: null', async () => {
  telegramConfig = { botToken: '123:abc', botUsername: 'kothai_bot', boundChatId: null, pairingCode: 'secret-code' }
  writes.length = 0
  throwOnWrite = false
  sent.length = 0
  nextUpdates = [
    { update_id: 1, message: { message_id: 1, chat: { id: 111 }, text: 'secret-code' } },
    { update_id: 2, message: { message_id: 2, chat: { id: 222 }, text: 'secret-code' } },
  ]

  assert.equal(startTelegramCapture(), true)
  assert.ok(capturedRun, 'startPolling must be given a run callback')
  const result = await capturedRun!(false)

  assert.equal(result.failed, false)
  assert.deepEqual(
    writes,
    [{ botToken: '123:abc', botUsername: 'kothai_bot', boundChatId: 111, pairingCode: null }],
    'only the first chat binds, and the code is cleared so it cannot be replayed',
  )
  assert.deepEqual(
    sent.map(s => s.chatId),
    [111],
    'the second chat replaying the same code must be dropped silently, not just refused a second bind',
  )
})

test('startTelegramCapture: a write that fails on bind leaves the chat unbound, so the redelivered pairing message takes the bind path again on retry', async () => {
  telegramConfig = { botToken: '123:abc', botUsername: 'kothai_bot', boundChatId: null, pairingCode: 'secret-code' }
  writes.length = 0
  sent.length = 0
  const pairingMessage: TelegramUpdate = {
    update_id: 1,
    message: { message_id: 1, chat: { id: 111 }, text: 'secret-code' },
  }

  throwOnWrite = true
  assert.equal(startTelegramCapture(), true)
  nextUpdates = [pairingMessage]
  const first = await capturedRun!(false)

  assert.equal(first.failed, true, 'the throwing write must fail this pass rather than being swallowed')
  assert.equal(writes.length, 0, 'the failed write left no record')
  // assert.deepEqual(sent, []) here would narrow `sent`'s TS type to never[]
  // via node:assert/strict's generic signature, breaking the `.map` below.
  assert.equal(sent.length, 0, 'no confirmation was sent for a bind that never completed')

  // Telegram redelivers the same update because the offset never advanced.
  throwOnWrite = false
  nextUpdates = [pairingMessage]
  const second = await capturedRun!(false)

  assert.equal(second.failed, false)
  assert.deepEqual(
    writes,
    [{ botToken: '123:abc', botUsername: 'kothai_bot', boundChatId: 111, pairingCode: null }],
    'bound stayed null after the throw, so the redelivered message still took the bind path instead of being saved as a note containing the live pairing code',
  )
  assert.deepEqual(
    sent.map(s => s.chatId),
    [111],
    'the retry completes the bind and sends the confirmation',
  )
})
