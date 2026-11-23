import { API_VERSION, ApiRequestError, createClient } from '@kothai/api'

export type ServerStatus =
  | { kind: 'ok'; apiVersion: number; signIn: string[] }
  | { kind: 'update-server'; detail: string }
  | { kind: 'update-app'; detail: string }
  | { kind: 'unreachable'; detail: string }

// Follows docs/api.md "Checking compatibility". Resolves for every outcome so
// the screen never sees a rejection: self-hosted servers lag app releases, and
// an old one must read as "update your server", not as a crash (cloud spec,
// point 4).
export async function checkServer(baseUrl: string, fetch: typeof globalThis.fetch): Promise<ServerStatus> {
  try {
    const info = await createClient({ baseUrl, fetch }).info()
    if (info.minClientVersion > API_VERSION)
      return { kind: 'update-app', detail: `server needs app API ${info.minClientVersion}, this app speaks ${API_VERSION}` }
    if (info.apiVersion < API_VERSION)
      return { kind: 'update-server', detail: `server speaks API ${info.apiVersion}, this app needs ${API_VERSION}` }
    return { kind: 'ok', apiVersion: info.apiVersion, signIn: info.signIn }
  } catch (e) {
    if (!(e instanceof ApiRequestError)) return { kind: 'unreachable', detail: String(e) }
    // A pre-v1 server has no /api/v1/info: 401 behind a password, and the SPA's
    // 200 HTML without one, which the client reports as code `network`.
    if (e.status === 401 || (e.status === 200 && e.code === 'network'))
      return { kind: 'update-server', detail: 'server predates API v1' }
    return { kind: 'unreachable', detail: e.status ? `${e.status} ${e.code}: ${e.message}` : e.message }
  }
}
