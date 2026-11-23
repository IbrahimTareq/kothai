import { ApiRequestError, createClient } from '@kothai/api'

export type SaveOutcome = { kind: 'saved'; title: string } | { kind: 'failed'; code: string; message: string }

// The share sheet hands over a URL, or text that may hold one ("Look at this:
// https://…"). Kothai saves links only, so anything else is refused before any
// request is made. webUrl goes through the same http(s) check as text: another
// app can share a javascript: or data: URL, and it would otherwise be saved.
export function linkFrom(share: { webUrl?: string | null; text?: string | null }): string | null {
  return httpLink(share.webUrl) ?? httpLink(share.text)
}

function httpLink(s: string | null | undefined): string | null {
  const match = s?.match(/https?:\/\/[^\s<>"'\]]+/i)?.[0]
  if (!match) return null
  let url = match
  // Prose wraps links: "See https://a.com/x." and "(see https://a.com)" saved
  // the trailing "." and ")". A ")" stays only when it closes a "(" inside the
  // URL, as in Wikipedia's /wiki/Foo_(bar).
  for (;;) {
    const trimmed = url.replace(/[.,;:!?]+$/, '')
    const unbalanced = trimmed.endsWith(')') && trimmed.split('(').length < trimmed.split(')').length
    const next = unbalanced ? trimmed.slice(0, -1) : trimmed
    if (next === url) return url
    url = next
  }
}

// No outbox yet (plan ruling E2): a failure is shown with a Retry button.
// save is not idempotent, so Retry after a timeout can make a duplicate.
export async function saveLink(
  url: string,
  settings: { baseUrl: string; token?: string },
  fetch: typeof globalThis.fetch,
): Promise<SaveOutcome> {
  try {
    const { note } = await createClient({ ...settings, fetch }).save({ url })
    // A note still being enriched may have no title yet.
    return { kind: 'saved', title: note.title || note.url || url }
  } catch (e) {
    if (e instanceof ApiRequestError) return { kind: 'failed', code: e.code, message: e.message }
    return { kind: 'failed', code: 'unknown', message: String(e) }
  }
}
