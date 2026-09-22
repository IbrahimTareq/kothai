// One long-poll pass, split out from the loop so the acknowledgement rule can
// be tested without timers or a network.
//
// getUpdates(offset) means "forget everything before offset". So the offset
// advances only past updates whose notes are already persisted: a crash
// re-delivers a capture, which the user can delete, instead of dropping one,
// which they will never know happened.
import type { TelegramUpdate } from './api.ts'

interface PollArgs {
  offset: number
  getUpdates: (offset: number) => Promise<{ ok: true; updates: TelegramUpdate[] } | { ok: false; conflict: boolean }>
  handle: (update: TelegramUpdate) => Promise<void>
}

export async function pollOnce({
  offset,
  getUpdates,
  handle,
}: PollArgs): Promise<{ offset: number; conflict: boolean; failed: boolean }> {
  const res = await getUpdates(offset)
  if (!res.ok) return { offset, conflict: res.conflict, failed: true }

  let next = offset
  for (const update of res.updates) {
    try {
      await handle(update)
    } catch (e) {
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

// Started at boot when a token exists. Runs until the process ends or Telegram
// reports a conflict.
export function startPolling(run: () => Promise<{ conflict: boolean; failed: boolean }>): void {
  let failures = 0
  const tick = async () => {
    const { conflict, failed } = await run().catch(e => {
      console.error('[telegram] poll pass threw:', e)
      return { conflict: false, failed: true }
    })
    if (conflict) {
      // Another poller (a second container, or a webhook) owns this bot. Two
      // processes racing for every message is worse than none, and no amount
      // of retrying fixes a misconfiguration.
      console.error('[telegram] another poller is using this bot token — capture stopped')
      return
    }
    // Logged on the transition only: a night offline would otherwise write a
    // line per second into the container log.
    if (failed && failures === 0) console.error('[telegram] polling failed, backing off')
    if (!failed && failures > 0) console.log('[telegram] polling recovered')
    const delay = failed ? BACKOFF_MS[Math.min(failures++, BACKOFF_MS.length - 1)] : 0
    if (!failed) failures = 0
    setTimeout(tick, delay).unref()
  }
  void tick()
}
