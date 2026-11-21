// Remote inference over an OpenAI-compatible HTTP endpoint — Ollama,
// llama.cpp server, vLLM, OpenAI, OpenRouter, anything speaking /v1.
//
// Prompts and result normalisation come from the shared pure modules, so a
// note classified here was asked the same question and filtered the same way
// as one classified by the on-device provider this replaced.
//
// Each role calls its own endpoint (remote-endpoint.ts); roles naming the same
// URL and key share one. Credentials arrive from config and are never persisted
// or echoed back by any API response. Model NAMES come from settings, because
// they are the user's choice and vary per endpoint.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { FeatureDisabledError, ROLES } from '../roles.ts'
import type { Role, RoleStatus } from '../roles.ts'
import { Circuit } from '../circuit.ts'
import { createEndpoint } from './remote-endpoint.ts'
import type { Endpoint, RemoteEndpoint } from './remote-endpoint.ts'
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
import { postJson, TIMEOUTS, RemoteError } from './remote-http.ts'
import type {
  Aggregate,
  AnswerArgs,
  AnswerStreamArgs,
  ClassifyArgs,
  DescribeImageArgs,
  EmbedOptions,
  ModelOption,
  ModelSelection,
  Provider,
  ProviderStatus,
  ValidationResult,
} from './types.ts'

// Everything below the transport arrives as `unknown`: postJson hands back
// whatever the endpoint sent, which is the reason this guard exists
// at all. Local rather than shared: server/lib/ is the security floor and a
// guard added there needs a test that fails without it (CLAUDE.md).
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
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
// independent instances against a throwaway server. The one instance the
// facade resolves lives in remote-singleton.ts.
interface RemoteProviderOptions {
  endpoints: Record<Role, RemoteEndpoint>
  models: ModelSelection
  onRecover?: () => void
}

