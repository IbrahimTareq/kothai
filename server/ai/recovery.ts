// Re-runs the model pass an endpoint outage cost, once the endpoint is back.
// Imported for its side effect by server/index.ts; it exports nothing.
//
// A note enriched while the endpoint was down (out of credits, timing out)
// keeps its heuristic title and no embedding. Its classify and embed markers
// stay unset, but enrichNote clears `pending` regardless, so the boot sweep
// never looks at it again — before this, only the Settings backlog button
// retried it, and only if someone noticed the count.
//
// Narrower than that button (enrich.queueBacklog) on two counts. A pending note
// is skipped: its own pass is still ahead of it, queued or waiting on its
// Instagram fetch. A note owed only a thumbnail description is skipped too —
// the hours-long vision stall stepsFor's comment refuses to start unasked.
//
// Registered on the remote singleton directly rather than through the facade:
// only an endpoint has a circuit to recover (see circuit.ts), and a facade
// export for one caller would cost the export budget a statement.
import * as store from '../data/notes.ts'
import * as settings from '../data/settings.ts'
import { stepsFor } from './backlog.ts'
import { queueEnrich } from './enrich.ts'
import { remoteProvider } from './providers/remote-singleton.ts'

// Ids queued here whose job has not finished. A circuit that flaps recovers
// more than once, and each recovery would otherwise queue the whole set again
// behind the copies still waiting their turn.
const queued = new Set<string>()

remoteProvider.onRecover(() => {
  const residency = settings.getResidency()
  const todo = store
    .allNotes()
    .filter(n => !n.pending && !queued.has(n.id) && stepsFor(n, residency).some(s => s !== 'thumbVision'))
  for (const n of todo) {
    queued.add(n.id)
    queueEnrich(n.id, n.content).finally(() => queued.delete(n.id))
  }
  if (todo.length) console.log(`[enrich] inference endpoint recovered — re-queued ${todo.length} notes`)
})
