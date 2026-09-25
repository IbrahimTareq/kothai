// A stand-in for the Google endpoints server/drive.ts calls — OAuth's device
// flow and the Drive v3 files API — installed as globalThis.fetch. Only
// requests to Google's hosts are answered here; everything else (a test's own
// calls to its listening server) goes to the real fetch.
//
// A fake at the fetch boundary rather than a mocked drive.ts, so the request
// shapes drive.ts builds — form bodies, the resumable upload's two steps, the
// query it lists a folder with — are what the tests exercise.

interface DriveFile {
  id: string
  name: string
  mimeType: string
  parents: string[]
  bytes: Buffer
  createdTime: string
}

export interface FakeGoogle {
  // What the next device-flow poll answers.
  approval: 'pending' | 'approved' | 'denied'
  // A refresh answered with invalid_grant, as for a revoked or expired token.
  refreshRevoked: boolean
  uploadFails: boolean
  files: Map<string, DriveFile>
  revoked: string[]
  uploads: number
  email: string
  restore(): void
}

const OAUTH = 'https://oauth2.googleapis.com'
const DRIVE = 'https://www.googleapis.com/drive/v3/files'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files'

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url')

export function fakeGoogle(): FakeGoogle {
  const realFetch = globalThis.fetch
  let nextId = 1
  const sessions = new Map<string, { name: string; parents: string[] }>()

  const google: FakeGoogle = {
    approval: 'approved',
    refreshRevoked: false,
    uploadFails: false,
    files: new Map(),
    revoked: [],
    uploads: 0,
    email: 'owner@example.com',
    restore: () => {
      globalThis.fetch = realFetch
    },
  }

  const add = (file: Omit<DriveFile, 'id' | 'createdTime'>) => {
    const id = `file-${nextId++}`
    google.files.set(id, { ...file, id, createdTime: new Date(Date.now() + nextId).toISOString() })
    return id
  }

  const authorized = (init?: RequestInit) => new Headers(init?.headers).get('authorization') === 'Bearer access-token'

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input)
    const method = init?.method ?? 'GET'
    if (!/googleapis\.com$/.test(url.hostname)) return realFetch(input, init)

    if (url.href === `${OAUTH}/device/code`) {
      const form = new URLSearchParams(String(init?.body))
      // drive.file and nothing broader: Kothai may see the files it made, and
      // which account it is — never the rest of the owner's Drive.
      const scopes = (form.get('scope') ?? '').split(' ')
      const allowed = ['https://www.googleapis.com/auth/drive.file', 'openid', 'email']
      if (!scopes.includes(allowed[0]) || scopes.some(s => !allowed.includes(s))) {
        return reply(400, { error: 'invalid_scope' })
      }
      return reply(200, {
        device_code: 'device-code',
        user_code: 'ABCD-EFGH',
        verification_url: 'https://www.google.com/device',
        expires_in: 1800,
        interval: 0,
      })
    }
    if (url.href === `${OAUTH}/token`) {
      const form = new URLSearchParams(String(init?.body))
      if (!form.get('client_secret')) return reply(401, { error: 'invalid_client' })
      if (form.get('grant_type') === 'refresh_token') {
        if (google.refreshRevoked || form.get('refresh_token') !== 'refresh-token') {
          return reply(400, { error: 'invalid_grant' })
        }
        return reply(200, { access_token: 'access-token', expires_in: 3599 })
      }
      if (google.approval === 'pending') return reply(428, { error: 'authorization_pending' })
      if (google.approval === 'denied') return reply(403, { error: 'access_denied' })
      return reply(200, {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 3599,
        id_token: `${b64url({ alg: 'none' })}.${b64url({ email: google.email })}.`,
      })
    }
    if (url.href.startsWith(`${OAUTH}/revoke`)) {
      google.revoked.push(new URLSearchParams(String(init?.body)).get('token') ?? '')
      return reply(200, {})
    }

    if (!authorized(init)) return reply(401, { error: { message: 'Invalid Credentials' } })

    if (url.origin + url.pathname === DRIVE && method === 'GET') {
      const q = url.searchParams.get('q') ?? ''
      const parent = /'([^']+)' in parents/.exec(q)?.[1]
      const name = /name = '([^']+)'/.exec(q)?.[1]
      const found = [...google.files.values()].filter(
        f => (!parent || f.parents.includes(parent)) && (!name || f.name === name),
      )
      return reply(200, {
        files: found.map(f => ({ id: f.id, name: f.name, size: String(f.bytes.length), createdTime: f.createdTime })),
      })
    }
    if (url.origin + url.pathname === DRIVE && method === 'POST') {
      const meta = JSON.parse(String(init?.body))
      return reply(200, { id: add({ ...meta, parents: meta.parents ?? [], bytes: Buffer.alloc(0) }) })
    }
    if (url.origin + url.pathname === UPLOAD && method === 'POST') {
      const meta = JSON.parse(String(init?.body))
      const session = `session-${nextId++}`
      sessions.set(session, { name: meta.name, parents: meta.parents })
      return reply(200, {}, { Location: `${UPLOAD}?uploadType=resumable&upload_id=${session}` })
    }
    if (url.origin + url.pathname === UPLOAD && method === 'PUT') {
      const session = sessions.get(url.searchParams.get('upload_id') ?? '')
      if (!session) return reply(404, { error: { message: 'No such upload.' } })
      const bytes = Buffer.from(await new Response(init?.body).arrayBuffer())
      if (google.uploadFails) return reply(503, { error: { message: 'Backend Error' } })
      google.uploads++
      return reply(200, { id: add({ ...session, mimeType: 'application/gzip', bytes }) })
    }
    const id = url.pathname.startsWith('/drive/v3/files/') ? url.pathname.split('/').pop() : undefined
    const file = id ? google.files.get(id) : undefined
    if (!file) return reply(404, { error: { message: 'File not found.' } })
    if (method === 'DELETE') {
      google.files.delete(file.id)
      return new Response(null, { status: 204 })
    }
    if (url.searchParams.get('alt') === 'media') return new Response(new Uint8Array(file.bytes))
    return reply(400, { error: { message: `unhandled ${method} ${url.href}` } })
  }

  return google
}
