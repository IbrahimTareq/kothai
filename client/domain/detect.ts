// Client-side type detection for the capture box's "detect chip". The server
// re-classifies authoritatively on save (see server/ai/normalise.ts
// heuristicType).
//
// Only a bare http(s) link is detected — the same test as the server's
// isLikelyUrl. Anything looser ("example.com", a link with words round it)
// would light the chip and enable Save for input the server then refuses.
import type { Detection } from '../types'

export function detectType(raw: string): Detection | null {
  const url = (raw || '').trim()
  if (!/^https?:\/\/\S+$/i.test(url)) return null
  let host = ''
  try {
    host = new URL(url).hostname.replace(/^www\./, '')
  } catch {
    host = url
  }
  if (/(youtube\.com|youtu\.be|vimeo\.com|\.mp4|\.mov|\.webm)/i.test(url)) return { type: 'video', url, host }
  return { type: 'link', url, host }
}
