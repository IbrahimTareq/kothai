// The provider contract, named.
//
// Written when an on-device provider sat beside the remote one and shape drift
// between them was the primary risk: a note classified on-device and one
// classified against an endpoint had to be indistinguishable downstream. One
// provider is left, and the contract still states once what the facade, the
// test fakes (test/helpers/providers.ts) and provider-contract.test.ts agree
// on, so drift is a typecheck error rather than a test that never ran.
//
// Nothing here is a fresh vocabulary: the argument types are queried off the
// prompt builders and the normaliser the provider already forwards to. A
// contract restated by hand would be a second thing to keep in step.
import type { normaliseClassification } from '../normalise.ts'
import type { answerUserPrompt, classifySystemPrompt, classifyUserPrompt } from '../prompts.ts'
import type { Role, RoleStatus } from '../roles.ts'

// Endpoint-defined model ids per role, as they come off the settings row.
// Partial because a patch carries only the roles that changed.
export type ModelSelection = Partial<Record<Role, string>>

// The single progress/fault signal the client's status bar renders. The
// remote provider derives it from its circuit breakers.
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
}

// Queried off the prompt builders rather than restated: classify() forwards
// these fields straight into them, so what a prompt needs IS
// what the contract accepts, and a change to one is a typecheck error in the
// other.
export type ClassifyArgs = Parameters<typeof classifySystemPrompt>[0] & Parameters<typeof classifyUserPrompt>[0]
export type AnswerArgs = Parameters<typeof answerUserPrompt>[0]

// Same reasoning for the result: normaliseClassification is the last thing
// classify() calls, so its return is the shape downstream sees.
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

// One entry of an endpoint's model catalogue.
export interface ModelOption {
  key: string
  label: string
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
  init(models?: ModelSelection): Promise<void>
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

  // Optional. The endpoint is a plain request/response JSON API with no token
  // channel to forward, so server/ai/index.ts falls back to emitting the
  // finished answer as one delta, and the route and the client never branch
  // on whether the provider streams.
  answerStream?(args: AnswerStreamArgs): Promise<string>

  // Optional so a test's fake provider need not have a circuit. See circuit.ts.
  onRecover?(fn: () => void): void
}
