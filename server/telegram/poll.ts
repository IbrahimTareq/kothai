// One long-poll pass, split out from the loop so the acknowledgement rule can
// be tested without timers or a network.
//
// getUpdates(offset) means "forget everything before offset". So the offset
// advances only past updates whose notes are already persisted: a crash
// re-delivers a capture, which the user can delete, instead of dropping one,
// which they will never know happened.
import type { TelegramUpdate } from './api.ts'

type PollResult = { offset: number; conflict: boolean; failed: boolean }

interface PollArgs {
  offset: number
  getUpdates: (offset: number) => Promise<{ ok: true; updates: TelegramUpdate[] } | { ok: false; conflict: boolean }>
  handle: (update: TelegramUpdate) => Promise<void>
  // Only ever true once startPolling has already retried the update sitting at
  // `offset` through every backoff tier below. A write that can never succeed
  // — not a transient blip — would otherwise retry forever: data/notes.ts's
  // addNote unshifts into the in-memory notes list before the database
  // insert, so a permanently failing insert leaves a phantom record every
  // single pass, unbounded, and blocks every update behind it from ever being
  // processed.
  giveUp?: boolean
}

export async function pollOnce({ offset, getUpdates, handle, giveUp = false }: PollArgs): Promise<PollResult> {
  const res = await getUpdates(offset)
  if (!res.ok) return { offset, conflict: res.conflict, failed: true }

  let next = offset
  for (const update of res.updates) {
    try {
      await handle(update)
    } catch (e) {
      // giveUp only ever applies to the one update this offset was already
      // stuck on (see startPolling) — everything else in the batch still gets
      // the normal stop-and-retry treatment below, so a give-up can't cascade
      // into silently dropping the rest of a backlog in one pass.
      if (giveUp && update.update_id === offset) {
        console.error(`[telegram] update ${update.update_id} failed through every retry — skipping it:`, e)
        next = update.update_id + 1
        continue
      }
      // Stop here rather than skipping ahead: the remaining updates in this
      // batch are still on Telegram's side and will come back next pass.
      console.error('[telegram] handling update failed, will retry:', e)
      return { offset: next, conflict: false, failed: true }
    }
    next = update.update_id + 1
  }
  return { offset: next, conflict: false, failed: false }
}

const BACKOFF_MS = [1_000, 5_000, 15_000, 60_000]

interface BackoffState {
  failures: number
  // The offset a failing pass was stuck at, so a pass stuck somewhere new
  // restarts the ladder instead of inheriting a give-up threshold earned by
  // whatever was stuck before it.
  stuckAt: number | null
}

// One step of the retry ladder: how long to wait before the next pass, and
// the state to judge it by. Split out from startPolling's timer loop so the
// give-up threshold is testable without fake timers — the same reason
// pollOnce above is split from its caller.
export function nextBackoff(state: BackoffState, result: PollResult): { state: BackoffState; delay: number } {
  if (!result.failed) return { state: { failures: 0, stuckAt: null }, delay: 0 }
  const failures = result.offset === state.stuckAt ? state.failures : 0
  return {
    state: { failures: failures + 1, stuckAt: result.offset },
    delay: BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)],
  }
}

// Started at boot when a token exists. Runs until the process ends or Telegram
// reports a conflict.
export function startPolling(run: (giveUp: boolean) => Promise<PollResult>): void {
  let state: BackoffState = { failures: 0, stuckAt: null }
  const tick = async () => {
    // Past the top of BACKOFF_MS means this specific update has already been
    // retried at every tier — it has had its full chance to recover on its
    // own before the next pass gives up on it.
    const giveUp = state.failures >= BACKOFF_MS.length
    const result = await run(giveUp).catch(e => {
      console.error('[telegram] poll pass threw:', e)
      return { conflict: false, failed: true, offset: state.stuckAt ?? 0 }
    })
    if (result.conflict) {
      // Another poller (a second container, or a webhook) owns this bot. Two
      // processes racing for every message is worse than none, and no amount
      // of retrying fixes a misconfiguration.
      console.error('[telegram] another poller is using this bot token — capture stopped')
      return
    }
    // Logged on the transition only: a night offline would otherwise write a
    // line per second into the container log.
    if (result.failed && state.failures === 0) console.error('[telegram] polling failed, backing off')
    if (!result.failed && state.failures > 0) console.log('[telegram] polling recovered')
    const next = nextBackoff(state, result)
    state = next.state
    setTimeout(tick, next.delay).unref()
  }
  void tick()
}
