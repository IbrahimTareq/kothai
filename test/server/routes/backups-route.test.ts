// /api/backups — what Settings shows of the backups kept in data/backups, the
// download of any one of them, and the switch that turns the daily one off.
//
// The download is the part with teeth: it serves a file named by the URL, so
// the only names it may answer are the ones the listing itself produced.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { jsonBody, listenOnLoopback, records } from '../../helpers/http.ts'

const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'kothai-backups-route-test-'))
process.env.KOTHAI_DATA_DIR = DATA_DIR
const BACKUPS = path.join(DATA_DIR, 'backups')

const settings = await import('../../../server/data/settings.ts')
const { getDb } = await import('../../../server/data/db.ts')
const { createServer } = await import('../../../server/router.ts')
await settings.load()

const server = createServer()
const BASE = `http://127.0.0.1:${await listenOnLoopback(server)}`
after(() => {
  server.close()
  rmSync(DATA_DIR, { recursive: true, force: true })
})

const DAILY = 'kothai-backup-2026-09-25T03-00-00-000Z.tar.gz'
const BEFORE = 'before-restore-2026-09-24T03-00-00-000Z.tar.gz'
mkdirSync(BACKUPS, { recursive: true })
writeFileSync(path.join(BACKUPS, DAILY), 'daily bytes')
writeFileSync(path.join(BACKUPS, BEFORE), 'before bytes')
// Beside the backups, and must never be served through this route.
writeFileSync(path.join(DATA_DIR, 'secret.txt'), 'not a backup')

const patch = (body: unknown) =>
  fetch(`${BASE}/api/backups`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

test('the listing carries every kept backup, whether the daily one is on, and its last failure', async () => {
  const body = await jsonBody(await fetch(`${BASE}/api/backups`))
  assert.equal(body.enabled, true)
  assert.equal(body.failure, null)
  assert.deepEqual(
    records(body.files)
      .map(f => f.name)
      .sort(),
    [BEFORE, DAILY],
  )
})

test('a listed backup downloads as a file, byte for byte', async () => {
  const res = await fetch(`${BASE}/api/backups/${DAILY}`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-disposition') ?? '', new RegExp(`^attachment; filename="${DAILY}"`))
  assert.equal(await res.text(), 'daily bytes')
})

for (const name of ['secret.txt', '..%2Fsecret.txt', '..%2F..%2Fetc%2Fpasswd', 'kothai.db', `${DAILY}.partial`]) {
  test(`a name the listing did not produce is not served: ${name}`, async () => {
    const res = await fetch(`${BASE}/api/backups/${name}`)
    assert.equal(res.status, 404)
    assert.doesNotMatch(await res.text(), /not a backup/)
  })
}

test('switching the daily backup off is kept in the settings table, so it survives a restart', async () => {
  const res = await patch({ enabled: false })
  assert.equal(res.status, 200)
  assert.equal((await jsonBody(res)).enabled, false)
  const row = (await getDb()).prepare('SELECT backups FROM settings').get()
  assert.equal(row?.backups, 0)

  assert.equal((await jsonBody(await patch({ enabled: true }))).enabled, true)
})

test('anything but a true or false is refused', async () => {
  for (const body of [{ enabled: 'no' }, {}, { enabled: 0 }]) {
    assert.equal((await patch(body)).status, 400, JSON.stringify(body))
  }
  assert.equal(settings.backupsOn(), true)
})
