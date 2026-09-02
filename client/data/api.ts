// Backend bridge — maps a server note (QVAC) into the UI item shape and exposes
// the real /api endpoints. Server types: link/image/video/code/
// text ("text" becomes "note" in the UI).
import type {
  Chat, ChatMessage, ChatSummary, Collection, ModelStatus, Residency, ServerNote, SettingsResponse, UIItem, UIType,
} from '../types'

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

export function mapNote(n: ServerNote): UIItem {
  const ts = Date.parse(n.createdAt) || Date.now()
  const type: UIType = n.type === 'text' ? 'note' : n.type
  const base: UIItem = {
    id: n.id,
    ts,
    type,
    tags: n.tags || [],
    category: n.category,
    summary: n.summary,
    mindNote: n.mindNote || '',
    pending: !!n.pending,
    metaFetched: !!n.metaFetched,
    unavailable: !!n.unavailable,
  }
  switch (type) {
    case 'link':
      return { ...base, url: n.url, host: hostOf(n.url || ''), title: n.siteTitle || n.title, note: n.siteDesc || '', thumb: n.thumb || null, slides: n.slides, siteName: n.siteName || null }
    case 'video':
      return { ...base, url: n.url, host: hostOf(n.url || '') || 'video', title: n.siteTitle || n.title, note: n.siteDesc || '', thumb: n.thumb || null, slides: n.slides, siteName: n.siteName || null }
    case 'image':
      return { ...base, img: n.image, name: n.title || 'image', note: n.pending ? 'analyzing…' : (n.summary || n.description || '') }
    case 'code':
      return { ...base, lang: 'text', text: n.content, title: n.title }
    default:
      return { ...base, text: n.content, title: n.title }
  }
}

// Every request that changes data must carry this. It is not a CORS-safelisted
// content type, so the browser preflights any cross-origin attempt and the
// server rejects anything without it (see server/routes/auth.js) — which is
// what closes the CSRF hole SameSite=Lax leaves open between ports on
// localhost. Harmless when STASH_PASSWORD is unset and the rule is not applied.
const JSON_HEADERS = { 'Content-Type': 'application/json' }

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

interface SavePayload { text?: string; image?: string | null }
interface AskPayload { question?: string; image?: string | null; chatId?: string | null }
interface SettingsPatch {
  llm?: string
  embed?: string
  vision?: string
  residency?: Partial<Record<'llm' | 'embed' | 'vision', Residency>>
  remote?: Partial<Record<'llm' | 'embed' | 'vision', string>>
}

