import * as ai from '../ai/index.ts'
import * as store from '../data/notes.ts'
import * as settings from '../data/settings.ts'
import * as tagvocab from '../data/tagvocab.ts'
import * as enrich from '../ai/enrich.ts'
import * as reembed from '../ai/reembed.ts'
import { ROLES } from '../ai/roles.ts'
import { json, readBody } from '../lib/http.ts'
import { firstRunComplete } from './status.ts'
import { _validateModels } from './model-selection.ts'
import { getAiConfig, setAiCredentials, SETUP_PROVIDER } from '../config.ts'
import { writeCredentials, writeRoleCredentials, clearCredentials } from '../data/credentials.ts'
import { ENDPOINTS, findEndpoint } from '../ai/endpoints.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Role } from '../ai/roles.ts'
import type { ModelSelection } from '../ai/providers/types.ts'

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

// ---- settings: model selection --------------------------------------------
// Only the endpoint's HOSTNAME is echoed — never the full URL and never the
// key. Some providers carry credentials in the URL path, so the whole string
// is treated as secret.
//
// `inherited` is identity, not equality: resolveAiConfig hands an inheriting
// role the shared entry itself, so a role given its own entry at the same URL
// still reports as its own — the one the user can clear. No URL is no entry
// either: embeddings borrowing a chat-only endpoint, which resolveAiConfig turns off.
function endpointInfo(role: Role = 'llm') {
  const { roles } = getAiConfig()
  const { baseUrl } = roles[role]
  const inherited = role !== 'llm' && (roles[role] === roles.llm || !baseUrl)
  if (!baseUrl) return { configured: false, host: null, inherited }
  try {
    return { configured: true, host: new URL(baseUrl).hostname, inherited }
  } catch {
    return { configured: true, host: null, inherited }
  }
}

// What the library's vectors were made with: the embedding model (env wins, as
// in the provider) at its endpoint. Compared, never logged: the URL is secret.
function embedSource(): string | null {
  const { roles, envModels } = getAiConfig()
  const model = envModels.embed || settings.getRemote().embed
  return model && roles.embed.baseUrl ? `${model} ${roles.embed.baseUrl}` : null
}

// Re-embed when the embedding role now answers from another model or endpoint
// than `before`. Comparing the stored setting re-embedded for a Settings edit
// KOTHAI_AI_EMBED_MODEL overrode, and missed a move under the same model name.
function reembedIfMoved(before: string | null, reason: string): void {
  const after = embedSource()
  if (after && after !== before) enrich.queueJob(() => reembed.reembedAll(reason))
}

// 'embed' or 'vision'; anything else, absent included, is the shared endpoint.
const endpointRole = (v: unknown): 'embed' | 'vision' | null => (v === 'embed' || v === 'vision' ? v : null)

// With any *_BASE_URL set by env the credential file is ignored, so a save answered 200 and changed nothing.
const ENV_MANAGED = { error: 'The endpoint is set by environment variables on this install.', code: 'env_managed' }

export async function handleGetSettings(res: ServerResponse): Promise<void> {
  const endpoints = { llm: endpointInfo('llm'), embed: endpointInfo('embed'), vision: endpointInfo('vision') }
  json(res, 200, {
    remote: settings.getRemote(),
    presets: await ai.listModels(),
    capabilities: ai.capabilities(),
    endpoint: endpoints.llm,
    endpoints,
    // Which roles' model names env pins, so Settings shows them read-only. Flags, not the names.
    envModels: Object.fromEntries(Object.keys(getAiConfig().envModels).map(r => [r, true])),
    // Static and credential-free, so the wizard needs no second request.
    catalogue: ENDPOINTS,
    // What the installer already asked. An id only; null when nobody asked.
    setup: { providerId: SETUP_PROVIDER },
  })
}

// The endpoint half of a first-run submission. Validated and written BEFORE
// any model name is looked at, because a name is checked against the
// catalogue of the endpoint that will serve its role.
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
  role: 'embed' | 'vision' | null = null,
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
  if (findEndpoint(providerId)?.needsKey && !apiKey) return { error: 'This service needs an API key.' }
  const ep = { baseUrl, apiKey, providerId }
  setAiCredentials(role ? writeRoleCredentials(role, ep, opts.dir) : writeCredentials(ep, opts.dir))

  // Seed the endpoint's model names BEFORE reconfiguring, which boots the
  // provider with the stored names: seeded after, the roles would come up with
  // no model. (With the on-device provider this order also decided whether the
  // embedding role went out at all; that provider is gone.)
  if (models) {
    const named = isRecord(models) ? models : {}
    const patch: ModelSelection = {}
    // A role's endpoint names only its own model; the shared one only the roles
    // borrowing it. Seeding all three gave embeddings on their own Ollama the new
    // tile's model name, and re-embedded the library with a model Ollama lacks.
    const { roles } = getAiConfig()
    for (const r of role ? [role] : ROLES.filter(r => roles[r] === roles.llm)) {
      const raw = named[r]
      const id = typeof raw === 'string' ? raw.trim() : ''
      if (id) patch[r] = id
    }
    if (Object.keys(patch).length) await settings.save({ remote: patch })
  }

  await ai.reconfigure(settings.getRemote(), { load: opts.load })
  return {}
}

