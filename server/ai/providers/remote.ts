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
import { getAiConfig } from '../../config.ts'
import { findEndpoint } from '../endpoints.ts'
import { FeatureDisabledError, ROLES } from '../roles.ts'
import type { Role, RoleStatus } from '../roles.ts'
import type { Aggregate, ProviderStatus } from '../routing.ts'
import { Circuit } from '../circuit.ts'
import {
  CLASSIFY_SCHEMA,
  DESCRIBE_IMAGE_PROMPT,
  classifySystemPrompt,
  classifyUserPrompt,
  answerSystemPrompt,
  answerUserPrompt,
  embedInput,
  clipToTokens,
} from '../prompts.ts'
import { normaliseClassification, stripThinking } from '../normalise.ts'
import { postJson, getJson, TIMEOUTS, RemoteError } from './remote-http.ts'
import type {
  AnswerArgs,
  AnswerStreamArgs,
  ClassifyArgs,
  DescribeImageArgs,
  EmbedOptions,
  ModelOption,
  ModelSelection,
  Provider,
  ProviderConfig,
  ProviderModule,
  ValidationResult,
} from './types.ts'

// Everything below the transport arrives as `unknown`: postJson and getJson
// hand back whatever the endpoint sent, which is the reason this guard exists
// at all. Local rather than shared: server/lib/ is the security floor and a
// guard added there needs a test that fails without it (CLAUDE.md).
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

// The `{ data: [{ id }] }` list both /models and the embeddings catalogue
// answer with. A non-object row or a non-string id reads as absent rather than
// being trusted into the catalogue the settings UI offers.
function modelIds(payload: unknown): string[] {
  const data = isRecord(payload) ? payload.data : null
  if (!Array.isArray(data)) return []
  const ids: string[] = []
  for (const row of data) {
    const id = isRecord(row) ? row.id : null
    if (typeof id === 'string' && id) ids.push(id)
  }
  return ids
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
}

// Factory rather than module-level state so tests can drive several
// independent instances against a throwaway server. The module's default
// export set (bottom of file) is the singleton the facade resolves.
interface RemoteProviderOptions {
  // '' rather than null for "no endpoint configured". Every read of it here is
  // a truthiness check, and one falsy spelling is what keeps the postJson calls
  // behind guard() from having to re-prove it is a string.
  baseUrl: string
  apiKey: string | null
  models: ModelSelection
  embeddingsPath?: string
}

