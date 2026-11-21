// One OpenAI-compatible endpoint as the remote provider sees it: its breaker,
// the model catalogue it serves, and the probe that fills that catalogue.
//
// Split from remote.ts because each role may now name an endpoint of its own.
// Roles sharing a URL and key share one of these, so an outage there is one
// outage for all of them; a role elsewhere has its own, and that endpoint
// going down leaves the others' breakers alone.
import { Circuit } from '../circuit.ts'
import { getJson, TIMEOUTS, RemoteError } from './remote-http.ts'

export interface RemoteEndpoint {
  // '' rather than null for "no endpoint configured". Every read of it is a
  // truthiness check, and one falsy spelling is what keeps the postJson calls
  // behind remote.ts's guard() from having to re-prove it is a string.
  baseUrl: string
  apiKey: string | null
  embeddingsPath?: string
}

// Everything below the transport arrives as `unknown`: getJson hands back
// whatever the endpoint sent. Local rather than shared, as in remote.ts:
// server/lib/ is the security floor and a guard added there needs a test that
// fails without it (CLAUDE.md).
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

// The `{ data: [{ id }] }` list both /models and the embeddings catalogue
// answer with. A non-object row or a non-string id reads as absent rather than
// being trusted into the catalogue the settings UI offers.
function modelIds(payload: unknown): string[] {
  const data = isRecord(payload) ? payload.data : null
  if (!Array.isArray(data)) return []
  const ids: string[] = []
  for (const row of data) {
    const id = isRecord(row) ? row.id : null
    if (typeof id === 'string' && id) ids.push(id)
  }
  return ids
}

export function createEndpoint({ baseUrl, apiKey, embeddingsPath = '' }: RemoteEndpoint, onRecover?: () => void) {
  const circuit = new Circuit({ threshold: 5, cooldownMs: 60_000, onRecover })
  const state = {
    baseUrl,
    apiKey,
    circuit,
    catalogue: [] as string[],
    // Some providers keep their embedding models out of /models entirely —
    // OpenRouter lists hundreds of chat models there and not one embedding,
    // and serves the real list from a path of its own. When the catalogue
    // entry names that path, the embedding role gets its own list; otherwise
    // it shares the one catalogue, which is what every other provider needs.
    embedCatalogue: [] as string[],
    probeError: '',

    recordSuccess() {
      circuit.recordSuccess()
      if (state.probeError) state.probeError = ''
    },

    // One probe, best-effort. A failure here is reported in the status
    // aggregate but never throws — the app must still serve notes when the
    // inference endpoint is down.
    async probe() {
      try {
        // retries:0 — a probe is a question about right now, and something is
        // waiting on the answer (boot, or the wizard's Test connection button).
        const res = await getJson(baseUrl, '/models', { apiKey, timeoutMs: TIMEOUTS.probe, retries: 0 })
        state.catalogue = modelIds(res)
        state.recordSuccess()
        // Best-effort and deliberately after the success bookkeeping above: a
        // provider that answers /models is up, and failing to fetch a nicety
        // must not mark it down or cost the chat roles anything.
        if (embeddingsPath) {
          try {
            const em = await getJson(baseUrl, embeddingsPath, { apiKey, timeoutMs: TIMEOUTS.probe, retries: 0 })
            state.embedCatalogue = modelIds(em)
          } catch {
            state.embedCatalogue = []
          }
        }
      } catch (e) {
        // `e.transient !== false` was the old read, and it has to survive the
        // narrowing: a failure that is NOT a RemoteError carried no transient
        // flag, `undefined !== false` was true, and treating an unclassified
        // probe failure as transient is what keeps it from opening the circuit
        // on the first try.
        const remote = e instanceof RemoteError ? e : null
        state.probeError = e instanceof Error ? e.message : String(e)
        circuit.recordFailure({
          transient: remote?.transient !== false,
          message: state.probeError,
          retryAfterMs: remote?.retryAfterMs || 0,
        })
      }
    },
  }
  return state
}

export type Endpoint = ReturnType<typeof createEndpoint>
