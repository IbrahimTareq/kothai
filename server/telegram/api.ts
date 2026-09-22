// Telegram Bot API calls.
//
// Long polling rather than webhooks: getUpdates is an OUTBOUND call, so an
// install behind NAT on a tailnet receives captures with no public URL, no
// certificate and no port forward. A webhook would need all three and would
// stop working the moment the tunnel did.
//
// Plain fetch rather than lib/ssrf.ts's safeFetch: that guard exists to stop
// user-supplied URLs reaching private addresses, and every URL here is built
// from a hard-coded api.telegram.org. Routing them through it would imply a
// threat that does not exist here.
const API = 'https://api.telegram.org'

export interface TelegramMessage {
  message_id: number
  chat: { id: number }
  text?: string
  caption?: string
  photo?: { file_id: string; file_size?: number }[]
  // Attachment kinds Kothai does not store. Only their presence is checked —
  // by ingest.ts, to decide whether the bound chat is owed an honest "not
  // saved" reply instead of the file being dropped without a word.
  document?: unknown
  video?: unknown
  voice?: unknown
  video_note?: unknown
  audio?: unknown
  sticker?: unknown
  animation?: unknown
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
}

type UpdatesResult = { ok: true; updates: TelegramUpdate[] } | { ok: false; conflict: boolean }

// Telegram's error body carries a human `description` alongside the numeric
// status. Without it, a revoked token (401 — permanent, the user must
// re-pair) and a 5xx (transient — the next poll will just work) log
// identically, and both just read as "back off forever, nothing to go on."
async function describeError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { description?: unknown } | null
  return typeof body?.description === 'string' ? ` — ${body.description}` : ''
}

// A network-level failure (DNS, timeout, connection reset — and Telegram's
// file_path download URLs do expire) degrades to null here instead of
// throwing. Letting it throw would wedge Task 5's poll loop: that loop
// deliberately does not advance the update offset when handling an update
// throws, so a crash redelivers rather than drops a capture — which means one
// throw on a transient blip gets Telegram redelivering the same update
// forever, and every retry throws again.
//
// getUpdates below is the one caller that does NOT go through this: it calls
// fetch directly, so a network failure there does throw. That's fine there —
// a getUpdates failure happens between updates rather than while handling
// one, so it propagates out of pollOnce and is caught by startPolling's
// `run().catch`, which just counts it as a failed pass and backs off like any
// other, no redelivery loop at risk.
async function fetchOrNull(url: string, init?: RequestInit): Promise<Response | null> {
  try {
    return await fetch(url, init)
  } catch (e) {
    console.error('[telegram] request failed:', e instanceof Error ? e.message : e)
    return null
  }
}

// 409 is singled out because it means something the caller must not retry: a
// second poller (another container, or a webhook) is already consuming this
// bot's updates. Retrying makes two processes fight over every message.
export async function getUpdates(token: string, offset: number, timeoutSec = 30): Promise<UpdatesResult> {
  const res = await fetch(`${API}/bot${token}/getUpdates?offset=${offset}&timeout=${timeoutSec}`)
  // Read once, whatever the status: a 409's body still carries `description`,
  // and re-reading a Response body a second time throws.
  const body = (await res.json().catch(() => null)) as {
    ok?: boolean
    result?: TelegramUpdate[]
    description?: string
  } | null
  if (body?.ok && body.result) return { ok: true, updates: body.result }
  if (res.status === 409) {
    console.error("[telegram] getUpdates: 409 — another poller is already consuming this bot's updates")
    return { ok: false, conflict: true }
  }
  console.error(`[telegram] getUpdates failed: ${res.status}${body?.description ? ` — ${body.description}` : ''}`)
  return { ok: false, conflict: false }
}

// A failed send never throws: the caller (a completed capture, or the
// one-time bind confirmation) has already done its real work, so there is
// nothing here to roll back. It is not always cosmetic, though — the bind
// confirmation is the only channel the user has to learn that pairing
// worked, so a failure is logged rather than swallowed outright. No return
// value: the one thing a caller could do with a `false` is tell the user,
// which is the very channel that just failed.
export async function sendMessage(token: string, chatId: number, text: string): Promise<void> {
  const res = await fetchOrNull(`${API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  })
  if (res && !res.ok) console.error(`[telegram] sendMessage failed: ${res.status}${await describeError(res)}`)
}

// Telegram hands out a file_path, not bytes. The data URL shape is dictated by
// lib/http.ts's saveImage, which matches data:image/(png|jpe?g|gif|webp).
export async function fetchPhotoDataUrl(token: string, fileId: string): Promise<string | null> {
  const meta = await fetchOrNull(`${API}/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`)
  if (!meta) return null
  if (!meta.ok) {
    console.error(`[telegram] getFile failed: ${meta.status}${await describeError(meta)}`)
    return null
  }
  // Like every other parse in this module, a non-JSON 200 (a captive portal,
  // a transparent proxy) degrades to null here rather than throwing — an
  // uncaught throw here would propagate out of ingestUpdate and stall the
  // offset the same way an uncaught network error would.
  const body = (await meta.json().catch(() => null)) as { result?: { file_path?: string } } | null
  const filePath = body?.result?.file_path
  if (!filePath) {
    console.error('[telegram] getFile: response carried no file_path')
    return null
  }
  const bin = await fetchOrNull(`${API}/file/bot${token}/${filePath}`)
  if (!bin) return null
  if (!bin.ok) {
    console.error(`[telegram] photo download failed: ${bin.status}`)
    return null
  }
  // Telegram's compressed `photo` array — the only message shape this client
  // downloads — is always JPEG regardless of the source file's real format.
  // Mapping by the file_path extension instead would silently mislabel a
  // `.gif` (which saveImage's regex also accepts) as JPEG bytes. Revisit if
  // document/sticker support, which can carry other formats, is added.
  return `data:image/jpeg;base64,${Buffer.from(await bin.arrayBuffer()).toString('base64')}`
}
