// The model ids a settings request carries. Split out of routes/settings.ts,
// past its shape budget; setup and the settings save both validate through
// this one function.
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
  remote: ModelSelection
  warnings: string[]
}

// Any non-empty string is accepted, with only a warning about one the
// endpoint doesn't list, because saving settings must not fail whenever the
// endpoint happens to be down. The ids are read from body.remote.
// Exported for routes/settings.ts; the underscore is from when only the unit
// tests reached it.
export function _validateModels(body: unknown): ValidatedModels {
  const fields = isRecord(body) ? body : {}
  const remoteFields = isRecord(fields.remote) ? fields.remote : {}
  const remote: ModelSelection = {}
  const warnings: string[] = []
  for (const role of ROLES) {
    const key = remoteFields[role]
    if (key === undefined) continue
    // A model id that is not a string is rejected here rather than handed on:
    // the provider's first act is `key.trim()`, so a JSON body carrying a
    // number turned /api/settings into a 500 instead of the 400 it is.
    if (typeof key !== 'string') return { error: `invalid ${role} model`, remote, warnings }
    const r = ai.validateModel(role, key)
    if (!r.ok) return { error: r.error, remote, warnings }
    if (r.warning) warnings.push(r.warning)
    remote[role] = key
  }
  return { remote, warnings }
}