export function createRemoteProvider({ endpoints, models, onRecover }: RemoteProviderOptions) {
  // One breaker, catalogue and probe per distinct URL and key, shared by the
  // roles that name it. A role with no URL has no endpoint and is off.
  const byIdentity = new Map<string, Endpoint>()
  const endpointOf: Partial<Record<Role, Endpoint>> = {}
  for (const role of ROLES) {
    const { baseUrl, apiKey } = endpoints[role]
    if (!baseUrl) continue
    const id = `${baseUrl}\n${apiKey ?? ''}`
    const ep = byIdentity.get(id) ?? createEndpoint(endpoints[role], onRecover)
    byIdentity.set(id, ep)
    endpointOf[role] = ep
  }
  const distinct = () => [...byIdentity.values()]
  const breaker = () => new Circuit({ threshold: 5, cooldownMs: 60_000, onRecover })
  // A second breaker per role, for failures that belong to ONE role's model
  // rather than to the endpoint. With only the shared breaker, a Railway
  // install whose vision role named a text-only model got a 400 on every
  // thumbnail, and that 400 opened the circuit for classify and embed too — so
  // nothing was ever tagged or embedded. Outages, bad keys and rate limits are
  // still the endpoint's, and still stop every role ON that endpoint. Now that
  // a role can have an endpoint of its own, these and the per-endpoint breakers
  // together are also what keep one bad endpoint from stopping the roles that
  // are not on it.
  const roleCircuits: Record<Role, Circuit> = { llm: breaker(), embed: breaker(), vision: breaker() }

  const modelFor = (role: Role) => (models?.[role] || '').trim()

  // Returns the role's endpoint, so every caller past this point holds one
  // rather than re-proving the role has it.
  function guard(role: Role): Endpoint {
    const ep = endpointOf[role]
    if (!ep)
      throw new FeatureDisabledError(role, {
        code: `${role}_off`,
        message: 'No inference endpoint configured — set KOTHAI_AI_BASE_URL.',
      })
    if (!modelFor(role))
      throw new FeatureDisabledError(role, {
        code: `${role}_off`,
        message: `No ${role} model name configured — set one in Settings.`,
      })
    if (!ep.circuit.allow()) {
      throw new FeatureDisabledError(role, {
        code: 'circuit_open',
        message: `Inference endpoint is unavailable: ${ep.circuit.reason}`,
      })
    }
    if (!roleCircuits[role].allow()) {
      throw new FeatureDisabledError(role, {
        code: 'circuit_open',
        message: `The ${role} model was rejected: ${roleCircuits[role].reason}`,
      })
    }
    return ep
  }

  let embedWorked = false // has the embed model returned a vector? See recordFailure
  function recordSuccess(role: Role, ep: Endpoint) {
    if (role === 'embed') embedWorked = true
    ep.recordSuccess()
    roleCircuits[role].recordSuccess()
  }

  // 400 and 404 are answers about the request and the model named in it — a
  // model that cannot take images, an id the endpoint does not serve. Anything
  // else says the endpoint itself is down or refusing us.
  //
  // Once the embed model has returned a vector, an embed 400 is about that one
  // input and is not recorded: opening on it failed every note after a refused
  // one in a library re-embed, and counting it still stalled the sweep at five
  // refused notes in a row, every boot. Before that, it may be a model that
  // cannot embed at all, so it counts towards the threshold.
  function recordFailure(role: Role, ep: Endpoint, e: RemoteError) {
    const embedRefusal = role === 'embed' && e.code === 'bad_request'
    if (embedRefusal && embedWorked) return
    const breaker = e.code === 'bad_request' || e.code === 'model_not_found' ? roleCircuits[role] : ep.circuit
    const transient = e.transient || embedRefusal
    breaker.recordFailure({ transient, message: e.message, retryAfterMs: e.retryAfterMs })
  }

  // Every network call funnels through here so success/failure bookkeeping
  // for the circuit happens in exactly one place.
  async function call<T>(role: Role, ep: Endpoint, fn: () => Promise<T>): Promise<T> {
    try {
      const out = await fn()
      recordSuccess(role, ep)
      return out
    } catch (e) {
      if (e instanceof RemoteError) recordFailure(role, ep, e)
      throw e
    }
  }

  const chat = (ep: Endpoint, body: unknown, timeoutMs: number, retries?: number) =>
    postJson(ep.baseUrl, '/chat/completions', body, {
      apiKey: ep.apiKey,
      timeoutMs,
      ...(retries === undefined ? {} : { retries }),
    })
  // Same posture as remote-endpoint.ts's modelIds: a choice, message or
  // content that is not the shape the OpenAI wire format promises reads as no
  // text at all.
  const textOf = (r: unknown): string => {
    const choices = isRecord(r) ? r.choices : null
    const first: unknown = Array.isArray(choices) ? choices[0] : null
    const message = isRecord(first) ? first.message : null
    const content = isRecord(message) ? message.content : null
    return (typeof content === 'string' ? content : '').trim()
  }

  return {
    capabilities: () => ({ kind: 'remote' }),

    roleEnabled: (role: Role) => Boolean(endpointOf[role]) && Boolean(modelFor(role)),

    available: () => distinct().some(ep => ep.circuit.allow()),

    validateModel(role: Role, key: string): ValidationResult {
      const k = (key || '').trim()
      // Empty is how a role is switched off: a blank name is the only "off"
      // there is. Rejecting it left a
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
      const ep = endpointOf[role]
      const list = (role === 'embed' && ep?.embedCatalogue.length ? ep.embedCatalogue : ep?.catalogue) || []
      if (list.length && !list.includes(k))
        return { ok: true, warning: `"${k}" is not listed by the endpoint — saving anyway.` }
      return { ok: true }
    },

    async listModels(): Promise<Record<Role, ModelOption[]>> {
      // An endpoint still starting when init() ran answers with no models, and
      // that empty list used to be cached for the life of the process: on
      // Railway, Ollama pulls for minutes while Kothai boots in seconds, and the
      // picker stayed empty until a restart. The circuit bounds the re-probing.
      await Promise.all(distinct().map(ep => (!ep.catalogue.length && ep.circuit.allow() ? ep.probe() : null)))
      const asOpts = (ids: string[] = []): ModelOption[] => ids.map(id => ({ key: id, label: id }))
      const { llm, embed, vision } = endpointOf
      return {
        llm: asOpts(llm?.catalogue),
        embed: asOpts(embed?.embedCatalogue.length ? embed.embedCatalogue : embed?.catalogue),
        vision: asOpts(vision?.catalogue),
      }
    },

    // Each distinct endpoint is probed once, however many roles name it.
    async init() {
      await Promise.all(distinct().map(ep => ep.probe()))
    },

    async applySettings(patch: ModelSelection) {
      if (patch.embed !== undefined && patch.embed !== models?.embed) embedWorked = false
      models = { ...models, ...patch }
    },

    async shutdown() {},

    statusSnapshot(): ProviderStatus {
      // Named per role rather than accumulated into an empty object: a
      // Record<Role, RoleStatus> cannot be built up key by key without
      // asserting it is complete before it is.
      const statusFor = (role: Role): RoleStatus => {
        const model = modelFor(role)
        const ep = endpointOf[role]
        if (!ep || !model) return { state: 'off', progress: 0, message: '', model }
        if (!ep.circuit.allow()) return { state: 'error', progress: 0, message: ep.circuit.reason, model }
        if (ep.probeError) return { state: 'error', progress: 0, message: ep.probeError, model }
        if (!roleCircuits[role].allow())
          return { state: 'error', progress: 0, message: roleCircuits[role].reason, model }
        return { state: 'ready', progress: 100, message: 'Ready', model }
      }
      const roles: Record<Role, RoleStatus> = {
        llm: statusFor('llm'),
        embed: statusFor('embed'),
        vision: statusFor('vision'),
      }
      // No endpoint configured at all is AI-free mode, not a fault.
      const anyOn = ROLES.some(r => roles[r].state !== 'off')
      const broken = ROLES.find(r => roles[r].state === 'error')
      const ep = broken && endpointOf[broken]
      const aggregate: Aggregate =
        anyOn && broken && ep
          ? { state: 'error', progress: 0, message: ep.probeError || ep.circuit.reason || roles[broken].message }
          : { state: 'ready', progress: 100, message: 'Ready' }
      return { roles, aggregate }
    },

    // `mode` ('document' | 'query') selects the task prefix for
    // prompt-instructed embedding models, because the endpoint may well be
    // serving EmbeddingGemma — but keyed on
    // the configured model NAME, since it may equally be serving nomic, bge
    // or an OpenAI text-embedding-*, none of which want the prefix. See
    // prompts.ts's embedInput.
    async embedText(text: string, { mode = 'document' }: EmbedOptions = {}): Promise<number[]> {
      const ep = guard('embed')
      const clean = embedInput(clipToTokens(text), { mode, model: modelFor('embed') }) || ' '
      const res = await call('embed', ep, () =>
        postJson(
          ep.baseUrl,
          '/embeddings',
          { model: modelFor('embed'), input: clean },
          { apiKey: ep.apiKey, timeoutMs: TIMEOUTS.embed },
        ),
      )
      const data = isRecord(res) ? res.data : null
      const first: unknown = Array.isArray(data) ? data[0] : null
      const embedding = isRecord(first) ? first.embedding : null
      return Array.isArray(embedding) ? embedding : []
    },

    async classify({ text, now, knownTags = [], candidateTags = [] }: ClassifyArgs) {
      const ep = guard('llm')
      const messages = [
        { role: 'system', content: classifySystemPrompt({ now, knownTags, candidateTags }) },
        { role: 'user', content: classifyUserPrompt({ text }) },
      ]
      // As little reasoning as the model allows — see remote-http.ts's withLeastReasoning.
      const req = { model: modelFor('llm'), messages, reasoning_effort: 'none' }
      let raw = ''
      try {
        // Probe json_schema outside call() so a 400 "unsupported" does not open the
        // circuit before the plain retry. `strict`: Anthropic's endpoint 400s without it.
        raw = textOf(
          await chat(
            ep,
            {
              ...req,
              response_format: {
                type: 'json_schema',
                json_schema: { name: 'classification', strict: true, schema: CLASSIFY_SCHEMA },
              },
            },
            TIMEOUTS.classify,
          ),
        )
        recordSuccess('llm', ep)
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
          if (e instanceof RemoteError) recordFailure('llm', ep, e)
          throw e
        }
        raw = textOf(await call('llm', ep, () => chat(ep, req, TIMEOUTS.classify)))
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
      return normaliseClassification(parsed, text)
    },

    async describeImage({ absPath, prompt }: DescribeImageArgs): Promise<string> {
      const ep = guard('vision')
      const bytes = await readFile(absPath)
      const mime = MIME[path.extname(absPath).toLowerCase()] || 'image/png'
      const res = await call('vision', ep, () =>
        chat(
          ep,
          {
            model: modelFor('vision'),
            reasoning_effort: 'none',
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
      // A reasoning model's <think> block must not become the note's
      // description or its embedding input.
      return stripThinking(textOf(res))
    },

    async answer({ question, contextNotes, history = [] }: AnswerArgs): Promise<string> {
      const ep = guard('llm')
      const res = await call('llm', ep, () =>
        chat(
          ep,
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
