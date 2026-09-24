// Time / date / gradient formatting helpers.

// Wall-clock time for a chat message. Absolute rather than relative: a thread
// is read top to bottom, and "2m ago" on every line goes stale the moment the
// tab sits open (relTime is only as fresh as the card's last render).
export function clockTime(ts: number): string {
  if (!Number.isFinite(ts)) return ''
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

// Read the clock per call. Taken once at import, it made every link saved
// after the page loaded read "scheduled" until a reload, which on the demo
// looked like a save stuck in processing. Nothing is ever dated ahead, so a
// negative diff is only the server's clock running ahead of this one, and it
// falls through to "just now".
export function relTime(ts: number): string {
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d ago`
  const wks = Math.floor(days / 7)
  if (days < 30) return `${wks}w ago`
  return `${Math.floor(days / 30)}mo ago`
}

// deterministic gradient for image placeholders
export function imgGradient(seed: number): string {
  const h = (seed * 47) % 360
  const h2 = (h + 50) % 360
  return `linear-gradient(135deg, hsl(${h} 40% 22%), hsl(${h2} 45% 10%))`
}
