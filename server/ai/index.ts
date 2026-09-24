// Inference facade — the single module the rest of the app imports.
//
// Each role (llm / embed / vision) is routed to a provider at boot, resolved
// via dynamic import(). That dynamic import is load-bearing, not stylistic:
// it is what keeps @qvac/sdk off the code path in the lite image, where the
// package is not installed at all. A static
// `import ... from './providers/local.ts'` here would make the lite build
// crash at startup.
//
// Sync accessors (capabilities, statusSnapshot, roleEnabled) delegate to the
// provider that owns the role and throw if called before initProvider(). That
// is safe because server/index.ts awaits initProvider() before the HTTP server
// listens, so no request can arrive first.
import { getAiConfig, AI_EMBED_PROVIDER } from '../config.ts'
import { ROLES } from './roles.ts'
import { resolveRoleProviders, kindsInUse, mergeStatus, mergeListModels, mergeCapabilities } from './routing.ts'
// Type-only, so it survives none of the above: `import type` is erased before
// the module runs and pulls in no provider. providers/types.ts is itself a
// pure type module, so naming the contract here costs the lite image nothing.
import type { Residency, Role } from './roles.ts'
import type { Capabilities, ProviderKind, ProviderStatus, RoleProviders, RoutedCapabilities } from './routing.ts'
import type {
  AnswerStreamArgs,
  ModelOption,
  ModelSelection,
  Provider,
  ProviderConfig,
  ValidationResult,
} from './providers/types.ts'

export { FeatureDisabledError } from './roles.ts'
export { PRESETS, DEFAULTS } from './presets.ts'
export { normaliseClassification, isJunkTag, heuristicType, deriveTitle, isLikelyUrl, extractUrl } from './normalise.ts'

// A thrown value is `unknown`, and the only field either catch below reads is
// the loader's `code`. Local rather than shared, for the reason meta.ts and
// availability.ts each give for their own copy: server/lib/ is the security
// floor, and a change there needs a test that fails without it.
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

// The test seam: `load(kind)` hands back a fake provider instead of letting the
// dynamic import() below resolve the real one. `kind` is optional because the
// availability probe calls it with no argument — that path only cares whether
// resolving throws.
type ProviderLoader = (kind?: ProviderKind) => Provider | Promise<Provider>

interface InitOptions {
  load?: ProviderLoader | null
  embedProvider?: string | null
  localAvailable?: boolean
}

interface ReconfigureOptions extends InitOptions {
  provider?: ProviderKind
}

// { local?, remote? } — only the kinds the role map actually uses. Keyed by
// string rather than ProviderKind for the reason routing.ts's ByKind spells
// out: a pure-local install has no `remote` entry at all, and every read below
// is keyed off the same kindsInUse() list that filled it.
let impls: Record<string, Provider> | null = null
// { llm, embed, vision } → provider kind.
let byRole: RoleProviders | null = null
// Memoised answer to "could this image serve a role on-device at all?" — the
// lite image cannot, and Settings needs to know before offering to switch back
// to local models. Probed lazily rather than at boot, because loading the
// on-device stack into a process that may never call it is pure cost.
let localProbe: boolean | null = null

// The two globals above are published together at the end of initProvider and
// cleared together by _reset, so one check covers the pair. Handing them back
// rather than only throwing is what lets every reader below index the map
// without re-testing it.
function ready(): { impls: Record<string, Provider>; byRole: RoleProviders } {
  if (!impls || !byRole) throw new Error('AI provider not initialised — initProvider() must run before this call')
  return { impls, byRole }
}

// The provider that owns a role. Every inference call goes through here.
function R(role: Role): Provider {
  const { impls, byRole } = ready()
  return impls[byRole[role]]
}

// Calls that are not role-specific (boot, residency, weights) go to the local
// provider when there is one, because every one of them is about weights on
// disk. A pure-remote install has none and they no-op.
function L(): Provider | null {
  const { impls } = ready()
  return impls.local || null
}