export const API = {
  // paged/filtered/faceted fetch for the Everything board — see
  // server/routes/notes.js's handleNotes for the query contract.
  async page(params: { offset: number; limit?: number; type?: string; source?: string; q?: string; collection?: string; unavailable?: boolean; sort?: string }): Promise<{
    notes: UIItem[]; total: number; offset: number
    facets: { types: Record<string, number>; sources: Record<string, number>; unavailable?: number }
    pendingTotal: number; rev: number; bootId: string
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
    const d = await _json<{
      notes: ServerNote[]; total: number; offset: number
      facets: { types: Record<string, number>; sources: Record<string, number>; unavailable?: number }
      pendingTotal: number; rev: number; bootId: string
    }>(await fetch('/api/notes?' + qs))
    return { ...d, notes: (d.notes || []).map(mapNote) }
  },
  // "what changed since rev X" — replaces refetching loaded pages on a timer.
  // A mismatched boot (server restarted) or a since predating the server's
  // tombstone window comes back as { resync: true } instead of a delta.
  async delta(since: number, boot: string): Promise<
    { resync?: boolean; rev: number; bootId: string; pendingTotal: number; notes?: ServerNote[]; deleted?: string[] }
  > {
    return await _json(await fetch(`/api/notes/delta?since=${since}&boot=${encodeURIComponent(boot)}`))
  },
  async save(payload: SavePayload): Promise<{ note: UIItem; aiClassified: boolean }> {
    const d = await _json<{ note: ServerNote; aiClassified: boolean }>(
      await fetch('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
    )
    return { note: mapNote(d.note), aiClassified: d.aiClassified }
  },
  // `signal` backs the composer's stop button. It abandons the response, not
  // the generation: the server finishes the answer and records it to the chat
  // either way, so a stopped question still shows up in history.
  async ask(payload: AskPayload, signal?: AbortSignal): Promise<{ answer: string; cited: UIItem[]; chatId: string }> {
    const d = await _json<{ answer: string; sources?: ServerNote[]; chatId: string }>(
      await fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal }),
    )
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
        try { d = JSON.parse(raw) } catch { continue }
        if (event === 'sources') on.onSources?.((d.sources || []).map(mapNote))
        else if (event === 'delta') { if (d.text) on.onDelta?.(d.text) }
        else if (event === 'done') chatId = d.chatId || ''
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
    const d = await _json<{ chat: { id: string; title: string; updatedAt: string } }>(
      await fetch('/api/chats/' + encodeURIComponent(id), {
        method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ title }),
      }),
    )
    return d.chat
  },
  // One note by id — hydrates a deep-linked expanded tile (/item/<id>), which
  // opens before any pager page exists to look the item up in.
  async note(id: string): Promise<UIItem> {
    const d = await _json<{ note: ServerNote }>(await fetch('/api/notes/' + encodeURIComponent(id)))
    return mapNote(d.note)
  },
  async del(id: string): Promise<void> {
    await fetch('/api/notes/' + id, { method: 'DELETE', headers: JSON_HEADERS })
  },
  // patch user-editable fields (tags + free-form mind note) of a saved item
  async update(id: string, patch: { tags?: string[]; mindNote?: string }): Promise<UIItem> {
    const d = await _json<{ note: ServerNote }>(
      await fetch('/api/notes/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }),
    )
    return mapNote(d.note)
  },
  // Ask the server to fetch this Instagram post's carousel slides. Lazy by
  // design (see queueIgSlides): the expanded view calls it on open, and the
  // answer is the note either way — deck-less if it was a single image.
  async slides(id: string): Promise<UIItem> {
    const d = await _json<{ note: ServerNote }>(
      await fetch('/api/notes/' + encodeURIComponent(id) + '/slides', { method: 'POST', headers: JSON_HEADERS }),
    )
    return mapNote(d.note)
  },
  // force a full re-classify of one item, discarding its current tags
  async retag(id: string): Promise<UIItem> {
    const d = await _json<{ note: ServerNote }>(
      await fetch('/api/notes/' + id + '/retag', { method: 'POST', headers: JSON_HEADERS }),
    )
    return mapNote(d.note)
  },
  // chat history: list, load one (sources mapped into UI items), delete
  // Paged: the Ask page shows a first screenful and fetches the rest only when
  // the reader asks for it. `total` is what tells the list whether there is
  // anything left to load.
  async chats(limit = 8, offset = 0): Promise<{ chats: ChatSummary[]; total: number }> {
    const d = await _json<{ chats?: ChatSummary[]; total?: number }>(
      await fetch(`/api/chats?offset=${offset}&limit=${limit}`),
    )
    return { chats: d.chats || [], total: d.total ?? (d.chats || []).length }
  },
  async chat(id: string): Promise<Chat> {
    const d = await _json<{ chat: Chat }>(await fetch('/api/chats/' + id))
    const messages: ChatMessage[] = (d.chat.messages || []).map((m) =>
      m.role === 'ai' ? { ...m, cited: (m.sources || []).map(mapNote) } : m,
    )
    return { ...d.chat, messages }
  },
  async delChat(id: string): Promise<void> {
    await fetch('/api/chats/' + id, { method: 'DELETE', headers: JSON_HEADERS })
  },
  // model settings
  async settings(): Promise<SettingsResponse> {
    return await _json<SettingsResponse>(await fetch('/api/settings'))
  },
  async saveSettings(patch: SettingsPatch): Promise<{ ok: boolean; current: SettingsPatch }> {
    return await _json(
      await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }),
    )
  },
  // first-run: commit the chosen models and kick off their initial download
  async setup(patch: SettingsPatch | { skip: true }): Promise<{ ok: boolean; current: SettingsPatch }> {
    return await _json(
      await fetch('/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }),
    )
  },
  async status(): Promise<ModelStatus> {
    return await _json<ModelStatus>(await fetch('/api/status'))
  },
  // enrichment backlog: how many notes the current residency could enrich
  async backlog(): Promise<{ count: number }> {
    return await _json(await fetch('/api/enrich/backlog'))
  },
  async enrichBacklog(): Promise<{ ok: boolean; queued: number }> {
    return await _json(await fetch('/api/enrich/backlog', { method: 'POST', headers: JSON_HEADERS }))
  },
  // re-run classify + embed across the whole library (Settings → Re-tag
  // everything). Unlike enrichBacklog this redoes work that already succeeded.
  async retagAll(): Promise<{ ok: boolean; queued: number }> {
    return await _json(await fetch('/api/enrich/retag-all', { method: 'POST', headers: JSON_HEADERS }))
  },
  // Viewport-priority hint: bump these (visible, thumbless) note ids to the
  // front of the server's Instagram meta queue. Fire-and-forget — a dropped
  // ping just means those notes stay wherever they already were in queue.
  async prioritize(ids: string[]): Promise<void> {
    await fetch('/api/enrich/prioritize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) }).catch(() => {})
  },
  // bulk import (instagram export today; pocket/bookmarks later)
  // `source` names the platform (matching a server importer's `name`) so the
  // route validates against that importer and can say what it expected;
  // `files` carries every file of one export in a single request — an
  // Instagram export is saved_posts.json plus saved_collections.json, and
  // importing them separately used to lose the collections.
  async importFile(payload: { source: string; files: { name: string; data: string }[] }): Promise<{ importer: string; imported: number; skipped: number; failed: number; collections: number; warnings: string[] }> {
    return await _json(
      await fetch('/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
    )
  },
  // Availability: scan marks links whose content is gone, remove deletes the
  // marked ones. Two calls on purpose — the scan only writes a reversible flag,
  // and `expected` makes the destructive step refuse if the count moved between
  // the user seeing it and confirming it.
  async scanAvailability(): Promise<{ checked: number; dead: number; alive: number; unknown: number; marked: number; cleared?: number; unavailable: number; aborted: boolean; error?: string }> {
    return await _json(await fetch('/api/availability/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }))
  },
  async removeUnavailable(expected: number): Promise<{ removed: number; unavailable: number }> {
    return await _json(await fetch('/api/availability/remove', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expected }),
    }))
  },
  // danger zone: erase all content (notes, spaces, chats, tags, uploads).
  // Model settings survive — see server/routes/wipe.js.
  async wipeAll(confirm: string): Promise<{ cleared: { notes: number; collections: number; chats: number; tags: number } }> {
    return await _json(
      await fetch('/api/wipe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm }) }),
    )
  },
}

export const Collections = {
  async list(): Promise<Collection[]> {
    const d = await _json<{ collections?: (Collection & { covers?: ServerNote[] })[] }>(await fetch('/api/collections'))
    return (d.collections || []).map((c) => ({ ...c, covers: (c.covers || []).map(mapNote) }))
  },
  async create(name: string, tags: string[] = []): Promise<Collection> {
    const d = await _json<{ collection: Collection }>(
      await fetch('/api/collections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, tags }) }),
    )
    return d.collection
  },
  async update(id: string, patch: { name?: string; tags?: string[] }): Promise<Collection> {
    const d = await _json<{ collection: Collection }>(
      await fetch('/api/collections/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }),
    )
    return d.collection
  },
  async remove(id: string): Promise<void> {
    await fetch('/api/collections/' + id, { method: 'DELETE', headers: JSON_HEADERS })
  },
  async addItem(id: string, itemId: string): Promise<Collection> {
    const d = await _json<{ collection: Collection }>(
      await fetch('/api/collections/' + id + '/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemId }) }),
    )
    return d.collection
  },
  async removeItem(id: string, itemId: string): Promise<Collection> {
    const d = await _json<{ collection: Collection }>(
      await fetch('/api/collections/' + id + '/items/' + itemId, { method: 'DELETE', headers: JSON_HEADERS }),
    )
    return d.collection
  },
}
