// Remote inference over an OpenAI-compatible HTTP endpoint — Ollama,
// llama.cpp server, vLLM, OpenAI, OpenRouter, anything speaking /v1.
//
// Prompts and result normalisation come from the shared pure modules, so a
// note classified here is asked the same question and filtered the same way
// as one classified on-device.
//
// Credentials arrive from config (env only) and are never persisted or
// echoed back by any API response. Model NAMES come from settings, because
// they are the user's choice and vary per endpoint.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { AI_BASE_URL, AI_API_KEY } from '../../config.js'
import { FeatureDisabledError, ROLES } from '../roles.js'
import { Circuit } from '../circuit.js'
import { CLASSIFY_SCHEMA, DESCRIBE_IMAGE_PROMPT, classifySystemPrompt, classifyUserPrompt, answerSystemPrompt, answerUserPrompt, embedInput, clipToTokens } from '../prompts.js'
import { normaliseClassification, stripThinking } from '../normalise.js'
import { postJson, getJson, TIMEOUTS, RemoteError } from './remote-http.js'

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif' }

// Factory rather than module-level state so tests can drive several
// independent instances against a throwaway server. The module's default
// export set (bottom of file) is the singleton the facade resolves.
export function createRemoteProvider({ baseUrl, apiKey, models }) {
  const circuit = new Circuit({ threshold: 5, cooldownMs: 60_000 })
  let catalogue = []
  let probeError = ''

  const modelFor = (role) => (models?.[role] || '').trim()

  function guard(role) {
    if (!baseUrl) throw new FeatureDisabledError(role, { code: `${role}_off`, message: 'No inference endpoint configured — set STASH_AI_BASE_URL.' })
    if (!modelFor(role)) throw new FeatureDisabledError(role, { code: `${role}_off`, message: `No ${role} model name configured — set one in Settings.` })
    if (!circuit.allow()) {
      throw new FeatureDisabledError(role, { code: 'circuit_open', message: `Inference endpoint is unavailable: ${circuit.reason}` })
    }
  }

  // Every network call funnels through here so success/failure bookkeeping
  // for the circuit happens in exactly one place.
  async function call(fn) {
    try {
      const out = await fn()
      circuit.recordSuccess()
      if (probeError) probeError = ''
      return out
    } catch (e) {
      if (e instanceof RemoteError) circuit.recordFailure({ transient: e.transient, message: e.message })
      throw e
    }
  }

  const chat = (body, timeoutMs) => postJson(baseUrl, '/chat/completions', body, { apiKey, timeoutMs })
  const textOf = (r) => (r?.choices?.[0]?.message?.content || '').trim()

  return {
    capabilities: () => ({ kind: 'remote', managesResidency: false, downloadsWeights: false }),

    roleEnabled: (role) => Boolean(baseUrl) && Boolean(modelFor(role)),

    available: () => Boolean(baseUrl) && circuit.allow(),

    validateModel(role, key) {
      const k = (key || '').trim()
      if (!k) return { ok: false, error: `${role} model name cannot be empty` }
      if (k.length > 200) return { ok: false, error: `${role} model name is too long` }
      // Deliberately a warning, not a rejection: the catalogue can be stale
      // or unavailable, and saving settings must not depend on the endpoint
      // being up right now.
      if (catalogue.length && !catalogue.includes(k)) return { ok: true, warning: `"${k}" is not listed by the endpoint — saving anyway.` }
      return { ok: true }
    },

    async listModels() {
      const opts = catalogue.map((id) => ({ key: id, label: id, desc: '', best: [], sizeBytes: 0 }))
      return { llm: opts, embed: opts, vision: opts }
    },

    // One probe, best-effort. A failure here is reported in the status
    // aggregate but never throws — the app must still serve notes when the
    // inference endpoint is down.
    async init() {
      if (!baseUrl) return
      try {
        const res = await getJson(baseUrl, '/models', { apiKey, timeoutMs: TIMEOUTS.probe })
        catalogue = (res?.data || []).map((m) => m.id).filter(Boolean)
        probeError = ''
        circuit.recordSuccess()
      } catch (e) {
        probeError = e.message
        circuit.recordFailure({ transient: e.transient !== false, message: e.message })
      }
    },

    async applySettings(patch) {
      models = { ...models, ...patch }
    },

    async shutdown() {},

    statusSnapshot() {
      const roles = {}
      for (const role of ROLES) {
        if (!baseUrl || !modelFor(role)) roles[role] = { state: 'off', progress: 0, message: '', model: modelFor(role) }
        else if (!circuit.allow()) roles[role] = { state: 'error', progress: 0, message: circuit.reason, model: modelFor(role) }
        else if (probeError) roles[role] = { state: 'error', progress: 0, message: probeError, model: modelFor(role) }
        else roles[role] = { state: 'ready', progress: 100, message: 'Ready', model: modelFor(role) }
      }
      // No endpoint configured at all is AI-free mode, not a fault — the same
      // state local reports when every role's residency is 'off'.
      const anyOn = ROLES.some((r) => roles[r].state !== 'off')
      const broken = anyOn && ROLES.some((r) => roles[r].state === 'error')
      const aggregate = broken
        ? { state: 'error', progress: 0, message: probeError || circuit.reason || 'Inference endpoint unavailable' }
        : { state: 'ready', progress: 100, message: 'Ready' }
      return { roles, aggregate }
    },

    // `mode` ('document' | 'query') selects the task prefix for
    // prompt-instructed embedding models. Applied here too, not just locally,
    // because the endpoint may well be serving EmbeddingGemma — but keyed on
    // the configured model NAME, since it may equally be serving nomic, bge
    // or an OpenAI text-embedding-*, none of which want the prefix. See
    // prompts.js's embedInput.
    async embedText(text, { mode = 'document' } = {}) {
      guard('embed')
      const clean = embedInput(clipToTokens(text), { mode, model: modelFor('embed') }) || ' '
      const res = await call(() => postJson(baseUrl, '/embeddings', { model: modelFor('embed'), input: clean }, { apiKey, timeoutMs: TIMEOUTS.embed }))
      return res?.data?.[0]?.embedding || []
    },

    async classify({ text, hasImage, isUrl, now, knownTags = [], candidateTags = [] }) {
      guard('llm')
      const messages = [
        { role: 'system', content: classifySystemPrompt({ now, knownTags, candidateTags }) },
        { role: 'user', content: classifyUserPrompt({ text, hasImage, isUrl }) },
      ]
      const model = modelFor('llm')
      let raw = ''
      try {
        // Probe json_schema outside call() so a 400 "unsupported" response
        // does not open the circuit before the plain-prompt retry runs.
        raw = textOf(
          await chat({ model, messages, response_format: { type: 'json_schema', json_schema: { name: 'classification', schema: CLASSIFY_SCHEMA } } }, TIMEOUTS.classify),
        )
        circuit.recordSuccess()
        if (probeError) probeError = ''
      } catch (e) {
        // Not every OpenAI-compatible server implements json_schema. A 400 is
        // the usual "I don't know this field" answer — retry once with plain
        // prompting rather than losing the classification entirely. That
        // retry is the ONLY outcome that must not trip the breaker; every
        // other failure (network, auth, 5xx, rate limit) is a genuine signal
        // and must still be recorded, or a dead endpoint never opens the
        // circuit — classify() is the backlog's dominant call, so if its
        // failures never reach the circuit, the enrich queue never halts.
        if (!(e instanceof RemoteError) || e.code !== 'bad_request') {
          if (e instanceof RemoteError) circuit.recordFailure({ transient: e.transient, message: e.message })
          throw e
        }
        raw = textOf(await call(() => chat({ model, messages }, TIMEOUTS.classify)))
      }
      let parsed
      try {
        parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''))
      } catch {
        parsed = {}
      }
      return normaliseClassification(parsed, { hasImage, isUrl, text })
    },

    async describeImage({ absPath, prompt }) {
      guard('vision')
      const bytes = await readFile(absPath)
      const mime = MIME[path.extname(absPath).toLowerCase()] || 'image/png'
      const res = await call(() =>
        chat(
          {
            model: modelFor('vision'),
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: prompt || DESCRIBE_IMAGE_PROMPT },
                  { type: 'image_url', image_url: { url: `data:${mime};base64,${bytes.toString('base64')}` } },
                ],
              },
            ],
          },
          TIMEOUTS.vision,
        ),
      )
      // See the local provider: a reasoning model's <think> block must not
      // become the note's description or its embedding input.
      return stripThinking(textOf(res))
    },

    async answer({ question, contextNotes, history = [] }) {
      guard('llm')
      const res = await call(() =>
        chat(
          {
            model: modelFor('llm'),
            messages: [
              { role: 'system', content: answerSystemPrompt() },
              { role: 'user', content: answerUserPrompt({ question, contextNotes, history }) },
            ],
          },
          TIMEOUTS.answer,
        ),
      )
      return textOf(res)
    },

    // The remote endpoint is a plain request/response JSON API — there is no
    // token channel to forward. Emitting the finished answer as a single delta
    // keeps one code path in the route and the client: a remote provider just
    // streams in one piece.
    async answerStream({ question, contextNotes, history = [], onToken }) {
      const text = await this.answer({ question, contextNotes, history })
      if (text) onToken?.(text)
      return text
    },
  }
}