export async function _selectProvider(kind: ProviderKind, load: ProviderLoader | null = null): Promise<Provider> {
  if (kind === 'remote') return await (load ? load() : import('./providers/remote.ts'))
  try {
    return await (load ? load() : import('./providers/local.ts'))
  } catch (e) {
    if (isRecord(e) && e.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error(
        'KOTHAI_AI_PROVIDER=local but @qvac/sdk is not installed. This is the lite image — ' +
          'set KOTHAI_AI_PROVIDER=remote and KOTHAI_AI_BASE_URL to point at an OpenAI-compatible endpoint.',
      )
    }
    throw e
  }
}

// Can this image serve a role on-device? The lite image cannot: @qvac/sdk is
// not installed and the import throws ERR_MODULE_NOT_FOUND. A full image whose
// native binding won't load on this host (no AVX2, glibc mismatch) is the same
// answer arrived at the hard way — and killing boot over it would strand the
// operator who set KOTHAI_AI_PROVIDER=remote precisely to escape that, so it
// degrades to all-remote rather than throwing. A genuinely local install never
// reaches here: _selectProvider still fails loudly for it.
export async function _localAvailable(load: ProviderLoader | null = null): Promise<boolean> {
  try {
    await (load ? load() : import('./providers/local.ts'))
    return true
  } catch (e) {
    const code = isRecord(e) ? e.code : undefined
    if (code !== 'ERR_MODULE_NOT_FOUND') {
      console.error(
        '[ai] on-device provider unusable, serving every role remotely:',
        e instanceof Error ? e.message : e,
      )
    }
    return false
  }
}

export function _reset(): void {
  impls = null
  byRole = null
  localProbe = null
  localPresetCache = null
}

// The on-device preset list — with sizes — regardless of who currently serves
// each role. Settings needs it while every role is on an endpoint, to show what
// switching back would download; listModels() cannot answer, because it reports
// the endpoint's catalogue in that state.
//
// Cheap: presetInfo() is a pure read of the SDK's registry, so the module is
// imported but never initialised and no weights are touched.
let localPresetCache: Record<Role, ModelOption[]> | null = null
export async function localPresets(load: ProviderLoader | null = null): Promise<Record<Role, ModelOption[]> | null> {
  if (localPresetCache) return localPresetCache
  if (!(await localSupported(load))) return null
  const mod = impls?.local || (await _selectProvider('local', load ? () => load('local') : null))
  localPresetCache = await mod.listModels()
  return localPresetCache
}

// Whether an on-device provider exists in this image. Distinct from
// capabilities().roles, which says who serves a role RIGHT NOW: an install with
// every role on an endpoint still reports true here if it could take them back.
export async function localSupported(load: ProviderLoader | null = null): Promise<boolean> {
  if (impls?.local) return true
  if (localProbe === null) localProbe = await _localAvailable(load)
  return localProbe
}

// `opts` exists for tests: `load(kind)` swaps in fakes, and the two resolution
// inputs can be pinned without touching process.env.
export async function initProvider(
  kind: ProviderKind = getAiConfig().provider,
  current: ProviderConfig = {},
  opts: InitOptions = {},
): Promise<Record<string, Provider>> {
  if (impls) return impls
  const { load = null, embedProvider = AI_EMBED_PROVIDER } = opts
  // Probe only when the answer can change the outcome: resolveRoleProviders
  // ignores localAvailable when the embedding role is pinned remote, and
  // loading the whole on-device stack into a process that will never call it
  // is pure cost — and, on a host where the native binding is broken, risk.
  const needsProbe = kind === 'remote' && embedProvider !== 'remote'
  const localAvailable =
    opts.localAvailable ?? (needsProbe ? await _localAvailable(load ? () => load('local') : null) : kind !== 'remote')
  // `current` is { local, remote } — the endpoint's embedding model name is
  // what decides whether that role goes out. See routing.ts.
  const roles = resolveRoleProviders({
    provider: kind,
    embedProvider,
    localAvailable,
    remoteEmbedModel: current?.remote?.embed || '',
  })

  // Built into a local and published only once every provider is up. Assigning
  // impls before the loop would let a throw halfway through leave a truthy
  // half-built map: ready() would pass, and the retry would short-circuit on
  // the guard above and hand out a provider that never initialised.
  const next: Record<string, Provider> = {}
  for (const k of kindsInUse(roles)) {
    next[k] = await _selectProvider(k, load ? () => load(k) : null)
    await next[k].init(current)
  }
  byRole = roles
  impls = next
  return impls
}

