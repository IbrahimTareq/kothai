// The provider contract, named.
//
// test/server/ai/providers/provider-contract.test.js runs one set of
// assertions against both providers because shape drift between them is the
// primary risk in this design — a note classified on-device and one classified
// against a remote endpoint must be indistinguishable downstream. That test can
// only check the surface it thought to call, and only once it runs. This is the
// same contract stated once, so drift is a typecheck error instead.
//
// Nothing here is a fresh vocabulary: the argument types are queried off the
// prompt builders and the normaliser both providers already forward to, and the
// result types come from routing.ts, which owns the shapes the facade merges.
// A contract restated by hand would be a second thing to keep in step.
import type { normaliseClassification } from '../normalise.ts'
import type { Preset } from '../presets.ts'
import type { answerUserPrompt, classifySystemPrompt, classifyUserPrompt } from '../prompts.ts'
import type { Residency, Role } from '../roles.ts'
import type { Capabilities, ProviderStatus } from '../routing.ts'

// Model names per role, as they come off the settings row: a preset key for
// the local provider, an endpoint-defined id for the remote one. Partial
// because a patch carries only the roles that changed.
export type ModelSelection = Partial<Record<Role, string>>

// Both halves of the settings, always — the facade resolves settings before it
// knows which provider was chosen, so each provider is handed the pair and
// reads its own half.
export interface ProviderConfig {
  local?: ModelSelection
  remote?: ModelSelection
}

// Queried off the prompt builders rather than restated: classify() forwards
// these fields straight into them in both providers, so what a prompt needs IS
// what the contract accepts, and a change to one is a typecheck error in the
// other.
export type ClassifyArgs = Parameters<typeof classifySystemPrompt>[0] & Parameters<typeof classifyUserPrompt>[0]
export type AnswerArgs = Parameters<typeof answerUserPrompt>[0]

// Same reasoning for the result: normaliseClassification is the last thing
// both classify() paths call, so its return is the shape downstream sees.
export type Classification = ReturnType<typeof normaliseClassification>

export interface AnswerStreamArgs extends AnswerArgs {
  onToken?: (text: string) => void
  signal?: AbortSignal
}

export interface EmbedOptions {
  // 'document' (a note being indexed) or 'query' (a question being asked) —
  // see prompts.ts's embedInput for why the two are not the same text.
  mode?: 'document' | 'query'
}

export interface DescribeImageArgs {
  absPath: string
  prompt?: string
}

// A preset with its byte size resolved. The local provider reads sizes from the
// SDK registry; the remote one has no download to size and reports 0.
export interface ModelOption extends Preset {
  sizeBytes: number
}

// `ok: false` is a rejection and `warning` is a "saved anyway" note — the
// remote provider's catalogue can be stale or the endpoint down, and neither
// may block saving settings.
export interface ValidationResult {
  ok: boolean
  error?: string
  warning?: string
}

export interface Provider {
  init(config?: ProviderConfig): Promise<void>
  applySettings(patch: ModelSelection): Promise<void>
  shutdown(): Promise<void>

  capabilities(): Capabilities
  available(): boolean
  roleEnabled(role: Role): boolean
  statusSnapshot(): ProviderStatus
  listModels(): Promise<Record<Role, ModelOption[]>>
  validateModel(role: Role, key: string): ValidationResult

  classify(args: ClassifyArgs): Promise<Classification>
  embedText(text: string, opts?: EmbedOptions): Promise<number[]>
  describeImage(args: DescribeImageArgs): Promise<string>
  answer(args: AnswerArgs): Promise<string>

  // Optional, and the remote module genuinely has none of them.
  //
  // answerStream: the endpoint is a plain request/response JSON API with no
  // token channel to forward. server/ai/index.js falls back to emitting the
  // finished answer as one delta, so the route and the client never branch on
  // which provider is configured.
  //
  // The rest are all about weights on THIS machine — residency, downloads,
  // boot — which is exactly what capabilities().managesResidency and
  // .downloadsWeights report false for on remote. The facade resolves each to
  // a no-op when there is no local provider.
  answerStream?(args: AnswerStreamArgs): Promise<string>
  boot?(): Promise<void>
  warmRole?(role: Role): Promise<void>
  warmCache?(residency: Residency): Promise<void>
  applyResidency?(residency: Residency): Promise<void>
  configureModels?(selection: ModelSelection): Promise<void>
  weightsInUse?(selection?: ModelSelection): Record<string, Role>
}

// The assertion form. `export type X = ProviderModule<typeof import('./y.ts')>`
// at the foot of a provider fails the constraint — naming the member and both
// signatures — the moment that module's exports drift from Provider. It is a
// type query, so it imports nothing and costs nothing at runtime; the alias has
// to be exported only because noUnusedLocals rejects an unread one.
export type ProviderModule<T extends Provider> = T
