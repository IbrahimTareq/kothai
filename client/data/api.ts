// Backend bridge — maps a server note (QVAC) into the UI item shape and exposes
// the real /api endpoints.
import type {
  CanvasDoc,
  Chat,
  ChatMessage,
  ChatSummary,
  CaptureTokenState,
  Collection,
  ModelFilesResponse,
  ModelStatus,
  Residency,
  ServerNote,
  SettingsResponse,
  TelegramState,
  UIItem,
} from '../types'

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

export function mapNote(n: ServerNote): UIItem {
  return {
    id: n.id,
    ts: Date.parse(n.createdAt) || Date.now(),
    type: n.type,
    tags: n.tags || [],
    category: n.category,
    summary: n.summary,
    mindNote: n.mindNote || '',
    pending: !!n.pending,
    metaFetched: !!n.metaFetched,
    unavailable: !!n.unavailable,
    url: n.url,
    host: hostOf(n.url || '') || (n.type === 'video' ? 'video' : ''),
    title: n.siteTitle || n.title,
    note: n.siteDesc || '',
    thumb: n.thumb || null,
    thumbRatio: n.thumbRatio || null,
    slides: n.slides,
    siteName: n.siteName || null,
  }
}

// Every request that changes data must carry this. It is not a CORS-safelisted
// content type, so the browser preflights any cross-origin attempt and the
// server rejects anything without it (see server/routes/auth.ts) — which is
// what closes the CSRF hole SameSite=Lax leaves open between ports on
// localhost. Harmless when KOTHAI_PASSWORD is unset and the rule is not applied.
const JSON_HEADERS = { 'Content-Type': 'application/json' }

// One envelope for every /api call. Thirty-odd call sites used to spell out the
// fetch, the header and the JSON.stringify by hand — and nineteen of them
// re-inlined the header literal that JSON_HEADERS above already names, so the
// reasoning attached to it covered a third of the surface and was silently
// re-decided everywhere else.
//
// The names carry the api prefix because `patch` and `del` collide with local
// parameters of those names further down the file.
function request<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const { method, body, signal } = init
  return fetch(path, {
    ...(method ? { method } : {}),
    // A GET carries no body and needs no content type; everything that changes
    // data does, for the reason given on JSON_HEADERS above.
    ...(method && method !== 'GET' ? { headers: JSON_HEADERS } : {}),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
  }).then(r => _json<T>(r))
}

const apiGet = <T = unknown>(path: string) => request<T>(path)
const apiPost = <T = unknown>(path: string, body?: unknown, signal?: AbortSignal) =>
  request<T>(path, { method: 'POST', body, signal })
const apiPatch = <T = unknown>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body })
const apiDel = <T = unknown>(path: string, body?: unknown) => request<T>(path, { method: 'DELETE', body })

async function _json<T = unknown>(r: Response): Promise<T> {
  // The session expired, or the server was restarted with a password now set.
  // There is no client-side login screen to route to: reloading lands on the
  // server-rendered one. Navigations are answered with it, so this cannot loop.
  if (r.status === 401) window.location.reload()
  const d = await r.json().catch(() => ({}))
  if (!r.ok) {
    const body = d as { error?: string; code?: string }
    const e = new Error(body.error || r.statusText) as Error & { code?: string }
    e.code = body.code
    throw e
  }
  return d as T
}

// The message to show for a failed call. _json above is the only place that
// ever attaches `code` to an Error, and five call sites re-derived the unwrap
// from scratch — each one re-deciding that a non-Error is possible, that a
// coded failure outranks a generic one, and that an empty message falls back.
//
// `byCode` maps a server code to the sentence for it; anything not listed
// falls through to the server's own message, then to `fallback`.
export function apiError(e: unknown, fallback: string, byCode: Record<string, string> = {}): string {
  const err = e instanceof Error ? (e as Error & { code?: string }) : null
  if (err?.code && byCode[err.code]) return byCode[err.code]
  return err?.message || fallback
}

