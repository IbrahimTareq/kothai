// The seam between the local provider and @qvac/sdk, so every on-device run
// is recorded (server/ai/usage.ts) while local.ts, which sits at its shape
// cap, does nothing more than import from here.
//
// Only the calls local.ts makes are wrapped. Their types are the SDK's own,
// which under tsconfig.server.json are `any`: the SDK's .d.ts files import
// extensionless paths that nodenext cannot follow, and skipLibCheck hides the
// failure. Narrowing them here broke local.ts, whose model ids arrive as
// unknown, so the one place this module reads the SDK's output names the
// fields it reads instead.
import { completion as sdkCompletion, embed as sdkEmbed } from '@qvac/sdk'
import { recordUsage } from '../usage.ts'

export { loadModel, unloadModel, close, cancel } from '@qvac/sdk'

// Rows say 'local' rather than naming a model. The SDK knows a run only by the
// random id loadModel handed out, and the step already says which role ran.
const MODEL = 'local'
const UNREPORTED = { inputTokens: null, outputTokens: null, cachedTokens: null, reasoningTokens: null, costUsd: null }

export function completion(params: Parameters<typeof sdkCompletion>[0]): ReturnType<typeof sdkCompletion> {
  const started = Date.now()
  const run = sdkCompletion(params)
  // A branch of its own off `final`, with both outcomes handled. The caller
  // still awaits the original promise and sees a cancellation or failure
  // exactly as before, and this branch can never become an unhandled
  // rejection.
  run.final.then(
    (f: { stats?: { promptTokens?: number; generatedTokens?: number; cacheTokens?: number } }) =>
      recordUsage({
        provider: 'local',
        model: MODEL,
        ok: true,
        status: null,
        ...UNREPORTED,
        inputTokens: f.stats?.promptTokens ?? null,
        outputTokens: f.stats?.generatedTokens ?? null,
        cachedTokens: f.stats?.cacheTokens ?? null,
        ms: Date.now() - started,
      }),
    () =>
      recordUsage({
        provider: 'local',
        model: MODEL,
        ok: false,
        status: null,
        ...UNREPORTED,
        ms: Date.now() - started,
      }),
  )
  return run
}

export async function embed(params: Parameters<typeof sdkEmbed>[0]): Promise<{ embedding: number[] }> {
  const started = Date.now()
  try {
    const res = await sdkEmbed(params)
    void recordUsage({
      provider: 'local',
      model: MODEL,
      ok: true,
      status: null,
      ...UNREPORTED,
      inputTokens: res.stats?.totalTokens ?? null,
      ms: Date.now() - started,
    })
    return res
  } catch (e) {
    void recordUsage({
      provider: 'local',
      model: MODEL,
      ok: false,
      status: null,
      ...UNREPORTED,
      ms: Date.now() - started,
    })
    throw e
  }
}