// Re-resolve the role map against current config and bring up whatever it now
// needs. Called after the endpoint or its key changes, so that a credential
// saved in the browser takes effect without a container restart.
//
// Three deliberate choices:
//   - the local provider is never re-initialised if it is already up; its
//     init() loads model weights, and an endpoint change has nothing to do
//     with them.
//   - the remote provider IS re-initialised, because its boot() reads the
//     endpoint from config — re-running init() is precisely what re-points it.
//   - the new map is built into a local and published only on success, the
//     same contract initProvider keeps, so a throw cannot strand the process
//     with a half-built map that ready() would happily wave through.
export async function reconfigure(current: ProviderConfig = {}, opts: ReconfigureOptions = {}): Promise<void> {
  const live = ready().impls
  const { provider = getAiConfig().provider, load = null, embedProvider = AI_EMBED_PROVIDER } = opts
  const needsProbe = provider === 'remote' && embedProvider !== 'remote'
  const localAvailable =
    opts.localAvailable ??
    (Boolean(live.local) ||
      (needsProbe ? await _localAvailable(load ? () => load('local') : null) : provider !== 'remote'))
  const roles = resolveRoleProviders({
    provider,
    embedProvider,
    localAvailable,
    remoteEmbedModel: current?.remote?.embed || '',
  })

  const next = { ...live }
  for (const k of kindsInUse(roles)) {
    if (!next[k]) next[k] = await _selectProvider(k, load ? () => load(k) : null)
    // Remote re-inits every time (that IS the re-point); local only on first use.
    if (k === 'remote' || !live[k]) await next[k].init(current)
  }
  byRole = roles
  impls = next
}

// ---- provider-wide, merged ------------------------------------------------
export function capabilities(): RoutedCapabilities {
  const { impls, byRole } = ready()
  const caps: Record<string, Capabilities> = {}
  for (const k of kindsInUse(byRole)) caps[k] = impls[k].capabilities()
  return mergeCapabilities(byRole, caps)
}

export function statusSnapshot(): ProviderStatus {
  const { impls, byRole } = ready()
  const snapshots: Record<string, ProviderStatus> = {}
  for (const k of kindsInUse(byRole)) snapshots[k] = impls[k].statusSnapshot()
  return mergeStatus(byRole, snapshots)
}

export async function listModels(): Promise<Record<Role, ModelOption[]>> {
  const { impls, byRole } = ready()
  const lists: Record<string, Record<Role, ModelOption[]>> = {}
  for (const k of kindsInUse(byRole)) lists[k] = await impls[k].listModels()
  return mergeListModels(byRole, lists)
}

// Every provider in use must be reachable for the app to claim availability.
export function available(): boolean {
  const { impls, byRole } = ready()
  return kindsInUse(byRole).every(k => impls[k].available())
}

// ---- per-role -------------------------------------------------------------
export function roleEnabled(role: Role): boolean {
  return R(role).roleEnabled(role)
}
export function validateModel(role: Role, key: string): ValidationResult {
  return R(role).validateModel(role, key)
}

export const classify = (...a: Parameters<Provider['classify']>): ReturnType<Provider['classify']> =>
  R('llm').classify(...a)
export const embedText = (...a: Parameters<Provider['embedText']>): ReturnType<Provider['embedText']> =>
  R('embed').embedText(...a)
export const describeImage = (...a: Parameters<Provider['describeImage']>): ReturnType<Provider['describeImage']> =>
  R('vision').describeImage(...a)
