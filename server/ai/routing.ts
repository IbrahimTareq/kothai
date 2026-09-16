// Which provider serves which role, and how N providers' outputs merge back
// into the single shapes routes and the client already consume.
//
// Pure by design: no imports beyond ROLES, so every branch is unit-testable
// without a provider, an endpoint or @qvac/sdk. server/ai/index.ts is the
// only caller.
import { ROLES } from './roles.ts'
import type { Role, RoleStatus } from './roles.ts'

export type ProviderKind = 'local' | 'remote'
// Who serves each role, right now. The single shape every merge below reads.
export type RoleProviders = Record<Role, ProviderKind>

// A lookup keyed by provider kind that is only populated for the kinds
// actually in use: ai/index.js builds each of these by walking
// kindsInUse(byRole), so a pure-local install has no `remote` entry at all.
// Deliberately not Record<ProviderKind, T> for that reason — every read below
// is keyed off the same kindsInUse() list that filled it.
type ByKind<T> = Record<string, T>

// The single progress/fault signal the client's status bar renders. Each
// provider derives its own (see providers/local.js's computeAggregate and
// remote.js's circuit check); mergeStatus picks between them rather than
// re-deriving one.
export interface Aggregate {
  state: 'ready' | 'loading' | 'error'
  progress: number
  message: string
}

export interface ProviderStatus {
  roles: Record<Role, RoleStatus>
  aggregate: Aggregate
}

export interface Capabilities {
  kind: string
  managesResidency: boolean
  downloadsWeights: boolean
}

export interface RoutedCapabilities extends Capabilities {
  roles: RoleProviders
}

export interface RoleProviderInput {
  provider: string
  embedProvider?: string | null
  localAvailable?: boolean
  remoteEmbedModel?: string
}

// The rule, in one place:
//   provider=local                       → every role on-device (unchanged).
//   provider=remote, no local provider   → every role remote (the lite image,
//                                          where @qvac/sdk isn't installed).
//   provider=remote, local available     → embedding follows whether an
//                                          endpoint embedding model is named;
//                                          language and vision always go out.
//
// Embedding is the role singled out because plenty of hosted endpoints cannot
// serve it at all — Ollama Cloud, Groq and Anthropic expose no
// /embeddings — while its model is small enough (~300 MB, CPU-only) to keep
// here when they cannot. But plenty of others serve it fine, OpenAI included,
// and for those a local download is 300 MB and a re-index bought for nothing:
// if the language role already goes to that endpoint, the note text is already
// leaving, so the embedding role leaks nothing new.
//
// The signal is the model NAME, not a separate switch. Naming a model the
// endpoint serves is the opt-in, and clearing it is the opt-out — which also
// means an install that predates this carries no name and resolves exactly as
// it did before, with no surprise re-index on upgrade.
//
// STASH_AI_EMBED_PROVIDER still wins over both, in either direction: an
// operator who pinned it did so for a reason.
export function resolveRoleProviders({
  provider,
  embedProvider = null,
  localAvailable = false,
  remoteEmbedModel = '',
}: RoleProviderInput): RoleProviders {
  if (provider !== 'remote') return { llm: 'local', embed: 'local', vision: 'local' }
  let embed: ProviderKind
  if (!localAvailable) embed = 'remote'
  else if (embedProvider === 'remote') embed = 'remote'
  else if (embedProvider === 'local') embed = 'local'
  else embed = String(remoteEmbedModel || '').trim() ? 'remote' : 'local'
  return { llm: 'remote', embed, vision: 'remote' }
}

// Distinct provider kinds a role map needs, so the facade initialises exactly
// the providers it will use and no more.
export function kindsInUse(byRole: RoleProviders): ProviderKind[] {
  return [...new Set(ROLES.map(role => byRole[role]))]
}

// Each merge below short-circuits when one kind is in use: pure-local and
// pure-remote installs get their provider's own object back, byte for byte,
// so this whole file is dead weight for them and cannot regress them.
// mergeCapabilities is an exception: it always spreads to attach roles.

export function mergeStatus(byRole: RoleProviders, snapshots: ByKind<ProviderStatus>): ProviderStatus {
  const kinds = kindsInUse(byRole)
  if (kinds.length === 1) return snapshots[kinds[0]]

  // Seeded by spreading one provider's map rather than starting from {} —
  // every value is replaced by the loop, but the spread is what makes the
  // result carry all three roles by construction. Same reason
  // roles.ts's resolveResidency() spreads a base map before overwriting it.
  const roles: Record<Role, RoleStatus> = { ...snapshots[kinds[0]].roles }
  for (const role of ROLES) roles[role] = snapshots[byRole[role]].roles[role]

  // Severity comes from each provider's OWN aggregate rather than being
  // re-derived here: local gates a fault on the role's residency (an ondemand
  // role retries on next acquire) and remote gates it on its circuit breaker,
  // and neither rule is recoverable from the role states alone.
  const aggregates = kinds.map(kind => snapshots[kind].aggregate)
  const errored = aggregates.find(a => a.state === 'error')
  if (errored) return { roles, aggregate: errored }
  const loading = aggregates.filter(a => a.state === 'loading')
  if (loading.length) {
    const progress = Math.round(loading.reduce((sum, a) => sum + (a.progress || 0), 0) / loading.length)
    return { roles, aggregate: { state: 'loading', progress, message: loading[0].message || '' } }
  }
  return { roles, aggregate: { state: 'ready', progress: 100, message: 'Ready' } }
}

export function mergeListModels<T>(byRole: RoleProviders, lists: ByKind<Record<Role, T[]>>): Record<Role, T[]> {
  const kinds = kindsInUse(byRole)
  if (kinds.length === 1) return lists[kinds[0]]
  const out: Record<Role, T[]> = { ...lists[kinds[0]] }
  for (const role of ROLES) out[role] = lists[byRole[role]][role]
  return out
}

// `roles` is attached in every mode, single or mixed, so the client has one
// way to ask who serves a role instead of inferring it from `kind`.
export function mergeCapabilities(byRole: RoleProviders, caps: ByKind<Capabilities>): RoutedCapabilities {
  const kinds = kindsInUse(byRole)
  const hasLocal = ROLES.some(role => byRole[role] === 'local')
  const base =
    kinds.length === 1
      ? caps[kinds[0]]
      : {
          kind: 'mixed',
          // True when ANY role is local: the residency panel and the model-cache
          // row both exist as soon as one role has weights on disk.
          managesResidency: hasLocal,
          downloadsWeights: hasLocal,
        }
  return { ...base, roles: { ...byRole } }
}
