// Time / date / gradient formatting helpers.

const now = Date.now()

// Wall-clock time for a chat message. Absolute rather than relative: a thread
// is read top to bottom, and "2m ago" on every line goes stale the moment the
// tab sits open (relTime's `now` is fixed at import).
export function clockTime(ts: number): string {
  if (!Number.isFinite(ts)) return ''
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function relTime(ts: number): string {
  const diff = now - ts
  if (diff < 0) return 'scheduled'
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return mins + 'm ago'
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return hrs + 'h ago'
  const days = Math.floor(hrs / 24)
  if (days < 7) return days + 'd ago'
  const wks = Math.floor(days / 7)
  if (days < 30) return wks + 'w ago'
  return Math.floor(days / 30) + 'mo ago'
}

// deterministic gradient for image placeholders
export function imgGradient(seed: number): string {
  const h = (seed * 47) % 360
  const h2 = (h + 50) % 360
  return `linear-gradient(135deg, hsl(${h} 40% 22%), hsl(${h2} 45% 10%))`
}