export const answer = (...a: Parameters<Provider['answer']>): ReturnType<Provider['answer']> => R('llm').answer(...a)
// Streaming answers, with a fallback for any provider that doesn't implement
// them: the whole answer arrives as one delta, so callers never branch on
// whether the provider can stream.
export const answerStream = async (args: AnswerStreamArgs): Promise<string> => {
  const p = R('llm')
  if (p.answerStream) return p.answerStream(args)
  const text = await p.answer(args)
  if (text) args?.onToken?.(text)
  return text
}

// A model-name patch is role-keyed, so it splits by owner: each provider is
// handed only the roles it serves, and one with nothing to do is skipped.
export const applySettings = async (patch: ModelSelection = {}): Promise<void> => {
  const { impls, byRole } = ready()
  for (const k of kindsInUse(byRole)) {
    const slice: ModelSelection = {}
    for (const role of ROLES) {
      const name = patch[role]
      if (byRole[role] === k && name !== undefined) slice[role] = name
    }
    if (Object.keys(slice).length) await impls[k].applySettings(slice)
  }
}

export const shutdown = async (): Promise<void> => {
  const map: Record<string, Provider> = impls || {}
  for (const k of Object.keys(map)) await map[k].shutdown()
}

// ---- weights and residency: local only ------------------------------------
// Optional on the contract, so a pure-remote install resolves them to no-ops
// exactly as before.

// Residency decides what sits in THIS machine's RAM, so a role served remotely
// has none: it is pinned 'off' before the local provider sees the map.
// Without this, warmCache() pre-downloads the language and vision weights on a
// mixed install — several gigabytes for roles that will never run here, which
// is the exact cost the endpoint was chosen to avoid.
function localResidency(residency: Residency): Residency {
  const { byRole } = ready()
  // Seeded by spreading the input rather than starting from {} — every value
  // is replaced by the loop, but the spread is what makes the result carry all
  // three roles by construction. Same reason roles.ts's resolveResidency()
  // spreads a base map before overwriting it.
  const out: Residency = { ...residency }
  for (const role of ROLES) out[role] = byRole[role] === 'local' ? residency[role] : 'off'
  return out
}

// Same reasoning for model names: hand the local provider only the roles it
// serves, so a remote role's endpoint-defined id is never looked up in the
// on-device registry.
function localOnly(patch: ModelSelection = {}): ModelSelection {
  const { byRole } = ready()
  const out: ModelSelection = {}
  for (const role of ROLES) {
    const name = patch[role]
    if (byRole[role] === 'local' && name !== undefined) out[role] = name
  }
  return out
}

export const boot = (...a: Parameters<NonNullable<Provider['boot']>>): Promise<void> =>
  L()?.boot?.(...a) ?? Promise.resolve()
export const warmRole = (...a: Parameters<NonNullable<Provider['warmRole']>>): Promise<void> =>
  L()?.warmRole?.(...a) ?? Promise.resolve()
export const warmCache = (residency: Residency): Promise<void> =>
  L()?.warmCache?.(localResidency(residency)) ?? Promise.resolve()
export const applyResidency = (residency: Residency): Promise<void> =>
  L()?.applyResidency?.(localResidency(residency)) ?? Promise.resolve()
export const configureModels = (patch: ModelSelection): Promise<void> =>
  L()?.configureModels?.(localOnly(patch)) ?? Promise.resolve()
// Model files on disk, for the cache-management routes. A provider that
// downloads nothing claims no files, so the routes' capability gate is the
// only thing that has to know about the difference.
//
// Sliced like the two above: in mixed mode the language and vision weights on
// disk belong to no running role, so the cache route must be free to reclaim
// them. Claiming them would leave a mixed install unable to delete the exact
// multi-gigabyte files it switched to an endpoint to avoid.
export const weightsInUse = (selection: ModelSelection): Record<string, Role> =>
  L()?.weightsInUse?.(localOnly(selection)) ?? {}
