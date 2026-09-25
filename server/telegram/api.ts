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
  // Attachment kinds Kothai does not store. Only their presence is checked —
  // by ingest.ts, to decide whether the bound chat is owed an honest "not
  // saved" reply instead of the file being dropped without a word.
  photo?: unknown
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
//
// `signal` is how a reconnect from Settings ends the old loop: the long poll
// in flight holds its connection for up to `timeoutSec`, and the new loop's
// first getUpdates on the same token would otherwise collide with it and
// earn a 409.
export async function getUpdates(
  token: string,
  offset: number,
  timeoutSec = 30,
  signal?: AbortSignal,
): Promise<UpdatesResult> {
  const res = await fetch(`${API}/bot${token}/getUpdates?offset=${offset}&timeout=${timeoutSec}`, { signal })
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

// Asked once, when Settings saves a token. A mistyped or revoked token used to
// be accepted without a word: Settings showed a pairing code, the poll loop
// logged a 401 into the container, and the code sent to the bot was met with
// the silence ingest.ts gives a wrong code. The username it answers with is
// what Settings needs to name the bot and link straight to its chat.
export async function getMe(token: string): Promise<{ ok: true; username: string } | { ok: false; error: string }> {
  const res = await fetchOrNull(`${API}/bot${token}/getMe`)
  if (!res) return { ok: false, error: 'Could not reach Telegram — check the server can get online.' }
  const body = (await res.json().catch(() => null)) as {
    ok?: boolean
    result?: { username?: unknown }
    description?: unknown
  } | null
  if (body?.ok && typeof body.result?.username === 'string') return { ok: true, username: body.result.username }
  // 401 for a well-formed token Telegram has revoked or never issued, 404 for
  // one that isn't token-shaped at all — to the person pasting it, the same.
  if (res.status === 401 || res.status === 404) return { ok: false, error: 'Telegram did not recognise that token.' }
  const detail = typeof body?.description === 'string' ? ` — ${body.description}` : ''
  return { ok: false, error: `Telegram refused the token: ${res.status}${detail}` }
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