// POST /api/setup/endpoint — apply an endpoint DURING first run, before the
// model picker is drawn.
//
// Separate from handleSetup because of ordering: the picker offers each role
// the catalogue of the endpoint that serves it, and connecting an endpoint is
// exactly what fills that catalogue. Folded into handleSetup, the picker was
// drawn against the OLD state — when an on-device provider still existed it
// offered a local download to someone who had just connected OpenAI, and
// never collected the endpoint's model ids at all.
//
// Deliberately does NOT set `configured`: first run is still open, and the
// caller comes straight back with the model names.
export async function handleSetupEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  opts: RouteOptions = {},
): Promise<void> {
  if (firstRunComplete(settings.isConfigured(), settings.isPreGate())) {
    return json(res, 409, { error: 'already configured' })
  }
  const body = await readBody(req)
  const fields = isRecord(body) ? body : {}
  if (!fields.endpoint) return json(res, 400, { error: 'an endpoint is required' })
  const { error } = await applyEndpointFromSetup(fields.endpoint, opts, fields.models, endpointRole(fields.role))
  if (error) return json(res, 400, { error })
  json(res, 200, { ok: true, capabilities: ai.capabilities(), endpoint: endpointInfo() })
}

// ---- first-run setup ------------------------------------------------------
// { skip: true } enters AI-free mode: configured, and every role's model name
// cleared, so no role runs even if an endpoint is connected. Otherwise:
// persist the model names and seed the tag registry.
export async function handleSetup(req: IncomingMessage, res: ServerResponse, opts: RouteOptions = {}): Promise<void> {
  // The same predicate that decides whether the client shows the screen, so
  // the gate and the endpoint behind it can never disagree about whether
  // first-run is still open.
  if (firstRunComplete(settings.isConfigured(), settings.isPreGate())) {
    return json(res, 409, { error: 'already configured' })
  }
  const body = await readBody(req)
  const fields = isRecord(body) ? body : {}

  if (fields.skip) {
    const none = { llm: '', embed: '', vision: '' }
    await settings.save({ configured: true, remote: none })
    await ai.applySettings(none)
    return json(res, 200, { ok: true })
  }

  // Before _validateModels: a model id is checked against the catalogue of the
  // endpoint that serves it, and connecting one is exactly what changes it.
  if (fields.endpoint) {
    const { error: endpointError } = await applyEndpointFromSetup(fields.endpoint, opts)
    if (endpointError) return json(res, 400, { error: endpointError })
  }

  const { remote, error } = _validateModels(body)
  if (error) return json(res, 400, { error })

  if (Object.keys(remote).length) {
    await settings.save({ remote })
    // The validated patch, not the whole remote store: a role this request
    // did not name keeps the model it already had.
    await ai.applySettings(remote)
  }

  await settings.save({ configured: true })
  // Through the job queue so it can't race in-flight enrichment.
  if (ai.roleEnabled('embed')) enrich.queueJob(() => tagvocab.rebuildFromNotes(store.allNotes()))
  json(res, 200, { ok: true })
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
  if (getAiConfig().source === 'env') return json(res, 409, ENV_MANAGED)
  const body = await readBody(req)
  const fields = isRecord(body) ? body : {}
  if (!fields.endpoint) return json(res, 400, { error: 'an endpoint is required' })
  const before = embedSource()
  const { error } = await applyEndpointFromSetup(fields.endpoint, opts, fields.models, endpointRole(fields.role))
  if (error) return json(res, 400, { error })
  reembedIfMoved(before, 'embedding endpoint changed')
  json(res, 200, { ok: true, capabilities: ai.capabilities(), endpoint: endpointInfo() })
}

// Disconnect: forget the credential, which leaves AI off — there is no
// on-device provider to fall back on any more. With { role }, forget only that
// role's own endpoint; it falls back to the shared one.
//
// The endpoint's model names are deliberately kept. They cost nothing while
// unused, and keeping them means reconnecting the same service later does not
// mean typing three ids again. What does NOT survive is the key.
export async function handleClearEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  opts: RouteOptions = {},
): Promise<void> {
  if (getAiConfig().source === 'env') return json(res, 409, ENV_MANAGED)
  const body: unknown = await readBody(req).catch(() => ({}))
  const role = endpointRole(isRecord(body) && body.role)
  const before = embedSource()
  if (role) {
    setAiCredentials(writeRoleCredentials(role, null, opts.dir))
    // Back on the shared provider's model: the override's stayed stored and was
    // sent where it was unknown. A URL outside the catalogue has no default.
    const fallback = findEndpoint(getAiConfig().roles.llm.providerId)?.defaults[role]
    if (fallback) await settings.save({ remote: { [role]: fallback } })
  } else {
    clearCredentials(opts.dir)
    setAiCredentials(null)
  }
  await ai.reconfigure(settings.getRemote(), { load: opts.load })
  reembedIfMoved(before, 'embedding endpoint changed')
  json(res, 200, { ok: true, capabilities: ai.capabilities(), endpoint: endpointInfo() })
}

export async function handleSaveSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req)
  const models = _validateModels(body)
  if (models.error) return json(res, 400, { error: models.error })
  if (!Object.keys(models.remote).length) return json(res, 400, { error: 'nothing to change' })

  // A plain store-and-apply: the endpoint's own catalogue is the only thing
  // that changed. The one exception is a new embedding model, which needs a
  // re-embed: treated like llm and vision, it left the library on the old
  // model's vectors while queries used the new one, and search degraded
  // silently. A blank id is the role switched off, with nothing to embed with.
  const embedBefore = embedSource()
  await settings.save({ remote: models.remote })
  // Role-keyed { llm, embed, vision }, the shape the provider takes.
  await ai.applySettings(settings.getRemote())
  if (models.remote.embed) reembedIfMoved(embedBefore, `endpoint model → ${models.remote.embed}`)

  json(res, 200, { ok: true, remote: settings.getRemote(), warnings: models.warnings })
}
