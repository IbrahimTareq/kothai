// Tests for server/routes/telegram.ts — connect/disconnect the capture bot
// from Settings. data/telegram.ts is mocked so these run with no disk access
// and full control over what "currently configured" means per test.
//
// Mocks are installed before the subject is imported — mock.module only
// affects modules resolved after it runs.
import { test, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mockReq, mockRes, record } from '../../helpers/http.ts'

interface FakeConfig {
  botToken: string | null
  boundChatId: number | null
  pairingCode: string | null
}

let stored: FakeConfig | null = null
const writes: FakeConfig[] = []
let clears = 0
let stopped = false

mock.module('../../../server/data/telegram.ts', {
  namedExports: {
    readTelegram: () => stored,
    writeTelegram: (patch: Partial<FakeConfig>) => {
      const next: FakeConfig = {
        botToken: patch.botToken ?? null,
        boundChatId: patch.boundChatId ?? null,
        pairingCode: patch.pairingCode ?? null,
      }
      stored = next
      writes.push(next)
      return next
    },
    clearTelegram: () => {
      clears++
      stored = null
    },
  },
})
mock.module('../../../server/telegram/index.ts', {
  namedExports: { isCaptureStopped: () => stopped },
})

const { handleGetTelegram, handleSaveTelegram, handleClearTelegram } = await import(
  '../../../server/routes/telegram.ts'
)

const fakeReq = (body: unknown) => mockReq({ method: 'POST', body: JSON.stringify(body) })

beforeEach(() => {
  stored = null
  writes.length = 0
  clears = 0
  stopped = false
})

test('GET reports disconnected on an unconfigured install', () => {
  const { res, sent } = mockRes()
  handleGetTelegram(res)
  assert.equal(sent.code, 200)
  const body = sent.json()
  assert.equal(body.connected, false)
  assert.equal(body.boundChatId, null)
  assert.equal(body.pairingCode, null)
})

test('GET reports connection state and the pairing code, and never the token', () => {
  stored = { botToken: 'secret-token-123', boundChatId: null, pairingCode: 'ABC234' }
  const { res, sent } = mockRes()
  handleGetTelegram(res)
  const body = sent.json()
  assert.equal(body.connected, true)
  assert.equal(body.pairingCode, 'ABC234')
  // Asserted on the serialised body, not the parsed object: a field merely
  // absent from the parsed shape would still pass a `'botToken' in body`
  // check if the server had serialised it under another name.
  assert.ok(!String(sent.body).includes('secret-token-123'), 'the bot token must never appear in the response body')
})

test('GET reports disconnected once the poll loop has permanently stopped, even with a token still on disk', () => {
  stored = { botToken: 'secret-token-123', boundChatId: 42, pairingCode: null }
  stopped = true
  const { res, sent } = mockRes()
  handleGetTelegram(res)
  assert.equal(sent.json().connected, false, 'a 409-stopped loop is no longer actually saving anything')
})

test('POST stores the token, clears any previous binding, and generates a pairing code', async () => {
  stored = { botToken: 'old-token', boundChatId: 999, pairingCode: null }
  const { res, sent } = mockRes()
  await handleSaveTelegram(fakeReq({ botToken: '  new-token  ' }), res)
  assert.equal(sent.code, 200)
  const body = record(sent.json())
  assert.equal(body.connected, true)
  assert.equal(body.boundChatId, null, 'a different bot has never spoken to the old chat')
  assert.equal(body.restartRequired, true)
  assert.equal(writes[0].botToken, 'new-token', 'the token is trimmed')
  assert.match(String(body.pairingCode), /^[A-Z0-9]{6}$/)
})

test('POST generates a different pairing code on a second call', async () => {
  await handleSaveTelegram(fakeReq({ botToken: 'token-a' }), mockRes().res)
  const first = writes[0].pairingCode
  await handleSaveTelegram(fakeReq({ botToken: 'token-b' }), mockRes().res)
  const second = writes[1].pairingCode
  assert.notEqual(first, second, 'the code must be random, not a constant')
})

test('POST rejects an empty token', async () => {
  const { res, sent } = mockRes()
  await handleSaveTelegram(fakeReq({ botToken: '' }), res)
  assert.equal(sent.code, 400)
  assert.equal(writes.length, 0)
})

test('POST rejects a whitespace-only token', async () => {
  const { res, sent } = mockRes()
  await handleSaveTelegram(fakeReq({ botToken: '   ' }), res)
  assert.equal(sent.code, 400)
  assert.equal(writes.length, 0)
})

test('DELETE clears the configuration', () => {
  stored = { botToken: 'token', boundChatId: 5, pairingCode: null }
  const { res, sent } = mockRes()
  handleClearTelegram(res)
  assert.equal(sent.code, 200)
  const body = sent.json()
  assert.equal(body.connected, false)
  assert.equal(body.restartRequired, true)
  assert.equal(clears, 1)
  assert.equal(stored, null)
})
