// The bot token is a credential: it reads every message sent to the bot. These
// tests pin the two properties that keep it out of a backup and out of a
// corrupt-file boot failure.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readTelegram, writeTelegram, clearTelegram } from '../../../server/data/telegram.ts'

const freshDir = () => mkdtempSync(path.join(tmpdir(), 'kothai-tg-'))

test('writeTelegram/readTelegram: a token, bound chat and pairing code round-trip', () => {
  const dir = freshDir()
  writeTelegram({ botToken: '123:abc', boundChatId: 42, pairingCode: 'swordfish' }, dir)
  assert.deepEqual(readTelegram(dir), { botToken: '123:abc', boundChatId: 42, pairingCode: 'swordfish' })
})

test('readTelegram: no file reads as null rather than throwing', () => {
  assert.equal(readTelegram(freshDir()), null)
})

test('readTelegram: malformed JSON reads as null — a corrupt file must never be why the server fails to boot', () => {
  const dir = freshDir()
  writeFileSync(path.join(dir, 'telegram.json'), '{ not json')
  assert.equal(readTelegram(dir), null)
})

test('readTelegram: a chat id with no token is not a configuration', () => {
  const dir = freshDir()
  writeFileSync(path.join(dir, 'telegram.json'), JSON.stringify({ boundChatId: 42 }))
  assert.equal(readTelegram(dir), null)
})

test('writeTelegram: the file is 0600 — it holds a credential', () => {
  const dir = freshDir()
  writeTelegram({ botToken: '123:abc' }, dir)
  assert.equal(statSync(path.join(dir, 'telegram.json')).mode & 0o777, 0o600)
})

test('clearTelegram: removing a file that is already gone is not an error', () => {
  const dir = freshDir()
  clearTelegram(dir)
  assert.equal(readTelegram(dir), null)
})

test('writeTelegram: a write carrying only a token clears the binding — a new bot has never been bound', () => {
  const dir = freshDir()
  writeTelegram({ botToken: '123:abc', boundChatId: 42, pairingCode: 'swordfish' }, dir)
  writeTelegram({ botToken: '456:def' }, dir)
  assert.deepEqual(readTelegram(dir), { botToken: '456:def', boundChatId: null, pairingCode: null })
})

test('writeTelegram: a write to an unwritable directory throws — a token that silently vanishes is worse', () => {
  assert.throws(() => writeTelegram({ botToken: '123:abc' }, '/nonexistent-dir-xyz'))
})
