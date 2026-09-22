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
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
}

type Fetch = typeof fetch
type UpdatesResult = { ok: true; updates: TelegramUpdate[] } | { ok: false; conflict: boolean }

// 409 is singled out because it means something the caller must not retry: a
// second poller (another container, or a webhook) is already consuming this
// bot's updates. Retrying makes two processes fight over every message.
export async function getUpdates(
  token: string,
  offset: number,
  { timeoutSec = 30, fetchImpl = fetch }: { timeoutSec?: number; fetchImpl?: Fetch } = {},
): Promise<UpdatesResult> {
  const res = await fetchImpl(`${API}/bot${token}/getUpdates?offset=${offset}&timeout=${timeoutSec}`)
  if (res.status === 409) return { ok: false, conflict: true }
  if (!res.ok) return { ok: false, conflict: false }
  const body = (await res.json()) as { ok?: boolean; result?: TelegramUpdate[] }
  return body.ok && body.result ? { ok: true, updates: body.result } : { ok: false, conflict: false }
}

// Failure is swallowed: a confirmation that does not arrive is a cosmetic
// problem, and letting it throw would roll back a capture that already saved.
export async function sendMessage(
  token: string,
  chatId: number,
  text: string,
  { fetchImpl = fetch }: { fetchImpl?: Fetch } = {},
): Promise<void> {
  await fetchImpl(`${API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  }).catch(() => {})
}

// Telegram hands out a file_path, not bytes. The data URL shape is dictated by
// lib/http.ts's saveImage, which matches data:image/(png|jpe?g|gif|webp).
export async function fetchPhotoDataUrl(
  token: string,
  fileId: string,
  { fetchImpl = fetch }: { fetchImpl?: Fetch } = {},
): Promise<string | null> {
  const meta = await fetchImpl(`${API}/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`)
  if (!meta.ok) return null
  const body = (await meta.json()) as { result?: { file_path?: string } }
  const filePath = body.result?.file_path
  if (!filePath) return null
  const bin = await fetchImpl(`${API}/file/bot${token}/${filePath}`)
  if (!bin.ok) return null
  const ext = filePath.split('.').pop()?.toLowerCase()
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
  return `data:${mime};base64,${Buffer.from(await bin.arrayBuffer()).toString('base64')}`
}
