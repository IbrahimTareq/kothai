// The one FIFO every model job runs through — enrichment passes, re-embeds,
// the tag-vocabulary rebuild — so rapid saves never contend for a model.
// Split out of enrich.ts, which sat at its shape cap.
//
// It counts its current run for the Settings Enrichment row. The chain is a
// bare promise, so nothing else can say how much is left: the Gallery's bar
// counts only notes flagged `pending`, and the backlog button and outage
// recovery (recovery.ts) re-queue notes without setting that flag.

let chain: Promise<unknown> = Promise.resolve()
let run = { queued: 0, settled: 0 }

// Also used by the re-embed (reembed.ts) so it can't race in-flight
// enrichment. Returns the chain promise so callers that care when their job
// lands (tests; recovery.ts's dedupe set) can await it — fire-and-forget
// callers just ignore the return value.
export function queueJob(fn: () => unknown): Promise<unknown> {
  run.queued++
  chain = chain
    .then(fn)
    .catch(e => console.error('[enrich] failed:', e instanceof Error ? e.message : e))
    .finally(() => {
      // Reset once idle, so the next burst counts from zero rather than on top
      // of every run since boot.
      if (++run.settled === run.queued) run = { queued: 0, settled: 0 }
    })
  return chain
}

// A failed job counts as done: the queue is finished with it. What it failed
// to fill shows up in the backlog count once the run is idle.
export function queueProgress(): { done: number; total: number } {
  return { done: run.settled, total: run.queued }
}
