// The capture token's hash is a credential-adjacent file: it lives outside
// SQLite so it never rides along in a backup, and a corrupt copy must never
// stop the server booting.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readCaptureTokenHash, writeCaptureTokenHash, clearCaptureToken } from '../../../server/data/capture-token.ts'

const freshDir = () => mkdtempSync(path.join(tmpdir(), 'kothai-capture-'))
const HASH = 'a'.repeat(64)

test('writeCaptureTokenHash/readCaptureTokenHash: a hash round-trips', () => {
  const dir = freshDir()
  writeCaptureTokenHash(HASH, dir)
  assert.equal(readCaptureTokenHash(dir), HASH)
})

test('readCaptureTokenHash: no file reads as null rather than throwing', () => {
  assert.equal(readCaptureTokenHash(freshDir()), null)
})

test('readCaptureTokenHash: malformed JSON reads as null — a corrupt file must never be why the server fails to boot', () => {
  const dir = freshDir()
  writeFileSync(path.join(dir, 'capture-token.json'), '{ not json')
  assert.equal(readCaptureTokenHash(dir), null)
})

test('readCaptureTokenHash: anything but a SHA-256 hex digest is not a token', () => {
  const dir = freshDir()
  writeFileSync(path.join(dir, 'capture-token.json'), JSON.stringify({ hash: 'plaintext-token' }))
  assert.equal(readCaptureTokenHash(dir), null)
})

test('writeCaptureTokenHash: the file is 0600', () => {
  const dir = freshDir()
  writeCaptureTokenHash(HASH, dir)
  assert.equal(statSync(path.join(dir, 'capture-token.json')).mode & 0o777, 0o600)
})

test('clearCaptureToken: revokes, and is a no-op when there is nothing to revoke', () => {
  const dir = freshDir()
  writeCaptureTokenHash(HASH, dir)
  clearCaptureToken(dir)
  assert.equal(readCaptureTokenHash(dir), null)
  assert.doesNotThrow(() => clearCaptureToken(dir))
})
