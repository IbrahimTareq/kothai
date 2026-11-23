import type { ApiError, Changes, Info, NotesPage, SaveRequest, SaveResponse, SpacesList } from './types.ts'

export class ApiRequestError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiRequestError'
    this.status = status
    this.code = code
  }
}

// Only global fetch, URL and URLSearchParams: this runs in the browser and in
// React Native, where node: imports crash at bundle time. `fetch` is injectable
// because Expo's global fetch cannot stream; the app passes `expo/fetch`.
export function createClient(opts: { baseUrl: string; token?: string; fetch?: typeof globalThis.fetch }) {
  const base = opts.baseUrl.replace(/\/+$/, '')

  async function call<T>(
    path: string,
    query: Record<string, string | number | undefined> = {},
    body?: unknown,
  ): Promise<T> {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, String(v))
    const headers: Record<string, string> = {}
    if (opts.token) headers.authorization = `Bearer ${opts.token}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    // toString(), not qs.size: older React Native URLSearchParams polyfills lack
    // size, and `undefined` would silently drop every query string.
    const q = qs.toString()
    let res: Response
    try {
      res = await (opts.fetch ?? fetch)(`${base}${path}${q ? `?${q}` : ''}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch (e) {
      throw new ApiRequestError(0, 'network', e instanceof Error ? e.message : 'network error')
    }
    // A proxy's HTML error page is not the contract's { error, code }; report it
    // as a network failure rather than letting JSON.parse's SyntaxError escape.
    let parsed: unknown
    try {
      parsed = await res.json()
    } catch {
      throw new ApiRequestError(res.status, 'network', `unreadable response (${res.status})`)
    }
    if (!res.ok) {
      const e = parsed as Partial<ApiError> | null
      throw new ApiRequestError(res.status, e?.code ?? 'network', e?.error ?? `request failed (${res.status})`)
    }
    return parsed as T
  }

  return {
    info: () => call<Info>('/api/v1/info'),
    notes: (o: { cursor?: string; limit?: number; space?: string } = {}) => call<NotesPage>('/api/v1/notes', o),
    spaces: () => call<SpacesList>('/api/v1/spaces'),
    changes: (since?: string) => call<Changes>('/api/v1/changes', { since }),
    save: (req: SaveRequest) => call<SaveResponse>('/api/v1/save', {}, req),
  }
}
