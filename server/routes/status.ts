// GET /api/status, and the first-run gate it reports. Split out of
// routes/settings.ts, which had grown past its shape budget: the gate is read
// by the setup routes there too, but it depends on nothing in that file.
import * as ai from '../ai/index.ts'
import * as store from '../data/notes.ts'
import * as settings from '../data/settings.ts'
import { json } from '../lib/http.ts'
import { demoLimits, visibleTo } from './demo.ts'
import type { ServerResponse } from 'node:http'
import type { Capabilities } from '../ai/routing.ts'

// A provider with nothing to download has nothing to CONSENT to — but it still
// needs one model name per role before any role can run, and on a pure-remote
// install collecting those names is the only thing first-run has left to do.
// Skipping the screen there dropped people into the app with every role dark
// and no signpost but Settings.
//
// `preGate` is the one concession: an install configured before this gate
// existed has names and no flag, and must not be dragged back through first
// run. It is decided once when settings load (server/data/settings.ts) rather
// than inferred here from whether names exist — because first run now WRITES
// names partway through. The wizard seeds them so the embedding role can
// resolve before the picker is drawn, and inferring from them meant the server
// called first run finished the moment a provider was connected, then answered
// "already configured" when the user pressed Save & start.
// Exported for the setup routes in routes/settings.ts, and the unit tests.
export function firstRunComplete(
  caps: Pick<Capabilities, 'downloadsWeights'>,
  configured: boolean,
  preGate: boolean,
): boolean {
  if (caps.downloadsWeights) return configured
  return configured || preGate
}

// `viewer` is the demo visitor (routes/demo.ts), null on an ordinary install.
export function handleStatus(res: ServerResponse, viewer: string | null): void {
  const caps = ai.capabilities()
  json(res, 200, {
    ...ai.statusSnapshot(),
    configured: firstRunComplete(caps, settings.isConfigured(), settings.isPreGate()),
    count: store.allNotes().filter(visibleTo(viewer)).length,
    capabilities: caps,
    // Polled every few seconds, so the demo banner's allowance stays current.
    demo: viewer ? demoLimits.leftFor(viewer) : null,
  })
}
