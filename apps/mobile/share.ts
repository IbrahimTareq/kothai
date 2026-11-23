import { ApiRequestError, createClient } from '@kothai/api'

export type SaveOutcome = { kind: 'saved'; title: string } | { kind: 'failed'; code: string; message: string }

// The share sheet hands over a URL, or text that may hold one ("Look at this:
// https://…"). Kothai saves links only, so anything else is refused before any
// request is made.
export function linkFrom(share: { webUrl?: string | null; text?: string | null }): string | null {
  return share.webUrl || share.text?.match(/https?:\/\/[^\s<>"')\]]+/i)?.[0] || null
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
