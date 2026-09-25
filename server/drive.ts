// Copies of the daily backup in the owner's Google Drive — the off-site copy
// that data/backups (server/backups.ts) cannot be, since it shares a disk with
// the library it protects.
//
// Signed in with Google's device flow: Settings shows a code, the owner enters
// it at google.com/device on any device. It needs no redirect back to Kothai,
// which is what lets it work on localhost, a tailnet or a PaaS alike — a
// redirect URL would have to be registered with Google for every install.
//
// The scope is drive.file: Kothai sees only the files it created, never the
// rest of the owner's Drive. That is also what makes a reconnect — on a new
// machine, say — find the same folder: the files belong to the app, not to
// the install that uploaded them.
import { chmodSync, createReadStream, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import path from 'node:path'
import { DATA_DIR } from './config.ts'
import { listBackups } from './backups.ts'
import { readTelegram } from './data/telegram.ts'
import { sendMessage } from './telegram/api.ts'

// The Google OAuth client every install signs in through: a "TVs and Limited
// Input devices" client, whose secret Google treats as public — it ships in
// every copy of an installed app. Read here, like routes/demo.ts's KOTHAI_DEMO,
// because nothing else needs it. Both halves or none: one alone would fail at
// Google, far from the typo.
const { KOTHAI_GOOGLE_CLIENT_ID: CLIENT_ID, KOTHAI_GOOGLE_CLIENT_SECRET: CLIENT_SECRET } = process.env
const GOOGLE_CLIENT = CLIENT_ID && CLIENT_SECRET ? { id: CLIENT_ID, secret: CLIENT_SECRET } : null

const OAUTH = 'https://oauth2.googleapis.com'
const DRIVE = 'https://www.googleapis.com/drive/v3/files'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files'
// openid email: only so Settings can say which account is connected.
const SCOPE = 'https://www.googleapis.com/auth/drive.file openid email'
const FOLDER = 'Kothai Backups'
const FOLDER_TYPE = 'application/vnd.google-apps.folder'
// Mirrors data/backups. Each copy is the whole library, and a free Google
// account's 15 GB is shared with Gmail and Photos.
const KEEP = 7
const DAILY = /^kothai-backup-[0-9T-]+Z\.tar\.gz$/

// ---- the connection ---------------------------------------------------------
// The refresh token opens the owner's Drive, so it lives in its own file and
// never in SQLite: every backup carries the whole database, and a backup is
// exactly what gets uploaded to that Drive and downloaded from Settings.

const FILE = path.join(DATA_DIR, 'google-drive.json')

interface Connection {
  refreshToken: string
  email: string | null
}

function readConnection(): Connection | null {
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8'))
    return typeof parsed.refreshToken === 'string' && parsed.refreshToken
      ? { refreshToken: parsed.refreshToken, email: typeof parsed.email === 'string' ? parsed.email : null }
      : null
  } catch {
    return null
  }
}

function writeConnection(connection: Connection): void {
  writeFileSync(FILE, JSON.stringify(connection, null, 2), { mode: 0o600 })
  // `mode` applies only when the file is created; an older one keeps its own.
  chmodSync(FILE, 0o600)
}

// A code waiting to be entered, and why the last attempt ended without a
// connection. `attempt` is bumped by every connect and disconnect, so a poll
// loop that has been superseded stops at its next turn instead of connecting.
let pending: { userCode: string; verificationUrl: string } | null = null
let error: string | null = null
let attempt = 0
// Why the last copy to Drive did not happen, until one does.
let failure: { at: string; error: string } | null = null

export function driveStatus() {
  const connection = readConnection()
  return {
    configured: GOOGLE_CLIENT !== null,
    connected: connection !== null,
    email: connection?.email ?? null,
    pending,
    error,
    failure,
  }
}

function client() {
  if (!GOOGLE_CLIENT) throw new Error('Google Drive is not set up on this install.')
  return GOOGLE_CLIENT
}

async function post(url: string, form: Record<string, string>) {
  const res = await fetch(url, { method: 'POST', body: new URLSearchParams(form) })
  return { res, body: (await res.json().catch(() => ({}))) as Record<string, unknown> }
}

