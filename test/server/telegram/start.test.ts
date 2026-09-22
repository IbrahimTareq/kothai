// The wiring contract: startTelegramCapture must not start the poll loop when
// there is nothing to poll with, and must start it the moment a token exists.
// The pieces it assembles (poll.ts, ingest.ts, api.ts) are tested on their own.
//
// Mocks are installed before the subject is imported — mock.module only
// affects modules resolved after it runs.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

let telegramConfig: { botToken: string | null; boundChatId: number | null; pairingCode: string | null } | null = null
let pollStarted = 0

mock.module('../../../server/data/telegram.ts', {
  namedExports: {
    readTelegram: () => telegramConfig,
    writeTelegram: () => {
      throw new Error('not exercised by this test')
    },
  },
})
mock.module('../../../server/telegram/poll.ts', {
  namedExports: {
    pollOnce: async () => ({ offset: 0, conflict: false, failed: false }),
    startPolling: () => {
      pollStarted++
    },
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
  telegramConfig = { botToken: null, boundChatId: null, pairingCode: null }
  pollStarted = 0
  assert.equal(startTelegramCapture(), false)
  assert.equal(pollStarted, 0)
})

test('startTelegramCapture: a token is configured — returns true and starts polling', () => {
  telegramConfig = { botToken: '123:abc', boundChatId: null, pairingCode: 'swordfish' }
  pollStarted = 0
  assert.equal(startTelegramCapture(), true)
  assert.equal(pollStarted, 1)
})