interface SavePayload {
  text: string
}
interface AskPayload {
  question?: string
  image?: string | null
  chatId?: string | null
}
interface EndpointPatch {
  providerId: string
  baseUrl: string
  apiKey: string
}

interface SettingsPatch {
  llm?: string
  embed?: string
  vision?: string
  residency?: Partial<Record<'llm' | 'embed' | 'vision', Residency>>
  remote?: Partial<Record<'llm' | 'embed' | 'vision', string>>
}

export const API = {
  // paged/filtered/faceted fetch for the Everything board — see
  // server/routes/notes.ts's handleNotes for the query contract.
  async page(params: {
    offset: number
    limit?: number
    type?: string
    source?: string
    q?: string
    collection?: string
    unavailable?: boolean
    sort?: string
  }): Promise<{
    notes: UIItem[]
    total: number
    offset: number
    facets: { types: Record<string, number>; sources: Record<string, number>; unavailable?: number }
    pendingTotal: number
    rev: number
    bootId: string
  }> {
    const qs = new URLSearchParams()
    qs.set('offset', String(params.offset))
    qs.set('limit', String(params.limit ?? 120))
    if (params.type) qs.set('type', params.type)
    if (params.source) qs.set('source', params.source)
    if (params.q) qs.set('q', params.q)
    if (params.collection) qs.set('collection', params.collection)
    if (params.unavailable) qs.set('unavailable', '1')
    if (params.sort) qs.set('sort', params.sort)
    const d = await apiGet<{
      notes: ServerNote[]
      total: number
      offset: number
      facets: { types: Record<string, number>; sources: Record<string, number>; unavailable?: number }
      pendingTotal: number
      rev: number
      bootId: string
    }>(`/api/notes?${qs}`)
    return { ...d, notes: (d.notes || []).map(mapNote) }
  },
  // "what changed since rev X" — replaces refetching loaded pages on a timer.
  // A mismatched boot (server restarted) or a since predating the server's
  // tombstone window comes back as { resync: true } instead of a delta.
  async delta(
    since: number,
    boot: string,
  ): Promise<{
    resync?: boolean
    rev: number
    bootId: string
    pendingTotal: number
    notes?: ServerNote[]
    deleted?: string[]
  }> {
    return apiGet(`/api/notes/delta?since=${since}&boot=${encodeURIComponent(boot)}`)
  },
  async save(payload: SavePayload): Promise<{ note: UIItem; aiClassified: boolean }> {
    const d = await apiPost<{ note: ServerNote; aiClassified: boolean }>('/api/save', payload)
    return { note: mapNote(d.note), aiClassified: d.aiClassified }
  },
  // `signal` backs the composer's stop button. It abandons the response, not
  // the generation: the server finishes the answer and records it to the chat
  // either way, so a stopped question still shows up in history.
  async ask(payload: AskPayload, signal?: AbortSignal): Promise<{ answer: string; cited: UIItem[]; chatId: string }> {
    const d = await apiPost<{ answer: string; sources?: ServerNote[]; chatId: string }>('/api/ask', payload, signal)
    return { answer: d.answer, cited: (d.sources || []).map(mapNote), chatId: d.chatId }
  },
  // Streaming ask. Resolves once the answer is complete; the text arrives via
  // onDelta in the meantime. Falls back to the plain JSON shape whenever the
  // server answers with JSON instead of a stream — which it still does for the
  // empty-vault and image paths, and for any error raised before the stream
  // opens.
  async askStream(
    payload: AskPayload,
    on: { onSources?: (cited: UIItem[]) => void; onDelta?: (text: string) => void },
    signal?: AbortSignal,
  ): Promise<{ chatId: string }> {
    const r = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(payload),
      signal,
    })
    if (!r.ok || !r.body || !/text\/event-stream/.test(r.headers.get('content-type') || '')) {
      const d = await _json<{ answer: string; sources?: ServerNote[]; chatId: string }>(r)
      on.onSources?.((d.sources || []).map(mapNote))
      if (d.answer) on.onDelta?.(d.answer)
      return { chatId: d.chatId }
    }
    const reader = r.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    let chatId = ''
    let failure: { error?: string; code?: string } | null = null
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      // Frames are \n\n-delimited and a chunk can split one anywhere, so only
      // whole frames are consumed and the remainder stays buffered.
      for (let cut = buf.indexOf('\n\n'); cut >= 0; cut = buf.indexOf('\n\n')) {
        const frame = buf.slice(0, cut)
        buf = buf.slice(cut + 2)
        const event = /^event: (.*)$/m.exec(frame)?.[1]
        const raw = /^data: (.*)$/m.exec(frame)?.[1]
        if (!event || raw == null) continue
        let d: { sources?: ServerNote[]; text?: string; chatId?: string; error?: string; code?: string }
        try {
          d = JSON.parse(raw)
        } catch {
          continue
        }
        if (event === 'sources') on.onSources?.((d.sources || []).map(mapNote))
        else if (event === 'delta') {
          if (d.text) on.onDelta?.(d.text)
        } else if (event === 'done') chatId = d.chatId || ''
        else if (event === 'error') failure = d
      }
    }
    if (failure) {
      const e = new Error(failure.error || 'Ask failed') as Error & { code?: string }
      e.code = failure.code
      throw e
    }
    return { chatId }
  },
  async renameChat(id: string, title: string): Promise<{ id: string; title: string; updatedAt: string }> {
    const d = await apiPatch<{ chat: { id: string; title: string; updatedAt: string } }>(
      `/api/chats/${encodeURIComponent(id)}`,
      { title },
    )
    return d.chat
  },
  // One note by id — hydrates a deep-linked expanded tile (/item/<id>), which
  // opens before any pager page exists to look the item up in.
  async note(id: string): Promise<UIItem> {
    const d = await apiGet<{ note: ServerNote }>(`/api/notes/${encodeURIComponent(id)}`)
    return mapNote(d.note)
  },
  async del(id: string): Promise<void> {
    await apiDel(`/api/notes/${id}`)
  },
  // patch user-editable fields (tags + free-form mind note) of a saved item
  async update(id: string, patch: { tags?: string[]; mindNote?: string }): Promise<UIItem> {
    const d = await apiPatch<{ note: ServerNote }>(`/api/notes/${id}`, patch)
    return mapNote(d.note)
  },
  // Ask the server to fetch this Instagram post's carousel slides. Lazy by
  // design (see queueIgSlides): the expanded view calls it on open, and the
  // answer is the note either way — deck-less if it was a single image.
  async slides(id: string): Promise<UIItem> {
    const d = await apiPost<{ note: ServerNote }>(`/api/notes/${encodeURIComponent(id)}/slides`)
    return mapNote(d.note)
  },
  // force a full re-classify of one item, discarding its current tags
  async retag(id: string): Promise<UIItem> {
    const d = await apiPost<{ note: ServerNote }>(`/api/notes/${id}/retag`)
    return mapNote(d.note)
  },
  // chat history: list, load one (sources mapped into UI items), delete
  // Paged: the Ask page shows a first screenful and fetches the rest only when
  // the reader asks for it. `total` is what tells the list whether there is
  // anything left to load.
  async chats(limit = 8, offset = 0): Promise<{ chats: ChatSummary[]; total: number }> {
    const d = await apiGet<{ chats?: ChatSummary[]; total?: number }>(`/api/chats?offset=${offset}&limit=${limit}`)
    return { chats: d.chats || [], total: d.total ?? (d.chats || []).length }
  },
  async chat(id: string): Promise<Chat> {
    const d = await apiGet<{ chat: Chat }>(`/api/chats/${id}`)
    const messages: ChatMessage[] = (d.chat.messages || []).map(m =>
      m.role === 'ai' ? { ...m, cited: (m.sources || []).map(mapNote) } : m,
    )
    return { ...d.chat, messages }
  },
  async delChat(id: string): Promise<void> {
    await apiDel(`/api/chats/${id}`)
  },
  // model settings
  async settings(): Promise<SettingsResponse> {
    return apiGet<SettingsResponse>('/api/settings')
  },
  async saveSettings(patch: SettingsPatch): Promise<{ ok: boolean; current: SettingsPatch }> {
    return apiPost('/api/settings', patch)
  },
  // telegram capture
  telegram: (): Promise<TelegramState> => apiGet<TelegramState>('/api/telegram'),
  saveTelegram: (botToken: string): Promise<TelegramState> => apiPost<TelegramState>('/api/telegram', { botToken }),
  clearTelegram: (): Promise<TelegramState> => apiDel<TelegramState>('/api/telegram'),
  // capture token — the response to create is the only one that carries it
  captureToken: (): Promise<CaptureTokenState> => apiGet<CaptureTokenState>('/api/capture-token'),
  createCaptureToken: (): Promise<CaptureTokenState> => apiPost<CaptureTokenState>('/api/capture-token'),
  clearCaptureToken: (): Promise<CaptureTokenState> => apiDel<CaptureTokenState>('/api/capture-token'),
  // first-run: commit the chosen models and kick off their initial download
  // Throws if the endpoint refuses the key; providerId lets it check one /models would take from anyone.
  async checkEndpoint(providerId: string, baseUrl: string, apiKey: string): Promise<void> {
    const r = await apiPost<{ ok: boolean; error?: string }>('/api/setup/test', { providerId, baseUrl, apiKey })
    if (!r.ok) throw new Error(r.error || 'Could not reach that service.')
  },
  // Apply an endpoint mid-first-run, BEFORE the model picker is drawn: which
  // provider serves each role decides what that picker has to ask for.
  // `models` are the provider's default ids. They are sent WITH the endpoint
  // because naming an embedding model is what sends that role to the endpoint
  // rather than downloading one — see server/ai/routing.ts.
  async applyEndpoint(
    endpoint: EndpointPatch,
    models?: Partial<Record<'llm' | 'embed' | 'vision', string>>,
  ): Promise<{ ok: boolean }> {
    return apiPost('/api/setup/endpoint', { endpoint, models })
  },
  // Change the endpoint AFTER first run — a rotated key, or a different
  // service. Distinct from applyEndpoint, which only works while first run is
  // still open.
  async saveEndpoint(
    endpoint: EndpointPatch,
    models?: Partial<Record<'llm' | 'embed' | 'vision', string>>,
  ): Promise<{ ok: boolean }> {
    return apiPost('/api/settings/endpoint', { endpoint, models })
  },
  // Forget the credential and take every role back on-device. The endpoint's
  // model names are kept, so reconnecting the same service is one paste.
  async clearEndpoint(models?: Partial<Record<'llm' | 'embed' | 'vision', string>>): Promise<{ ok: boolean }> {
    return apiDel('/api/settings/endpoint', models ? { models } : {})
  },
  async setup(
    patch: (SettingsPatch & { endpoint?: EndpointPatch }) | { skip: true },
  ): Promise<{ ok: boolean; current: SettingsPatch }> {
    return apiPost('/api/setup', patch)
  },
  // downloaded weights on disk, and reclaiming their space. Nothing prunes the
  // cache — see server/routes/models.ts.
  async modelFiles(): Promise<ModelFilesResponse> {
    return apiGet<ModelFilesResponse>('/api/models/files')
  },
  async deleteModelFile(name: string): Promise<{ deleted: string; freedBytes: number }> {
    return apiDel(`/api/models/files/${encodeURIComponent(name)}`)
  },
  async status(): Promise<ModelStatus> {
    return apiGet<ModelStatus>('/api/status')
  },
  // every tag the viewer's library carries, most used first (handleTags)
  async tags(): Promise<{ tag: string; count: number }[]> {
    return (await apiGet<{ tags: { tag: string; count: number }[] }>('/api/tags')).tags
  },
  // enrichment backlog: how many notes the current residency could enrich
  async backlog(): Promise<{ count: number }> {
    return apiGet('/api/enrich/backlog')
  },
  async enrichBacklog(): Promise<{ ok: boolean; queued: number }> {
    return apiPost('/api/enrich/backlog')
  },
  // re-run classify + embed across the whole library (Settings → Re-tag
  // everything). Unlike enrichBacklog this redoes work that already succeeded.
  async retagAll(): Promise<{ ok: boolean; queued: number }> {
    return apiPost('/api/enrich/retag-all')
  },
  // Viewport-priority hint: bump these (visible, thumbless) note ids to the
  // front of the server's Instagram meta queue. Fire-and-forget — a dropped
  // ping just means those notes stay wherever they already were in queue.
  async prioritize(ids: string[]): Promise<void> {
    await apiPost('/api/enrich/prioritize', { ids }).catch(() => {})
  },
  // bulk import (instagram export today; pocket/bookmarks later)
  // `source` names the platform (matching a server importer's `name`) so the
  // route validates against that importer and can say what it expected;
  // `files` carries every file of one export in a single request — an
  // Instagram export is saved_posts.json plus saved_collections.json, and
  // importing them separately used to lose the collections.
  async importFile(payload: { source: string; files: { name: string; data: string }[] }): Promise<{
    importer: string
    imported: number
    skipped: number
    failed: number
    collections: number
    warnings: string[]
  }> {
    return apiPost('/api/import', payload)
  },
  // Availability: scan marks links whose content is gone, remove deletes the
  // marked ones. Two calls on purpose — the scan only writes a reversible flag,
  // and `expected` makes the destructive step refuse if the count moved between
  // the user seeing it and confirming it.
  async scanAvailability(): Promise<{
    checked: number
    dead: number
    alive: number
    unknown: number
    marked: number
    cleared?: number
    unavailable: number
    aborted: boolean
    error?: string
  }> {
    return apiPost('/api/availability/scan', {})
  },
  async removeUnavailable(expected: number): Promise<{ removed: number; unavailable: number }> {
    return apiPost('/api/availability/remove', { expected })
  },
  // danger zone: erase all content (notes, spaces, chats, tags, uploads).
  // Model settings survive — see server/routes/wipe.ts.
  async wipeAll(
    confirm: string,
  ): Promise<{ cleared: { notes: number; collections: number; chats: number; tags: number } }> {
    return apiPost('/api/wipe', { confirm })
  },
}

export const Collections = {
  async list(): Promise<Collection[]> {
    const d = await apiGet<{ collections?: (Collection & { covers?: ServerNote[] })[] }>('/api/collections')
    return (d.collections || []).map(c => ({ ...c, covers: (c.covers || []).map(mapNote) }))
  },
  async create(name: string, tags: string[] = []): Promise<Collection> {
    const d = await apiPost<{ collection: Collection }>('/api/collections', { name, tags })
    return d.collection
  },
  async update(id: string, patch: { name?: string; tags?: string[]; canvas?: CanvasDoc | null }): Promise<Collection> {
    const d = await apiPatch<{ collection: Collection }>(`/api/collections/${id}`, patch)
    return d.collection
  },
  async remove(id: string): Promise<void> {
    await apiDel(`/api/collections/${id}`)
  },
  async addItem(id: string, itemId: string): Promise<Collection> {
    const d = await apiPost<{ collection: Collection }>(`/api/collections/${id}/items`, { itemId })
    return d.collection
  },
  async removeItem(id: string, itemId: string): Promise<Collection> {
    const d = await apiDel<{ collection: Collection }>(`/api/collections/${id}/items/${itemId}`)
    return d.collection
  },
}