export async function connectDrive(): Promise<{ userCode: string; verificationUrl: string }> {
  const { id } = client()
  const mine = ++attempt
  error = null
  const { res, body } = await post(`${OAUTH}/device/code`, { client_id: id, scope: SCOPE })
  if (!res.ok) throw new Error(`Google refused to start sign-in (${String(body.error ?? res.status)}).`)
  pending = { userCode: String(body.user_code), verificationUrl: String(body.verification_url) }
  const expiresAt = Date.now() + Number(body.expires_in) * 1000
  poll(mine, String(body.device_code), Number(body.interval), expiresAt).catch(err => {
    if (mine !== attempt) return
    pending = null
    error = err instanceof Error ? err.message : String(err)
  })
  return pending
}

// Google answers "not yet" until the code is entered; the loop asks at the
// interval Google set, and slows down when told to.
async function poll(mine: number, deviceCode: string, interval: number, expiresAt: number): Promise<void> {
  const { id, secret } = client()
  while (mine === attempt) {
    await new Promise(r => setTimeout(r, interval * 1000))
    if (mine !== attempt) return
    if (Date.now() > expiresAt) throw new Error('The code expired before it was entered — connect again.')
    const { body } = await post(`${OAUTH}/token`, {
      client_id: id,
      client_secret: secret,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    })
    if (mine !== attempt) return
    if (body.error === 'authorization_pending') continue
    if (body.error === 'slow_down') {
      interval += 5
      continue
    }
    if (body.error === 'access_denied') throw new Error('Access was denied in Google — connect again to retry.')
    if (typeof body.refresh_token !== 'string') throw new Error(`Google refused the sign-in (${String(body.error)}).`)
    writeConnection({ refreshToken: body.refresh_token, email: emailOf(body.id_token) })
    pending = null
    failure = null
    return
  }
}

// The id token came straight from Google over TLS, in answer to this request,
// so its payload is read rather than verified.
function emailOf(idToken: unknown): string | null {
  try {
    const payload = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'))
    return typeof payload.email === 'string' ? payload.email : null
  } catch {
    return null
  }
}

export async function disconnectDrive(): Promise<void> {
  attempt++
  pending = null
  error = null
  failure = null
  const connection = readConnection()
  if (!connection) return
  // Best effort: a disconnect has to work with Google unreachable too, and
  // forgetting the token here is what stops Kothai using it either way.
  await post(`${OAUTH}/revoke`, { token: connection.refreshToken }).catch(() => {})
  try {
    unlinkSync(FILE)
  } catch {
    /* already gone */
  }
}

// ---- Drive ------------------------------------------------------------------

async function accessToken(connection: Connection): Promise<string> {
  const { id, secret } = client()
  const { res, body } = await post(`${OAUTH}/token`, {
    client_id: id,
    client_secret: secret,
    refresh_token: connection.refreshToken,
    grant_type: 'refresh_token',
  })
  if (body.error === 'invalid_grant') {
    throw new Error('Google Drive access was revoked or has expired — reconnect it in Settings.')
  }
  if (!res.ok || typeof body.access_token !== 'string') {
    throw new Error(`Google would not renew Drive access (${String(body.error ?? res.status)}).`)
  }
  return body.access_token
}

async function api(token: string, url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } }
    throw new Error(`Google Drive: ${body.error?.message ?? `HTTP ${res.status}`}`)
  }
  return res
}

async function findFolder(token: string): Promise<string | null> {
  const q = `name = '${FOLDER}' and mimeType = '${FOLDER_TYPE}' and trashed = false`
  const res = await api(token, `${DRIVE}?${new URLSearchParams({ q, fields: 'files(id)' })}`)
  const { files } = (await res.json()) as { files: { id: string }[] }
  return files[0]?.id ?? null
}

