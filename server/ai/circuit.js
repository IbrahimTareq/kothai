// Circuit breaker for the remote inference provider.
//
// Pure, with an injected clock so tests never sleep — the same posture as
// RoleManager's injectable timers. Only the remote provider uses this: local
// inference fails per-call, never systemically, so there is nothing to trip.
//
// Failures marked { transient: false } (bad API key, unknown model) open the
// circuit immediately rather than after N tries: retrying cannot fix a
// config error, and each retry against a metered endpoint costs money.

export class Circuit {
  constructor({ threshold = 5, cooldownMs = 60_000, now = Date.now } = {}) {
    this.threshold = threshold
    this.cooldownMs = cooldownMs
    this.now = now
    this.state = 'closed'
    this.consecutive = 0
    this.openedAt = 0
    this.reason = ''
  }

  // True when a call may proceed. Once the cooldown elapses this returns true
  // for a probe while STAYING open — only recordSuccess() closes it, so a
  // still-dead endpoint doesn't get hammered by every queued job at once.
  allow() {
    if (this.state === 'closed') return true
    return this.now() - this.openedAt >= this.cooldownMs
  }

  recordSuccess() {
    this.state = 'closed'
    this.consecutive = 0
    this.reason = ''
  }

  recordFailure({ transient = true, message = '' } = {}) {
    this.consecutive++
    if (message) this.reason = message
    if (!transient || this.consecutive >= this.threshold) {
      this.state = 'open'
      this.openedAt = this.now()
    }
  }
}
