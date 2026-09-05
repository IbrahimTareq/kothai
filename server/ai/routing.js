// Which provider serves which role, and how N providers' outputs merge back
// into the single shapes routes and the client already consume.
//
// Pure by design: no imports beyond ROLES, so every branch is unit-testable
// without a provider, an endpoint or @qvac/sdk. server/ai/index.js is the
// only caller.
import { ROLES } from './roles.js'

// The rule, in one place:
//   provider=local                       → every role on-device (unchanged).
//   provider=remote, no local provider   → every role remote (the lite image,
//                                          where @qvac/sdk isn't installed).
//   provider=remote, local available     → embedding stays on-device, the
//                                          language and vision roles go out.
//
// Embedding is the role singled out because it is the one a hosted endpoint
// frequently cannot serve at all — Ollama Cloud, Groq, Anthropic and
// OpenRouter expose no /embeddings — and the one whose model is small enough
// (~300 MB, CPU-only) to keep here regardless. STASH_AI_EMBED_PROVIDER=remote
// opts back into sending it out, for endpoints that do serve embeddings and
// installs that already have an index built that way.
export function resolveRoleProviders({ provider, embedProvider = null, localAvailable = false }) {
  if (provider !== 'remote') return { llm: 'local', embed: 'local', vision: 'local' }
  const embed = !localAvailable || embedProvider === 'remote' ? 'remote' : 'local'
  return { llm: 'remote', embed, vision: 'remote' }
}

// Distinct provider kinds a role map needs, so the facade initialises exactly
// the providers it will use and no more.
export function kindsInUse(byRole) {
  return [...new Set(ROLES.map((role) => byRole[role]))]
}

// Each merge below short-circuits when one kind is in use: pure-local and
// pure-remote installs get their provider's own object back, byte for byte,
// so this whole file is dead weight for them and cannot regress them.

export function mergeStatus(byRole, snapshots) {
  const kinds = kindsInUse(byRole)
  if (kinds.length === 1) return snapshots[kinds[0]]

  const roles = {}
  for (const role of ROLES) roles[role] = snapshots[byRole[role]].roles[role]

  // Same precedence local's own computeAggregate uses: a fault anywhere wins,
  // then a load in progress, then ready. Every role off is AI-free mode, which
  // is ready — not an error.
  const anyOn = ROLES.some((role) => roles[role].state !== 'off')
  const errored = ROLES.find((role) => roles[role].state === 'error')
  const loading = ROLES.find((role) => roles[role].state === 'loading')
  if (anyOn && errored) {
    return { roles, aggregate: { state: 'error', progress: 0, message: roles[errored].message || 'Inference unavailable' } }
  }
  if (loading) {
    return { roles, aggregate: { state: 'loading', progress: roles[loading].progress || 0, message: roles[loading].message || '' } }
  }
  return { roles, aggregate: { state: 'ready', progress: 100, message: 'Ready' } }
}

export function mergeListModels(byRole, lists) {
  const kinds = kindsInUse(byRole)
  if (kinds.length === 1) return lists[kinds[0]]
  const out = {}
  for (const role of ROLES) out[role] = lists[byRole[role]][role]
  return out
}

// `roles` is attached in every mode, single or mixed, so the client has one
// way to ask who serves a role instead of inferring it from `kind`.
export function mergeCapabilities(byRole, caps) {
  const kinds = kindsInUse(byRole)
  const base = kinds.length === 1
    ? caps[kinds[0]]
    : {
        kind: 'mixed',
        // True when ANY role is local: the residency panel and the model-cache
        // row both exist as soon as one role has weights on disk.
        managesResidency: ROLES.some((role) => byRole[role] === 'local'),
        downloadsWeights: ROLES.some((role) => byRole[role] === 'local'),
      }
  return { ...base, roles: { ...byRole } }
}
