import * as ai from '../ai/index.ts'
import * as store from '../data/notes.ts'
import * as settings from '../data/settings.ts'
import * as tagvocab from '../data/tagvocab.ts'
import * as enrich from '../ai/enrich.ts'
import { ROLES, POLICIES, OFF_RESIDENCY } from '../ai/roles.ts'
import { backlogCount } from '../ai/backlog.ts'
import { isInstagramPost } from '../ai/meta.ts'
import { json, readBody } from '../lib/http.ts'
import { getAiConfig, setAiCredentials, SETUP_PROVIDER } from '../config.ts'
import { writeCredentials, clearCredentials } from '../data/credentials.ts'
import { ENDPOINTS } from '../ai/endpoints.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Capabilities } from '../ai/routing.ts'
import type { Policy, Role } from '../ai/roles.ts'
import type { ModelSelection } from '../ai/providers/types.ts'
import type { SettingsPatch } from '../data/settings.ts'

// readBody hands back `unknown` on purpose — a request body has proved nothing
// yet, and an annotation would be a claim nothing checks at runtime.
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

// The endpoint routes' own options object. `dir` and `load` are both test
// seams: the credential directory and the provider loader, forwarded
// untouched. `load` is derived from reconfigure's own signature rather than
// re-spelled, so the two cannot drift.
interface RouteOptions {
  dir?: string
  load?: NonNullable<Parameters<typeof ai.reconfigure>[1]>['load']
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

interface ValidatedResidency {
  error?: string
  patch: Partial<Record<Role, Policy>>
}

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
// Exported for the unit tests.
export function firstRunComplete(
  caps: Pick<Capabilities, 'downloadsWeights'>,
  configured: boolean,
  preGate: boolean,
): boolean {
  if (caps.downloadsWeights) return configured
  return configured || preGate
}

export function handleStatus(res: ServerResponse): void {
  const caps = ai.capabilities()
  json(res, 200, {
    ...ai.statusSnapshot(),
    configured: firstRunComplete(caps, settings.isConfigured(), settings.isPreGate()),
    count: store.count(),
    capabilities: caps,
  })
}

// ---- settings: model selection + residency -------------------------------
// Only the endpoint's HOSTNAME is echoed — never the full URL and never the
// key. Some providers carry credentials in the URL path, so the whole string
// is treated as secret.
function endpointInfo() {
  const { baseUrl } = getAiConfig()
  if (!baseUrl) return { configured: false, host: null }
  try {
    return { configured: true, host: new URL(baseUrl).hostname }
  } catch {
    return { configured: true, host: null }
  }
}

export async function handleGetSettings(res: ServerResponse): Promise<void> {
  const caps = ai.capabilities()
  json(res, 200, {
    current: settings.get(),
    remote: settings.getRemote(),
    residency: settings.getResidency(),
    presets: await ai.listModels(),
    capabilities: caps,
    endpoint: ROLES.some(r => caps.roles[r] === 'remote') ? endpointInfo() : { configured: false, host: null },
    // Static catalogue, so the wizard can render provider tiles without a
    // second request. Contains no credentials — it is public reference data.
    // ollama-railway is withheld off Railway: its base URL resolves only
    // inside the project the template deploys, and a first-run tile that
    // cannot connect is worse than one tile fewer. findEndpoint still sees it,
    // so an install that did choose it keeps its catalogue entry.
    endpoints: ENDPOINTS.filter(e => e.id !== 'ollama-railway' || Boolean(process.env.RAILWAY_ENVIRONMENT)),
    // What the installer already asked. An id only; null when nobody asked.
    setup: { providerId: SETUP_PROVIDER },
    // Whether this image COULD run models on-device — false on lite, where
    // @qvac/sdk is absent. Settings offers "run on this machine" only when it
    // is true, rather than offering a switch that cannot work.
    localSupported: await ai.localSupported(),
    // On-device presets with sizes, even while an endpoint serves every role —
    // `presets` above reports the endpoint's catalogue then, so it cannot say
    // what switching back would cost or offer anything to pick.
    localPresets: await ai.localPresets(),
  })
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
// Exported under an underscore for the unit tests.
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

function validateResidency(body: unknown): ValidatedResidency {
  const patch: Partial<Record<Role, Policy>> = {}
  const fields = isRecord(body) ? body : {}
  if (!isRecord(fields.residency)) return { patch }
  for (const role of ROLES) {
    const v = fields.residency[role]
    if (v === undefined) continue
    // find(), not includes(): it both validates the stored string and hands
    // back the Policy-typed member, so nothing has to be asserted afterwards.
    const policy = POLICIES.find(p => p === v)
    if (!policy) return { error: `invalid residency for ${role}: ${v}`, patch }
    patch[role] = policy
  }
  return { patch }
}

// The endpoint half of a first-run submission. Validated and written BEFORE
// any model name is looked at, because the provider map those names are
// validated against depends on which provider is serving each role.
//
// `dir` is threaded through for tests only — production passes nothing and
// the credential store falls back to DATA_DIR.
// `opts` is the route's own options object throughout — it was being unpacked
// into two positional arguments at every call site, which is what put a bare
// `null` in the middle of the list.
async function applyEndpointFromSetup(
  endpoint: unknown,
  opts: RouteOptions = {},
  models: unknown = null,
): Promise<{ error?: string }> {
  const fields = isRecord(endpoint) ? endpoint : {}
  const baseUrl = typeof fields.baseUrl === 'string' ? fields.baseUrl.trim().replace(/\/+$/, '') : ''
  if (!baseUrl) return { error: 'An endpoint needs a base URL.' }
  try {
    const u = new URL(baseUrl)
    if (!['http:', 'https:'].includes(u.protocol)) return { error: 'An endpoint must be an http:// or https:// URL.' }
  } catch {
    return { error: 'That does not look like a URL.' }
  }
  const apiKey = typeof fields.apiKey === 'string' && fields.apiKey.trim() ? fields.apiKey.trim() : null
  const providerId = typeof fields.providerId === 'string' ? fields.providerId : null
  const creds = writeCredentials({ baseUrl, apiKey, providerId }, opts.dir)
  setAiCredentials(creds)

  // Seed the endpoint's model names BEFORE reconfiguring. Which provider serves
  // the embedding role is decided by whether one is named (see ai/routing.js),
  // so reconfiguring first would resolve that role against an empty store and
  // send it on-device — handing someone who just connected OpenAI a 300 MB
  // download for a role their endpoint serves perfectly well.
  if (models) {
    const named = isRecord(models) ? models : {}
    const patch: ModelSelection = {}
    for (const role of ROLES) {
      const raw = named[role]
      const id = typeof raw === 'string' ? raw.trim() : ''
      if (id) patch[role] = id
    }
    if (Object.keys(patch).length) await settings.save({ remote: patch })
  }

  await ai.reconfigure({ local: settings.get(), remote: settings.getRemote() }, { load: opts.load })
  await settleRoleMap()
  return {}
}

// POST /api/setup/endpoint — apply an endpoint DURING first run, before the
// model picker is drawn.
//
// Separate from handleSetup because of ordering: the picker asks about each
// role in the shape its provider needs, and which provider serves a role is
// exactly what connecting an endpoint changes. Folding this into handleSetup
// meant the picker was drawn against the OLD role map — offering a local
// download to someone who had just connected OpenAI, and never collecting the
// endpoint's model ids at all.
//
// Deliberately does NOT set `configured`: first run is still open, and the
// caller comes straight back with the model names.
export async function handleSetupEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  opts: RouteOptions = {},
): Promise<void> {
  if (firstRunComplete(ai.capabilities(), settings.isConfigured(), settings.isPreGate())) {
    return json(res, 409, { error: 'already configured' })
  }
  const body = await readBody(req)
  const fields = isRecord(body) ? body : {}
  if (!fields.endpoint) return json(res, 400, { error: 'an endpoint is required' })
  const { error } = await applyEndpointFromSetup(fields.endpoint, opts, fields.models)
  if (error) return json(res, 400, { error })
  const caps = ai.capabilities()
  json(res, 200, { ok: true, capabilities: caps, endpoint: endpointInfo() })
}

// ---- first-run setup ------------------------------------------------------
// Fresh installs hold off on loading any model until the user confirms here.
// { skip: true } enters AI-free mode: configured, every role off, no download.
// Otherwise: persist the choice, boot always-roles, pre-download on-demand
// roles (warm cache), and seed the tag registry.
export async function handleSetup(req: IncomingMessage, res: ServerResponse, opts: RouteOptions = {}): Promise<void> {
  // The same predicate that decides whether the client shows the screen, so
  // the gate and the endpoint behind it can never disagree about whether
  // first-run is still open.
  if (firstRunComplete(ai.capabilities(), settings.isConfigured(), settings.isPreGate())) {
    return json(res, 409, { error: 'already configured' })
  }
  const body = await readBody(req)
  const fields = isRecord(body) ? body : {}

  if (fields.skip) {
    await settings.save({ configured: true, residency: { ...OFF_RESIDENCY } })
    await ai.applyResidency(settings.getResidency())
    return json(res, 200, { ok: true, current: settings.get() })
  }

  // Before _validateModels: that function asks ai.capabilities() which role
  // each provider serves, and connecting an endpoint is exactly what changes
  // the answer. Validating first would check the model ids against the old map.
  if (fields.endpoint) {
    const { error: endpointError } = await applyEndpointFromSetup(fields.endpoint, opts)
    if (endpointError) return json(res, 400, { error: endpointError })
  }

  const { local, remote, error } = _validateModels(body)
  if (error) return json(res, 400, { error })

  // Endpoint ids go to their own store first — the same split
  // handleSaveSettings makes, and for the same reason: nothing ever reads a
  // local column back for a role the endpoint serves.
  if (Object.keys(remote).length) {
    await settings.save({ remote })
    // The validated patch, not the whole remote store: getRemote() carries an
    // empty string for every role the endpoint does NOT serve, and
    // applySettings only skips `undefined` — so passing it hands the local
    // provider a blank model name for its own role.
    await ai.applySettings(remote)
  }

  const current = await settings.save({ ...local, configured: true, residency: settings.getResidency() })
  await ai.configureModels(current)
  // Download in the background through the job queue so it can't race saves.
  enrich.queueJob(async () => {
    const residency = settings.getResidency()
    await ai.applyResidency(residency)
    await ai.boot() // load always-roles
    await ai.warmCache(residency) // pre-download on-demand roles, then free them
    if (residency.embed !== 'off') await tagvocab.rebuildFromNotes(store.allNotes())
  })
  json(res, 200, { ok: true, current })
}

// Reconfiguring moves roles between providers, and the local provider has to be
// told — twice over.
//
// While a role was served remotely the facade pinned it 'off' on the local side
// (localResidency in ai/index.js), which is right at the time and wrong the
// moment the role comes back: disconnecting an endpoint returned language and
// vision to this machine with both still switched off, embedding the only thing
// working, and the status aggregate reporting Ready over the top of it. The
// reverse leaks instead of breaking — a role that moves OUT to an endpoint
// keeps its weights resident until something unloads them.
//
// Model names and residency are applied inline because they are cheap and
// nothing downloads. boot() is queued, because for a role whose weights were
// never fetched it is a multi-gigabyte download and must not hold the request
// open or race in-flight enrichment.
async function settleRoleMap() {
  await ai.configureModels(settings.get())
  await ai.applyResidency(settings.getResidency())
  enrich.queueJob(() => ai.boot())
}

// ---- changing the endpoint after first run --------------------------------
// The setup route above refuses once first run is over, which is right for
// setup and wrong for everything after it: keys get rotated, trials end, and
// services get swapped. Without these two, the only way to change any of that
// was to recreate the container — the exact thing the credential store exists
// to avoid.
export async function handleSaveEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  opts: RouteOptions = {},
): Promise<void> {
  const body = await readBody(req)
  const fields = isRecord(body) ? body : {}
  if (!fields.endpoint) return json(res, 400, { error: 'an endpoint is required' })
  const { error } = await applyEndpointFromSetup(fields.endpoint, opts, fields.models)
  if (error) return json(res, 400, { error })
  json(res, 200, { ok: true, capabilities: ai.capabilities(), endpoint: endpointInfo() })
}

