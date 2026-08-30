// docker/hooks/pre-backup — the ONCE pre-backup hook, driven as a real child
// process against a real listening server.
//
// Testing it any other way would miss the point: this file ships as an
// executable that ONCE runs on a schedule, in an environment where a silent
// failure means backups that quietly omit recent notes. What matters is the
// process exit code, since that is the entire channel ONCE reads.
//
// STASH_PASSWORD is set here because the authenticated path is the one with
// moving parts — the hook has to log in and carry the session cookie. The
// unauthenticated path is the same code with the login block skipped.
process.env.STASH_PASSWORD = 'hunter2'

import { test, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'kothai-hook-test-'))
process.env.STASH_DATA_DIR = DATA_DIR

let importRunning = false
mock.module('../../server/routes/import.js', {
  namedExports: { isImportInProgress: () => importRunning, handleImport: async () => {} },
})

const store = await import('../../server/data/notes.js')
const { createServer } = await import('../../server/router.js')
await store.load()

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../docker/hooks/pre-backup')

const server = createServer()
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const PORT = String(server.address().port)
after(() => {
  server.close()
  rmSync(DATA_DIR, { recursive: true, force: true })
})

// Resolves to { code, stdout, stderr } rather than rejecting, so a non-zero
// exit is an assertable value instead of a thrown error.
function runHook(env = {}) {
  return new Promise((resolve) => {
    execFile('node', [HOOK], { env: { ...process.env, PORT, ...env } }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code ?? 1 : 0, stdout, stderr }))
  })
}

test('it checkpoints a password-protected instance and reports success', async () => {
  await store.addNote({ type: 'text', content: 'written-by-hook-test' }, { persist: false })

  const { code, stdout } = await runHook()
  assert.equal(code, 0, 'a successful checkpoint must exit 0 or ONCE reports the backup failed')
  assert.match(stdout, /self-contained/)
})

test('a wrong password fails loudly rather than letting a lossy backup proceed', async () => {
  const { code, stderr } = await runHook({ STASH_PASSWORD: 'not-the-password' })
  assert.equal(code, 1)
  assert.match(stderr, /login failed/)
})

test('an import in flight fails the backup rather than committing half of one', async () => {
  importRunning = true
  try {
    const { code, stderr } = await runHook()
    assert.equal(code, 1)
    assert.match(stderr, /import is running/)
  } finally {
    importRunning = false
  }
})

test('nothing listening exits 0 — a stopped server cannot be mid-write', async () => {
  // The container may be stopped for the backup. Failing here would turn the
  // safest possible moment to take a snapshot into a reported error.
  const { code, stdout } = await runHook({ PORT: '59999' })
  assert.equal(code, 0)
  assert.match(stdout, /nothing is writing/)
})