export function createRemoteProvider({ baseUrl, apiKey, models, embeddingsPath = '' }: RemoteProviderOptions) {
  const circuit = new Circuit({ threshold: 5, cooldownMs: 60_000 })
  // A second breaker per role, for failures that belong to ONE role's model
  // rather than to the endpoint. With only the shared breaker, a Railway
  // install whose vision role named a text-only model got a 400 on every
  // thumbnail, and that 400 opened the circuit for classify and embed too — so
  // nothing was ever tagged or embedded. Outages, bad keys and rate limits are
  // still the endpoint's, and still stop every role.
  const roleCircuits: Record<Role, Circuit> = {
    llm: new Circuit({ threshold: 5, cooldownMs: 60_000 }),
    embed: new Circuit({ threshold: 5, cooldownMs: 60_000 }),
    vision: new Circuit({ threshold: 5, cooldownMs: 60_000 }),
  }
  let catalogue: string[] = []
  // Some providers keep their embedding models out of /models entirely —
  // OpenRouter lists hundreds of chat models there and not one embedding, and
  // serves the real list from a path of its own. When the catalogue entry names
  // that path, the embedding role gets its own list; otherwise it shares the
  // one catalogue, which is what every other provider needs.
  let embedCatalogue: string[] = []
  let probeError = ''

  const modelFor = (role: Role) => (models?.[role] || '').trim()

  function guard(role: Role) {
    if (!baseUrl)
      throw new FeatureDisabledError(role, {
        code: `${role}_off`,
        message: 'No inference endpoint configured — set KOTHAI_AI_BASE_URL.',
      })
    if (!modelFor(role))
      throw new FeatureDisabledError(role, {
        code: `${role}_off`,
        message: `No ${role} model name configured — set one in Settings.`,
      })
    if (!circuit.allow()) {
      throw new FeatureDisabledError(role, {
        code: 'circuit_open',
        message: `Inference endpoint is unavailable: ${circuit.reason}`,
      })
    }
    if (!roleCircuits[role].allow()) {
      throw new FeatureDisabledError(role, {
        code: 'circuit_open',
        message: `The ${role} model was rejected: ${roleCircuits[role].reason}`,
      })
    }
  }

  function recordSuccess(role: Role) {
    circuit.recordSuccess()
    roleCircuits[role].recordSuccess()
    if (probeError) probeError = ''
  }

  // 400 and 404 are answers about the request and the model named in it — a
  // model that cannot take images, an id the endpoint does not serve. Anything
  // else says the endpoint itself is down or refusing us.
  function recordFailure(role: Role, e: RemoteError) {
    const breaker = e.code === 'bad_request' || e.code === 'model_not_found' ? roleCircuits[role] : circuit
    breaker.recordFailure({ transient: e.transient, message: e.message, retryAfterMs: e.retryAfterMs })
  }

  // Every network call funnels through here so success/failure bookkeeping
  // for the circuit happens in exactly one place.
  async function call<T>(role: Role, fn: () => Promise<T>): Promise<T> {
    try {
      const out = await fn()
      recordSuccess(role)
      return out
    } catch (e) {
      if (e instanceof RemoteError) recordFailure(role, e)
      throw e
    }
  }

  const chat = (body: unknown, timeoutMs: number, retries?: number) =>
    postJson(baseUrl, '/chat/completions', body, { apiKey, timeoutMs, ...(retries === undefined ? {} : { retries }) })
  // Same posture as modelIds: a choice, message or content that is not the
  // shape the OpenAI wire format promises reads as no text at all.
  const textOf = (r: unknown): string => {
    const choices = isRecord(r) ? r.choices : null
    const first: unknown = Array.isArray(choices) ? choices[0] : null
    const message = isRecord(first) ? first.message : null
    const content = isRecord(message) ? message.content : null
    return (typeof content === 'string' ? content : '').trim()
  }

  return {
    capabilities: () => ({ kind: 'remote', managesResidency: false, downloadsWeights: false }),

    roleEnabled: (role: Role) => Boolean(baseUrl) && Boolean(modelFor(role)),

    available: () => Boolean(baseUrl) && circuit.allow(),

    validateModel(role: Role, key: string): ValidationResult {
      const k = (key || '').trim()
      // Empty is how a role is switched off: an endpoint has no residency to
      // set, so a blank name is the only "off" there is. Rejecting it left a
      // Railway install stuck with vision naming a text-only model and no way
      // to clear it — every thumbnail drew a 400 from Ollama.
      if (!k) return { ok: true }
      if (k.length > 200) return { ok: false, error: `${role} model name is too long` }
      // Deliberately a warning, not a rejection: the catalogue can be stale
      // or unavailable, and saving settings must not depend on the endpoint
      // being up right now.
      // Checked against the list that actually covers this role, or the
      // correct embedding id would be warned about for missing a chat list it
      // was never going to be in.
      const list = role === 'embed' && embedCatalogue.length ? embedCatalogue : catalogue
      if (list.length && !list.includes(k))
        return { ok: true, warning: `"${k}" is not listed by the endpoint — saving anyway.` }
      return { ok: true }
    },

    async listModels(): Promise<Record<Role, ModelOption[]>> {
      // An endpoint still starting when init() ran answers with no models, and
      // that empty list used to be cached for the life of the process: on
      // Railway, Ollama pulls for minutes while Kothai boots in seconds, and the
      // picker stayed empty until a restart. The circuit bounds the re-probing.
      if (baseUrl && !catalogue.length && circuit.allow()) await this.init()
      const asOpts = (ids: string[]): ModelOption[] =>
        ids.map(id => ({ key: id, label: id, desc: '', best: [], sizeBytes: 0 }))
      const opts = asOpts(catalogue)
      return { llm: opts, embed: embedCatalogue.length ? asOpts(embedCatalogue) : opts, vision: opts }
    },

    // One probe, best-effort. A failure here is reported in the status
    // aggregate but never throws — the app must still serve notes when the
    // inference endpoint is down.
    async init() {
      if (!baseUrl) return
      try {
        // retries:0 — a probe is a question about right now, and something is
        // waiting on the answer (boot, or the wizard's Test connection button).
        const res = await getJson(baseUrl, '/models', { apiKey, timeoutMs: TIMEOUTS.probe, retries: 0 })
        catalogue = modelIds(res)
        probeError = ''
        circuit.recordSuccess()
        // Best-effort and deliberately after the success bookkeeping above: a
        // provider that answers /models is up, and failing to fetch a nicety
        // must not mark it down or cost the chat roles anything.
        if (embeddingsPath) {
          try {
            const em = await getJson(baseUrl, embeddingsPath, { apiKey, timeoutMs: TIMEOUTS.probe, retries: 0 })
            embedCatalogue = modelIds(em)
          } catch {
            embedCatalogue = []
          }
        }
      } catch (e) {
        // `e.transient !== false` was the old read, and it has to survive the
        // narrowing: a failure that is NOT a RemoteError carried no transient
        // flag, `undefined !== false` was true, and treating an unclassified
        // probe failure as transient is what keeps it from opening the circuit
        // on the first try.
        const remote = e instanceof RemoteError ? e : null
        probeError = e instanceof Error ? e.message : String(e)
        circuit.recordFailure({
          transient: remote?.transient !== false,
          message: probeError,
          retryAfterMs: remote?.retryAfterMs || 0,
        })
      }
    },

    async applySettings(patch: ModelSelection) {
      models = { ...models, ...patch }
    },

    async shutdown() {},

    statusSnapshot(): ProviderStatus {
      // Named per role rather than accumulated into an empty object: a
      // Record<Role, RoleStatus> cannot be built up key by key without
      // asserting it is complete before it is.
      const statusFor = (role: Role): RoleStatus => {
        const model = modelFor(role)
        if (!baseUrl || !model) return { state: 'off', progress: 0, message: '', model }
        if (!circuit.allow()) return { state: 'error', progress: 0, message: circuit.reason, model }
        if (probeError) return { state: 'error', progress: 0, message: probeError, model }
        if (!roleCircuits[role].allow())
          return { state: 'error', progress: 0, message: roleCircuits[role].reason, model }
        return { state: 'ready', progress: 100, message: 'Ready', model }
      }
      const roles: Record<Role, RoleStatus> = {
        llm: statusFor('llm'),
        embed: statusFor('embed'),
        vision: statusFor('vision'),
      }
      // No endpoint configured at all is AI-free mode, not a fault — the same
      // state local reports when every role's residency is 'off'.
      const anyOn = ROLES.some(r => roles[r].state !== 'off')
      const broken = ROLES.find(r => roles[r].state === 'error')
      const aggregate: Aggregate =
        anyOn && broken
          ? { state: 'error', progress: 0, message: probeError || circuit.reason || roles[broken].message }
          : { state: 'ready', progress: 100, message: 'Ready' }
      return { roles, aggregate }
    },

    // `mode` ('document' | 'query') selects the task prefix for
    // prompt-instructed embedding models. Applied here too, not just locally,
    // because the endpoint may well be serving EmbeddingGemma — but keyed on
    // the configured model NAME, since it may equally be serving nomic, bge
    // or an OpenAI text-embedding-*, none of which want the prefix. See
    // prompts.ts's embedInput.
    async embedText(text: string, { mode = 'document' }: EmbedOptions = {}): Promise<number[]> {
      guard('embed')
      const clean = embedInput(clipToTokens(text), { mode, model: modelFor('embed') }) || ' '
      const res = await call('embed', () =>
        postJson(
          baseUrl,
          '/embeddings',
          { model: modelFor('embed'), input: clean },
          { apiKey, timeoutMs: TIMEOUTS.embed },
        ),
      )
      const data = isRecord(res) ? res.data : null
      const first: unknown = Array.isArray(data) ? data[0] : null
      const embedding = isRecord(first) ? first.embedding : null
      return Array.isArray(embedding) ? embedding : []
    },

    async classify({ text, hasImage, isUrl, now, knownTags = [], candidateTags = [] }: ClassifyArgs) {
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
          await chat(
            {
              model,
              messages,
              response_format: {
                type: 'json_schema',
                json_schema: { name: 'classification', schema: CLASSIFY_SCHEMA },
              },
            },
            TIMEOUTS.classify,
          ),
        )
        recordSuccess('llm')
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
          if (e instanceof RemoteError) recordFailure('llm', e)
          throw e
        }
        raw = textOf(await call('llm', () => chat({ model, messages }, TIMEOUTS.classify)))
      }
      // Annotated, not narrowed: normaliseClassification's own parameter type
      // is all-optional and all-unknown precisely because this is the model's
      // raw answer, so a guard here would only re-decide what it already does.
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''))
      } catch {
        parsed = {}
      }
      return normaliseClassification(parsed, { hasImage, isUrl, text })
    },

    async describeImage({ absPath, prompt }: DescribeImageArgs): Promise<string> {
      guard('vision')
      const bytes = await readFile(absPath)
      const mime = MIME[path.extname(absPath).toLowerCase()] || 'image/png'
      const res = await call('vision', () =>
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

    async answer({ question, contextNotes, history = [] }: AnswerArgs): Promise<string> {
      guard('llm')
      const res = await call('llm', () =>
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
    async answerStream({ question, contextNotes, history = [], onToken }: AnswerStreamArgs): Promise<string> {
      const text = await this.answer({ question, contextNotes, history })
      if (text) onToken?.(text)
      return text
    },
  } satisfies Provider
}

// ---- module singleton, what the facade resolves --------------------------
let singleton: Provider | null = null

export function capabilities() {
  return (singleton || boot({})).capabilities()
}
export function roleEnabled(role: Role) {
  return (singleton || boot({})).roleEnabled(role)
}
export function available() {
  return (singleton || boot({})).available()
}
export function validateModel(role: Role, key: string) {
  return (singleton || boot({})).validateModel(role, key)
}
export function statusSnapshot() {
  return (singleton || boot({})).statusSnapshot()
}
export const listModels = (...a: Parameters<Provider['listModels']>) => (singleton || boot({})).listModels(...a)
export const applySettings = (...a: Parameters<Provider['applySettings']>) =>
  (singleton || boot({})).applySettings(...a)
export const classify = (...a: Parameters<Provider['classify']>) => (singleton || boot({})).classify(...a)
export const embedText = (...a: Parameters<Provider['embedText']>) => (singleton || boot({})).embedText(...a)
export const describeImage = (...a: Parameters<Provider['describeImage']>) =>
  (singleton || boot({})).describeImage(...a)
export const answer = (...a: Parameters<Provider['answer']>) => (singleton || boot({})).answer(...a)
export const shutdown = async () => {
  if (singleton) await singleton.shutdown()
}

function boot(models: ModelSelection): Provider {
  // Read at boot, not at import: this is what makes re-pointing the endpoint a
  // matter of calling init() again rather than restarting the container.
  const { baseUrl, apiKey, providerId } = getAiConfig()
  singleton = createRemoteProvider({
    // '' is this provider's spelling of "no endpoint configured" — see
    // RemoteProviderOptions.
    baseUrl: baseUrl || '',
    apiKey,
    // Per-provider quirks live in the catalogue, not in this transport.
    embeddingsPath: findEndpoint(providerId)?.embeddingsPath || '',
    models: { llm: models.llm || '', embed: models.embed || '', vision: models.vision || '' },
  })
  return singleton
}

// Config arrives as { local, remote } — both selections, since the caller
// resolves settings before it knows which provider was chosen. This provider
// reads only the remote half.
export async function init({ remote = {} }: ProviderConfig = {}) {
  // boot() returns the singleton it just installed, so this is the same object
  // the module-level forwarders above will resolve.
  await boot(remote).init()
}

// See types.ts: the module's own exports, checked against the contract. This is
// the object server/ai/index.ts resolves — the factory above is asserted
// separately, because the cross-provider contract test drives an instance of it
// rather than this namespace.
export type RemoteProvider = ProviderModule<typeof import('./remote.ts')>
