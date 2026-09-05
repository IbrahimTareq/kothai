import * as ai from '../ai/index.js'
import * as store from '../data/notes.js'
import * as settings from '../data/settings.js'
import * as tagvocab from '../data/tagvocab.js'
import * as enrich from '../ai/enrich.js'
import { ROLES, POLICIES, OFF_RESIDENCY } from '../ai/roles.js'
import { backlogCount } from '../ai/backlog.js'
import { isInstagramPost } from '../ai/meta.js'
import { json, readBody } from '../lib/http.js'
import { AI_BASE_URL } from '../config.js'

export function handleStatus(res) {
  const caps = ai.capabilities()
  json(res, 200, {
    ...ai.statusSnapshot(),
    // A provider with nothing to download has nothing to consent to, so the
    // first-run model picker is skipped entirely for it.
    configured: caps.downloadsWeights ? settings.isConfigured() : true,
    count: store.count(),
    capabilities: caps,
  })
}

// ---- settings: model selection + residency -------------------------------
// Only the endpoint's HOSTNAME is echoed — never the full URL and never the
// key. Some providers carry credentials in the URL path, so the whole string
// is treated as secret.
function endpointInfo() {
  if (!AI_BASE_URL) return { configured: false, host: null }
  try {
    return { configured: true, host: new URL(AI_BASE_URL).hostname }
  } catch {
    return { configured: true, host: null }
  }
}

export async function handleGetSettings(res) {
  const caps = ai.capabilities()
  json(res, 200, {
    current: settings.get(),
    remote: settings.getRemote(),
    residency: settings.getResidency(),
    presets: await ai.listModels(),
    capabilities: caps,
    endpoint: ROLES.some((r) => caps.roles[r] === 'remote') ? endpointInfo() : { configured: false, host: null },
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
export function _validateModels(body) {
  const { roles } = ai.capabilities()
  const local = {}
  const remote = {}
  const warnings = []
  for (const role of ROLES) {
    const isLocal = roles[role] === 'local'
    const key = (isLocal ? body : body.remote || {})[role]
    if (key === undefined) continue
    const r = ai.validateModel(role, key)
    if (!r.ok) return { error: r.error }
    if (r.warning) warnings.push(r.warning)
    ;(isLocal ? local : remote)[role] = key
  }
  return { local, remote, warnings }
}

function validateResidency(body) {
  const patch = {}
  if (!body.residency) return { patch }
  for (const role of ROLES) {
    const v = body.residency[role]
    if (v === undefined) continue
    if (!POLICIES.includes(v)) return { error: `invalid residency for ${role}: ${v}` }
    patch[role] = v
  }
  return { patch }
}

// ---- first-run setup ------------------------------------------------------
// Fresh installs hold off on loading any model until the user confirms here.
// { skip: true } enters AI-free mode: configured, every role off, no download.
// Otherwise: persist the choice, boot always-roles, pre-download on-demand
// roles (warm cache), and seed the tag registry.
export async function handleSetup(req, res) {
  // Nothing to download means nothing to consent to — the first-run picker
  // does not exist for this provider.
  if (!ai.capabilities().downloadsWeights) return json(res, 409, { error: 'no first-run setup for this provider' })
  if (settings.isConfigured()) return json(res, 409, { error: 'already configured' })
  const body = await readBody(req)

  if (body.skip) {
    await settings.save({ configured: true, residency: { ...OFF_RESIDENCY } })
    await ai.applyResidency(settings.getResidency())
    return json(res, 200, { ok: true, current: settings.get() })
  }

  const { local, error } = _validateModels(body)
  if (error) return json(res, 400, { error })

  const current = await settings.save({ ...local, configured: true, residency: settings.getResidency() })
  await ai.configureModels(current)
  // Download in the background through the job queue so it can't race saves.
  enrich.queueJob(async () => {
    const residency = settings.getResidency()
    await ai.applyResidency(residency)
    await ai.boot()                 // load always-roles
    await ai.warmCache(residency)   // pre-download on-demand roles, then free them
    if (residency.embed !== 'off') await tagvocab.rebuildFromNotes(store.allNotes())
  })
  json(res, 200, { ok: true, current })
}

export async function handleSaveSettings(req, res) {
  const body = await readBody(req)
  const caps = ai.capabilities()
  const models = _validateModels(body)
  if (models.error) return json(res, 400, { error: models.error })
  const resPatch = caps.managesResidency ? validateResidency(body) : { patch: {} }
  if (resPatch.error) return json(res, 400, { error: resPatch.error })
  const changing = Object.keys(models.local).length + Object.keys(models.remote).length + Object.keys(resPatch.patch).length
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
    const toSave = { ...models.local }
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
      for (const role of Object.keys(resPatch.patch)) {
        if (prevRes[role] === 'off' && residency[role] === 'ondemand') {
          try {
            await ai.warmRole(role) // download now; the idle timer frees the RAM
          } catch (e) {
            console.error(`[settings] ${role} warm failed:`, e.message)
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

  json(res, 200, { ok: true, current, remote: settings.getRemote(), residency: settings.getResidency(), warnings: models.warnings })
}

// ---- enrichment backlog ---------------------------------------------------
export function handleBacklog(res) {
  json(res, 200, { count: backlogCount(store.allNotes(), settings.getResidency()) })
}

export function handleEnrichBacklog(res) {
  if (!ai.available()) {
    return json(res, 503, { error: 'Inference endpoint is unavailable — check the connection and try again.', code: 'provider_unavailable' })
  }
  const queued = enrich.queueBacklog()
  json(res, 200, { ok: true, queued })
}

// Re-tag everything: re-run classify + embed across the whole library. Unlike
// the backlog above (which only fills in MISSING steps) this deliberately
// re-does work that already succeeded, because a note classified from its URL
// alone has a bad classification rather than a missing one. Hand-edited tags
// survive — see enrich.retagAll.
export async function handleRetagAll(res) {
  if (!ai.available()) {
    return json(res, 503, { error: 'Inference endpoint is unavailable — check the connection and try again.', code: 'provider_unavailable' })
  }
  if (settings.getResidency().llm === 'off') {
    return json(res, 409, { error: 'Re-tagging needs the language model — enable it above.', code: 'llm_off' })
  }
  json(res, 200, { ok: true, queued: await enrich.retagAll() })
}

// Viewport-priority hint from the scrolling client: bump the visible,
// still-unfetched Instagram notes to the front of the meta queue.
export async function handlePrioritize(req, res) {
  const body = await readBody(req)
  const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string').slice(0, 200) : []
  const byId = new Map(store.allNotes().map((n) => [n.id, n]))
  const eligible = ids.filter((id) => {
    const n = byId.get(id)
    return n && n.url && isInstagramPost(n.url) && !n.metaFetched
  })
  // ensure queued (a note might not be in the queue this boot), then promote
  for (const id of eligible) enrich.queueIgMeta(id, byId.get(id).url)
  json(res, 200, { promoted: enrich.promoteIgMeta(eligible) })
}
