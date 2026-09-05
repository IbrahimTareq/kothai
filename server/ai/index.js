// Inference facade — the single module the rest of the app imports.
//
// Each role (llm / embed / vision) is routed to a provider at boot, resolved
// via dynamic import(). That dynamic import is load-bearing, not stylistic:
// it is what keeps @qvac/sdk off the code path in the lite image, where the
// package is not installed at all. A static
// `import ... from './providers/local.js'` here would make the lite build
// crash at startup.
//
// Sync accessors (capabilities, statusSnapshot, roleEnabled) delegate to the
// provider that owns the role and throw if called before initProvider(). That
// is safe because server/index.js awaits initProvider() before the HTTP server
// listens, so no request can arrive first.
import { AI_PROVIDER, AI_EMBED_PROVIDER } from '../config.js'
import { ROLES } from './roles.js'
import { resolveRoleProviders, kindsInUse, mergeStatus, mergeListModels, mergeCapabilities } from './routing.js'

export { FeatureDisabledError } from './roles.js'
export { PRESETS, DEFAULTS } from './presets.js'
export { normaliseClassification, isJunkTag, heuristicType, deriveTitle, isLikelyUrl, extractUrl } from './normalise.js'

// { local?, remote? } — only the kinds the role map actually uses.
let impls = null
// { llm, embed, vision } → provider kind.
let byRole = null

function ready() {
  if (!impls) throw new Error('AI provider not initialised — initProvider() must run before this call')
}

// The provider that owns a role. Every inference call goes through here.
function R(role) {
  ready()
  return impls[byRole[role]]
}

// Calls that are not role-specific (boot, residency, weights) go to the local
// provider when there is one, because every one of them is about weights on
// disk. A pure-remote install has none and they no-op.
function L() {
  ready()
  return impls.local || null
}

export async function _selectProvider(kind, load = null) {
  if (kind === 'remote') return await (load ? load() : import('./providers/remote.js'))
  try {
    return await (load ? load() : import('./providers/local.js'))
  } catch (e) {
    if (e?.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error(
        'STASH_AI_PROVIDER=local but @qvac/sdk is not installed. This is the lite image — ' +
          'set STASH_AI_PROVIDER=remote and STASH_AI_BASE_URL to point at an OpenAI-compatible endpoint.',
      )
    }
    throw e
  }
}

// Can this image serve a role on-device? The lite image cannot: @qvac/sdk is
// not installed and the import throws ERR_MODULE_NOT_FOUND. A full image whose
// native binding won't load on this host (no AVX2, glibc mismatch) is the same
// answer arrived at the hard way — and killing boot over it would strand the
// operator who set STASH_AI_PROVIDER=remote precisely to escape that, so it
// degrades to all-remote rather than throwing. A genuinely local install never
// reaches here: _selectProvider still fails loudly for it.
export async function _localAvailable(load = null) {
  try {
    await (load ? load() : import('./providers/local.js'))
    return true
  } catch (e) {
    if (e?.code !== 'ERR_MODULE_NOT_FOUND') {
      console.error('[ai] on-device provider unusable, serving every role remotely:', e.message)
    }
    return false
  }
}

export function _reset() {
  impls = null
  byRole = null
}

// `opts` exists for tests: `load(kind)` swaps in fakes, and the two resolution
// inputs can be pinned without touching process.env.
export async function initProvider(kind = AI_PROVIDER, current = {}, opts = {}) {
  if (impls) return impls
  const { load = null, embedProvider = AI_EMBED_PROVIDER } = opts
  // Probe only when the answer can change the outcome: resolveRoleProviders
  // ignores localAvailable when the embedding role is pinned remote, and
  // loading the whole on-device stack into a process that will never call it
  // is pure cost — and, on a host where the native binding is broken, risk.
  const needsProbe = kind === 'remote' && embedProvider !== 'remote'
  const localAvailable = opts.localAvailable ?? (needsProbe ? await _localAvailable(load ? () => load('local') : null) : kind !== 'remote')
  const roles = resolveRoleProviders({ provider: kind, embedProvider, localAvailable })

  // Built into a local and published only once every provider is up. Assigning
  // impls before the loop would let a throw halfway through leave a truthy
  // half-built map: ready() would pass, and the retry would short-circuit on
  // the guard above and hand out a provider that never initialised.
  const next = {}
  for (const k of kindsInUse(roles)) {
    next[k] = await _selectProvider(k, load ? () => load(k) : null)
    await next[k].init(current)
  }
  byRole = roles
  impls = next
  return impls
}

