// Inference facade — the single module the rest of the app imports.
//
// Every role (llm / embed / vision) is served by the remote provider, each on
// its own endpoint (providers/remote.ts). The facade adds the usage step label
// around each call and the streaming fallback, and holds the one seam tests
// use to swap the provider for a fake.
//
// Sync accessors (statusSnapshot, roleEnabled) throw if called before
// initProvider(). That is safe because server/index.ts awaits initProvider()
// before the HTTP server listens and before Telegram capture starts, so no
// request and no captured message can arrive first.
import { remoteProvider } from './providers/remote-singleton.ts'
import { withStep } from './usage.ts'
import type { Role } from './roles.ts'
import type {
  AnswerStreamArgs,
  ModelOption,
  ModelSelection,
  Provider,
  ProviderStatus,
  ValidationResult,
} from './providers/types.ts'

export { FeatureDisabledError } from './roles.ts'
export { DEFAULTS } from './presets.ts'
export { normaliseClassification, isJunkTag, heuristicType, deriveTitle, isLikelyUrl } from './normalise.ts'

// The test seam: `load()` hands back a fake provider instead of the real one.
interface InitOptions {
  load?: (() => Provider | Promise<Provider>) | null
}

let impl: Provider | null = null

// The provider every call goes through.
function R(): Provider {
  if (!impl) throw new Error('AI provider not initialised — initProvider() must run before this call')
  return impl
}

export function _reset(): void {
  impl = null
}

// Published only once init() has succeeded: assigning first would let a throw
// leave a provider that never initialised, and the retry would short-circuit
// on the guard below and hand it out.
export async function initProvider(models: ModelSelection = {}, { load = null }: InitOptions = {}): Promise<Provider> {
  if (impl) return impl
  const next = load ? await load() : remoteProvider
  await next.init(models)
  impl = next
  return impl
}

// Re-point the provider after an endpoint or its key changes, so a credential
// saved in the browser takes effect without a container restart: the remote
// provider reads its endpoints from config in init(), so re-running init() is
// precisely what re-points it.
export async function reconfigure(models: ModelSelection = {}, { load = null }: InitOptions = {}): Promise<void> {
  R()
  const next = load ? await load() : remoteProvider
  await next.init(models)
  impl = next
}

export const statusSnapshot = (): ProviderStatus => R().statusSnapshot()
export const listModels = (): Promise<Record<Role, ModelOption[]>> => R().listModels()
export const available = (): boolean => R().available()
export const roleEnabled = (role: Role): boolean => R().roleEnabled(role)
export const validateModel = (role: Role, key: string): ValidationResult => R().validateModel(role, key)
export const applySettings = (patch: ModelSelection = {}): Promise<void> => R().applySettings(patch)
export const shutdown = async (): Promise<void> => {
  if (impl) await impl.shutdown()
}

export const classify = (...a: Parameters<Provider['classify']>): ReturnType<Provider['classify']> =>
  withStep('classify', () => R().classify(...a))
export const embedText = (...a: Parameters<Provider['embedText']>): ReturnType<Provider['embedText']> =>
  withStep('embed', () => R().embedText(...a))
export const describeImage = (...a: Parameters<Provider['describeImage']>): ReturnType<Provider['describeImage']> =>
  withStep('vision', () => R().describeImage(...a))
export const answer = (...a: Parameters<Provider['answer']>): ReturnType<Provider['answer']> =>
  withStep('answer', () => R().answer(...a))
// Streaming answers, with a fallback for any provider that doesn't implement
// them: the whole answer arrives as one delta, so callers never branch on
// whether the provider can stream.
export const answerStream = (args: AnswerStreamArgs): Promise<string> =>
  withStep('answer', async () => {
    const p = R()
    if (p.answerStream) return p.answerStream(args)
    const text = await p.answer(args)
    if (text) args?.onToken?.(text)
    return text
  })