// Disconnect: forget the credential and take every role back on-device.
//
// The endpoint's model names are deliberately kept. They cost nothing while
// unused, and keeping them means reconnecting the same service later does not
// mean typing three ids again. What does NOT survive is the key.
export async function handleClearEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  opts: RouteOptions = {},
): Promise<void> {
  // Optional { models: { llm, embed, vision } } — on-device preset keys chosen
  // in the same breath as disconnecting. They are applied AFTER reconfigure,
  // because _validateModels asks which provider serves each role and the answer
  // is only right once the endpoint is gone.
  const body: unknown = await readBody(req).catch(() => ({}))
  clearCredentials(opts.dir)
  setAiCredentials(null)
  await ai.reconfigure({ local: settings.get(), remote: settings.getRemote() }, { load: opts.load })

  if (isRecord(body) && body.models) {
    const { local, error } = _validateModels(body.models)
    if (error) return json(res, 400, { error })
    if (Object.keys(local).length) await settings.save(local)
  }

  await settleRoleMap()
  // Roles just handed back need their weights. Queued, because for someone who
  // set up on an endpoint this is the first download of any model at all.
  enrich.queueJob(() => ai.warmCache(settings.getResidency()))
  json(res, 200, { ok: true, capabilities: ai.capabilities(), endpoint: endpointInfo() })
}