// ---- module singleton, what the facade resolves --------------------------
let singleton = null

export function capabilities() { return (singleton || boot({})).capabilities() }
export function roleEnabled(role) { return (singleton || boot({})).roleEnabled(role) }
export function available() { return (singleton || boot({})).available() }
export function validateModel(role, key) { return (singleton || boot({})).validateModel(role, key) }
export function statusSnapshot() { return (singleton || boot({})).statusSnapshot() }
export const listModels = (...a) => (singleton || boot({})).listModels(...a)
export const applySettings = (...a) => (singleton || boot({})).applySettings(...a)
export const classify = (...a) => (singleton || boot({})).classify(...a)
export const embedText = (...a) => (singleton || boot({})).embedText(...a)
export const describeImage = (...a) => (singleton || boot({})).describeImage(...a)
export const answer = (...a) => (singleton || boot({})).answer(...a)
export const shutdown = async () => { if (singleton) await singleton.shutdown() }

function boot(models) {
  singleton = createRemoteProvider({
    baseUrl: AI_BASE_URL,
    apiKey: AI_API_KEY,
    models: { llm: models.llm || '', embed: models.embed || '', vision: models.vision || '' },
  })
  return singleton
}

// Config arrives as { local, remote } — both selections, since the caller
// resolves settings before it knows which provider was chosen. This provider
// reads only the remote half.
export async function init({ remote = {} } = {}) {
  boot(remote)
  await singleton.init()
}
