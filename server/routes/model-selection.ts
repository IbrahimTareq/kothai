// The model ids a settings request carries, split by the provider that owns
// each role. Split out of routes/settings.ts, past its shape budget; setup,
// disconnect and the settings save all validate through this one function.
import * as ai from '../ai/index.ts'
import { ROLES } from '../ai/roles.ts'
import type { ModelSelection } from '../ai/providers/types.ts'

// A local copy rather than an export from routes/settings.ts: that file
// imports this one, and a three-line guard is not worth an import cycle.
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

// One return shape rather than two, because every caller destructures the
// result and then checks `error` — a union would make the success fields
// unreachable to the checker at exactly the point they are read. The fields
// beside an `error` are what had validated so far; nothing reads them, because
// every caller answers 400 and returns.
interface ValidatedModels {
  error?: string
  local: ModelSelection
  remote: ModelSelection
  warnings: string[]
}

// Validation is provider-specific and now role-by-role: local rejects a key
// that isn't in its preset catalogue, remote accepts any non-empty string and
// only warns about one the endpoint doesn't list, because saving settings must
// not fail whenever the endpoint happens to be down.
//
// A role served on-device reads its key from the body root; a role served
// remotely reads its id from body.remote. In a single-provider install that is
// exactly the old behaviour — all three roles resolve to the same source — and
// on a mixed one it is what keeps an endpoint's model ids out of the on-device
// columns, where nothing would ever read them again.
// Exported for routes/settings.ts; the underscore is from when only the unit
// tests reached it.
export function _validateModels(body: unknown): ValidatedModels {
  const { roles } = ai.capabilities()
  const fields = isRecord(body) ? body : {}
  const remoteFields = isRecord(fields.remote) ? fields.remote : {}
  const local: ModelSelection = {}
  const remote: ModelSelection = {}
  const warnings: string[] = []
  for (const role of ROLES) {
    const isLocal = roles[role] === 'local'
    const key = (isLocal ? fields : remoteFields)[role]
    if (key === undefined) continue
    // A model id that is not a string is rejected here rather than handed on.
    // Both providers already refused it, but only one of them politely: the
    // remote provider's first act is `key.trim()`, so a JSON body carrying a
    // number turned /api/settings into a 500 instead of the 400 it is.
    if (typeof key !== 'string') return { error: `invalid ${role} model`, local, remote, warnings }
    const r = ai.validateModel(role, key)
    if (!r.ok) return { error: r.error, local, remote, warnings }
    if (r.warning) warnings.push(r.warning)
    ;(isLocal ? local : remote)[role] = key
  }
  return { local, remote, warnings }
}