export async function handleSaveSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req)
  const caps = ai.capabilities()
  const models = _validateModels(body)
  if (models.error) return json(res, 400, { error: models.error })
  const resPatch = caps.managesResidency ? validateResidency(body) : { patch: {} }
  if (resPatch.error) return json(res, 400, { error: resPatch.error })
  const changing =
    Object.keys(models.local).length + Object.keys(models.remote).length + Object.keys(resPatch.patch).length
  if (!changing) return json(res, 400, { error: 'nothing to change' })

  // Endpoint ids are a plain store-and-apply: no weights, no residency, and no
  // re-index — the endpoint's own catalogue is the only thing that changed.
  if (Object.keys(models.remote).length) {
    await settings.save({ remote: models.remote })
    // Role-keyed { llm, embed, vision } — the same shape both providers take.
    await ai.applySettings(settings.getRemote())
  }

  const prev = settings.get()
  const prevRes = settings.getResidency()
  const embedChanged = Boolean(models.local.embed) && models.local.embed !== prev.embed

  let current = prev
  if (Object.keys(models.local).length || Object.keys(resPatch.patch).length) {
    const toSave: SettingsPatch = { ...models.local }
    if (Object.keys(resPatch.patch).length) toSave.residency = resPatch.patch
    current = await settings.save(toSave)

    // Apply through the job queue so it can't race in-flight enrichment.
    enrich.queueJob(async () => {
      const residency = settings.getResidency()
      // Residency first: applyModels()'s "reload an always-role whose model
      // changed" step reads each manager's CURRENT policy, so if a model swap
      // and an off/ondemand transition land in the same request, applying
      // residency first means it never loads a model it's about to unload.
      await ai.applyResidency(residency)
      await ai.applySettings(models.local)
      await ai.boot() // (re)load always-roles after any transition
      // Pre-download weights for roles just switched on from off, so their
      // first real use is a local load rather than a surprise download.
      // ROLES rather than Object.keys(patch): the keys are a subset of ROLES
      // by construction (validateResidency writes no other), and iterating the
      // literal union is what keeps the two residency lookups below indexable.
      for (const role of ROLES) {
        if (resPatch.patch[role] === undefined) continue
        if (prevRes[role] === 'off' && residency[role] === 'ondemand') {
          try {
            await ai.warmRole(role) // download now; the idle timer frees the RAM
          } catch (e) {
            console.error(`[settings] ${role} warm failed:`, e instanceof Error ? e.message : e)
          }
        }
      }
      // A new embedding model speaks a different vector space, so every note is
      // re-embedded in the background (search degrades gracefully meanwhile).
      // The sweep itself lives in enrich.js so the boot-time recipe check runs
      // the identical code — see enrich.reembedAll.
      if (embedChanged && residency.embed !== 'off') {
        await enrich.reembedAll(`model → ${models.local.embed}`)
      }
    })
  }

  json(res, 200, {
    ok: true,
    current,
    remote: settings.getRemote(),
    residency: settings.getResidency(),
    warnings: models.warnings,
  })
}