// ---- provider-wide, merged ------------------------------------------------
export function capabilities() {
  ready()
  const caps = {}
  for (const k of kindsInUse(byRole)) caps[k] = impls[k].capabilities()
  return mergeCapabilities(byRole, caps)
}

export function statusSnapshot() {
  ready()
  const snapshots = {}
  for (const k of kindsInUse(byRole)) snapshots[k] = impls[k].statusSnapshot()
  return mergeStatus(byRole, snapshots)
}

export async function listModels() {
  ready()
  const lists = {}
  for (const k of kindsInUse(byRole)) lists[k] = await impls[k].listModels()
  return mergeListModels(byRole, lists)
}

// Every provider in use must be reachable for the app to claim availability.
export function available() {
  ready()
  return kindsInUse(byRole).every((k) => impls[k].available())
}

// ---- per-role -------------------------------------------------------------
export function roleEnabled(role) { return R(role).roleEnabled(role) }
export function validateModel(role, key) { return R(role).validateModel(role, key) }

export const classify = (...a) => R('llm').classify(...a)
export const embedText = (...a) => R('embed').embedText(...a)
export const describeImage = (...a) => R('vision').describeImage(...a)
export const answer = (...a) => R('llm').answer(...a)
// Streaming answers, with a fallback for any provider that doesn't implement
// them: the whole answer arrives as one delta, so callers never branch on
// whether the provider can stream.
export const answerStream = async (args) => {
  const p = R('llm')
  if (p.answerStream) return p.answerStream(args)
  const text = await p.answer(args)
  if (text) args?.onToken?.(text)
  return text
}

// A model-name patch is role-keyed, so it splits by owner: each provider is
// handed only the roles it serves, and one with nothing to do is skipped.
export const applySettings = async (patch = {}) => {
  ready()
  for (const k of kindsInUse(byRole)) {
    const slice = {}
    for (const role of ROLES) if (byRole[role] === k && patch[role] !== undefined) slice[role] = patch[role]
    if (Object.keys(slice).length) await impls[k].applySettings(slice)
  }
}

export const shutdown = async () => {
  for (const k of Object.keys(impls || {})) await impls[k].shutdown()
}

// ---- weights and residency: local only ------------------------------------
// Optional on the contract, so a pure-remote install resolves them to no-ops
// exactly as before.

// Residency decides what sits in THIS machine's RAM, so a role served remotely
// has none: it is pinned 'off' before the local provider sees the map.
// Without this, warmCache() pre-downloads the language and vision weights on a
// mixed install — several gigabytes for roles that will never run here, which
// is the exact cost the endpoint was chosen to avoid.
function localResidency(residency = {}) {
  const out = {}
  for (const role of ROLES) out[role] = byRole[role] === 'local' ? residency[role] : 'off'
  return out
}

// Same reasoning for model names: hand the local provider only the roles it
// serves, so a remote role's endpoint-defined id is never looked up in the
// on-device registry.
function localOnly(patch = {}) {
  const out = {}
  for (const role of ROLES) if (byRole[role] === 'local' && patch[role] !== undefined) out[role] = patch[role]
  return out
}

export const boot = (...a) => L()?.boot?.(...a) ?? Promise.resolve()
export const warmRole = (...a) => L()?.warmRole?.(...a) ?? Promise.resolve()
export const warmCache = (residency) => L()?.warmCache?.(localResidency(residency)) ?? Promise.resolve()
export const applyResidency = (residency) => L()?.applyResidency?.(localResidency(residency)) ?? Promise.resolve()
export const configureModels = (patch) => L()?.configureModels?.(localOnly(patch)) ?? Promise.resolve()
// Model files on disk, for the cache-management routes. A provider that
// downloads nothing claims no files, so the routes' capability gate is the
// only thing that has to know about the difference.
//
// Sliced like the two above: in mixed mode the language and vision weights on
// disk belong to no running role, so the cache route must be free to reclaim
// them. Claiming them would leave a mixed install unable to delete the exact
// multi-gigabyte files it switched to an endpoint to avoid.
export const weightsInUse = (selection) => L()?.weightsInUse?.(localOnly(selection)) ?? {}