async function createFolder(token: string): Promise<string> {
  const res = await api(token, `${DRIVE}?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER, mimeType: FOLDER_TYPE }),
  })
  return ((await res.json()) as { id: string }).id
}

interface DriveBackup {
  id: string
  name: string
  size: number
  at: string
}

// Daily backups only, newest first — the names sort by the time in them.
async function listFolder(token: string, folder: string): Promise<DriveBackup[]> {
  const params = new URLSearchParams({
    q: `'${folder}' in parents and trashed = false`,
    fields: 'files(id,name,size,createdTime)',
    pageSize: '100',
  })
  const res = await api(token, `${DRIVE}?${params}`)
  const { files } = (await res.json()) as { files: { id: string; name: string; size: string; createdTime: string }[] }
  return files
    .filter(f => DAILY.test(f.name))
    .map(f => ({ id: f.id, name: f.name, size: Number(f.size), at: f.createdTime }))
    .sort((a, b) => b.name.localeCompare(a.name))
}

// Resumable, in two steps: the metadata opens a session, then the file is
// streamed to it. Streamed because the file is the whole library.
async function upload(token: string, folder: string, name: string, file: string, size: number): Promise<void> {
  const start = await api(token, `${UPLOAD}?uploadType=resumable`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'application/gzip',
      'X-Upload-Content-Length': String(size),
    },
    body: JSON.stringify({ name, parents: [folder] }),
  })
  const session = start.headers.get('location')
  if (!session) throw new Error('Google Drive did not open an upload.')
  await api(token, session, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/gzip', 'Content-Length': String(size) },
    body: Readable.toWeb(createReadStream(file)) as ReadableStream,
    // Required by fetch for a streamed request body.
    duplex: 'half',
  } as RequestInit)
}

export async function listDriveBackups(): Promise<DriveBackup[]> {
  const connection = readConnection()
  if (!connection) throw new Error('Google Drive is not connected.')
  const token = await accessToken(connection)
  const folder = await findFolder(token)
  return folder ? listFolder(token, folder) : []
}

// Only a backup in the folder can be opened: the id arrives from a request.
export async function openDriveBackup(id: string): Promise<Readable> {
  const connection = readConnection()
  if (!connection) throw new Error('Google Drive is not connected.')
  const token = await accessToken(connection)
  const folder = await findFolder(token)
  const listed = folder ? await listFolder(token, folder) : []
  if (!listed.some(f => f.id === id)) throw new Error('No backup with that id in Kothai Backups.')
  const res = await api(token, `${DRIVE}/${encodeURIComponent(id)}?alt=media`)
  if (!res.body) throw new Error('Google Drive sent an empty backup.')
  return Readable.fromWeb(res.body as WebReadableStream)
}

// What server/index.ts calls every hour, after backups.backupIfDue: puts the
// newest daily backup on Drive if it is not there yet, then trims Drive to the
// newest KEEP. Reading what is already there each time, rather than keeping a
// note of the last upload, is what makes a failed hour retry by itself.
export async function syncToDrive(): Promise<void> {
  const connection = readConnection()
  if (!connection || !GOOGLE_CLIENT) return
  const newest = (await listBackups()).files.find(f => f.kind === 'daily')
  if (!newest) return
  try {
    const token = await accessToken(connection)
    const folder = (await findFolder(token)) ?? (await createFolder(token))
    let there = await listFolder(token, folder)
    if (!there.some(f => f.name === newest.name)) {
      await upload(token, folder, newest.name, path.join(DATA_DIR, 'backups', newest.name), newest.size)
      there = await listFolder(token, folder)
    }
    for (const stale of there.slice(KEEP)) await api(token, `${DRIVE}/${stale.id}`, { method: 'DELETE' })
    failure = null
  } catch (err) {
    console.error('[drive] copy to Google Drive failed:', err)
    const first = !failure
    failure = { at: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) }
    // Once per run of failures, as for the local backup (server/backups.ts).
    if (first)
      await report(
        `Kothai couldn't copy today's backup to Google Drive. ${failure.error} It will keep trying every hour.`,
      )
  }
}

// To the paired Telegram chat, when there is one — as backups.ts does for a
// local backup that failed. Two copies of three lines, not yet a helper.
async function report(text: string): Promise<void> {
  const config = readTelegram()
  if (config?.botToken && config.boundChatId !== null) await sendMessage(config.botToken, config.boundChatId, text)
}