// ---- enrichment backlog ---------------------------------------------------
export function handleBacklog(res: ServerResponse): void {
  json(res, 200, { count: backlogCount(store.allNotes(), settings.getResidency()) })
}

// Both bulk-enrichment routes refuse the same way when there is no reachable
// provider, and the string is user-facing — two copies is two things to keep
// in step with each other and with the client that matches on the code.
const providerDown = (res: ServerResponse): void =>
  json(res, 503, {
    error: 'Inference endpoint is unavailable — check the connection and try again.',
    code: 'provider_unavailable',
  })

export function handleEnrichBacklog(res: ServerResponse) {
  if (!ai.available()) {
    return providerDown(res)
  }
  const queued = enrich.queueBacklog()
  json(res, 200, { ok: true, queued })
}

// Re-tag everything: re-run classify + embed across the whole library. Unlike
// the backlog above (which only fills in MISSING steps) this deliberately
// re-does work that already succeeded, because a note classified from its URL
// alone has a bad classification rather than a missing one. Hand-edited tags
// survive — see enrich.retagAll.
export async function handleRetagAll(res: ServerResponse): Promise<void> {
  if (!ai.available()) {
    return providerDown(res)
  }
  if (settings.getResidency().llm === 'off') {
    return json(res, 409, { error: 'Re-tagging needs the language model — enable it above.', code: 'llm_off' })
  }
  json(res, 200, { ok: true, queued: await enrich.retagAll() })
}

// Viewport-priority hint from the scrolling client: bump the visible,
// still-unfetched Instagram notes to the front of the meta queue.
export async function handlePrioritize(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req)
  const fields = isRecord(body) ? body : {}
  const ids: string[] = Array.isArray(fields.ids) ? fields.ids.filter(x => typeof x === 'string').slice(0, 200) : []
  const byId = new Map(store.allNotes().map(n => [n.id, n]))
  // The url is carried out of the lookup rather than looked up a second time
  // below, where the map answers `PublicNote | undefined` and there is nothing
  // honest to do with the undefined half.
  const eligible: { id: string; url: string }[] = []
  for (const id of ids) {
    const n = byId.get(id)
    if (n?.url && isInstagramPost(n.url) && !n.metaFetched) eligible.push({ id, url: n.url })
  }
  // ensure queued (a note might not be in the queue this boot), then promote
  for (const e of eligible) enrich.queueIgMeta(e.id, e.url)
  json(res, 200, { promoted: enrich.promoteIgMeta(eligible.map(e => e.id)) })
}
