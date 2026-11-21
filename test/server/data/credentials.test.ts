// Inference credentials live OUTSIDE the database on purpose — /api/backup is
// a VACUUM INTO over the whole SQLite file, so a key in a table would ride
// along in every downloaded backup.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, statSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  readCredentials,
  writeCredentials,
  writeRoleCredentials,
  clearCredentials,
} from '../../../server/data/credentials.ts'

const dir = () => mkdtempSync(path.join(tmpdir(), 'kothai-creds-'))

test('round-trips a base URL and key', () => {
  const d = dir()
  writeCredentials({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' }, d)
  // providerId rides along so the provider can look up its own quirks later
  // (a separate embeddings catalogue, say) — see server/ai/endpoints.ts.
  assert.deepEqual(readCredentials(d), { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', providerId: null })
})

test('the file is 0600, even when overwriting a permissive one', () => {
  const d = dir()
  const file = path.join(d, 'credentials.json')
  writeFileSync(file, '{}')
  chmodSync(file, 0o644)
  writeCredentials({ baseUrl: 'https://example.com/v1', apiKey: 'k' }, d)
  assert.equal(statSync(file).mode & 0o777, 0o600)
})

test('a missing file reads as nothing configured, not an error', () => {
  assert.equal(readCredentials(dir()), null)
})

test('a corrupt file reads as nothing configured — it must not stop the server booting', () => {
  const d = dir()
  writeFileSync(path.join(d, 'credentials.json'), 'not json at all')
  assert.equal(readCredentials(d), null)
})

test('an entry with neither value reads as null rather than a hollow object', () => {
  const d = dir()
  writeFileSync(path.join(d, 'credentials.json'), JSON.stringify({ baseUrl: null, apiKey: null }))
  assert.equal(readCredentials(d), null)
})

test('a write to an unwritable directory throws — a key that silently vanishes is worse', () => {
  assert.throws(() => writeCredentials({ baseUrl: 'https://x/v1', apiKey: 'k' }, '/nonexistent-dir-xyz'))
})

test('clear removes the file and is safe to call twice', () => {
  const d = dir()
  writeCredentials({ baseUrl: 'https://x/v1', apiKey: 'k' }, d)
  clearCredentials(d)
  clearCredentials(d)
  assert.equal(readCredentials(d), null)
})

test('a role entry round-trips at 0600 and leaves the shared entry alone', () => {
  const d = dir()
  writeCredentials({ baseUrl: 'https://s/v1', apiKey: 'sk' }, d)
  const ep = { baseUrl: 'https://e/v1', apiKey: 'ek', providerId: 'ollama' }
  writeRoleCredentials('embed', ep, d)
  assert.deepEqual(readCredentials(d), {
    baseUrl: 'https://s/v1',
    apiKey: 'sk',
    providerId: null,
    roles: { embed: ep },
  })
  assert.equal(statSync(path.join(d, 'credentials.json')).mode & 0o777, 0o600)
})

test('a role entry can be written with no shared entry', () => {
  const d = dir()
  const ep = { baseUrl: 'https://v/v1', apiKey: null, providerId: null }
  writeRoleCredentials('vision', ep, d)
  assert.deepEqual(readCredentials(d)?.roles, { vision: ep })
})

test('writing null removes only that role', () => {
  const d = dir()
  const ep = { baseUrl: 'https://e/v1', apiKey: 'ek', providerId: null }
  writeRoleCredentials('embed', ep, d)
  writeRoleCredentials('vision', { ...ep, baseUrl: 'https://v/v1' }, d)
  writeRoleCredentials('embed', null, d)
  assert.deepEqual(readCredentials(d)?.roles, { vision: { ...ep, baseUrl: 'https://v/v1' } })
})

test('a malformed role entry is dropped and the shared entry survives', () => {
  const d = dir()
  writeFileSync(
    path.join(d, 'credentials.json'),
    JSON.stringify({ baseUrl: 'https://s/v1', apiKey: 'sk', roles: { embed: 42, vision: { baseUrl: 7 } } }),
  )
  const c = readCredentials(d)
  assert.equal(c?.baseUrl, 'https://s/v1')
  assert.equal(c?.roles?.embed, undefined)
  assert.equal(c?.roles?.vision, undefined)
})

test('saving the shared endpoint keeps role entries already stored', () => {
  const d = dir()
  const ep = { baseUrl: 'https://e/v1', apiKey: 'ek', providerId: null }
  writeRoleCredentials('embed', ep, d)
  writeCredentials({ baseUrl: 'https://s/v1', apiKey: 'sk', providerId: null }, d)
  assert.deepEqual(readCredentials(d)?.roles, { embed: ep })
  assert.equal(readCredentials(d)?.baseUrl, 'https://s/v1')
})
