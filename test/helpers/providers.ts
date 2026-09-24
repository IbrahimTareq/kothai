// A complete Provider, so a test can stub only the members it is about.
//
// Four test files hand a fake provider to initProvider()'s `load` seam
// (ai-facade, setup-endpoint, settings-endpoint, reconfigure). Each hand-rolled
// its own object literal, and each broke the same two ways once checked:
// `statusSnapshot().roles.llm.state` widened to `string` instead of the literal
// union RoleStatus declares, and every member the file never calls — available,
// roleEnabled, classify, embedText, describeImage, answer — was simply absent,
// so the literal was not a Provider at all.
//
// Built at four callers, not at one: a fixture with a single caller is an
// abstraction waiting for a second opinion about what it should default to.
// Four call sites is enough evidence to shape one.
//
// Defaults are the emptiest legal provider rather than a plausible one: a test
// that depends on a value it did not stub should fail, not quietly pass on this
// file's opinion. That is why `capabilities()` reports no kind and claims
// nothing — every caller sets the kind, because the kind is what each of them
// is about.
import type { initProvider } from '../../server/ai/index.ts'
import type { ProviderKind } from '../../server/ai/routing.ts'
import type { Provider } from '../../server/ai/providers/types.ts'

// The `load` seam's own type, queried off initProvider rather than re-spelled:
// server/ai/index.ts derives ProviderLoader for itself and does not export it,
// and a second hand-written copy here would be the first thing to drift.
export type ProviderLoader = NonNullable<NonNullable<Parameters<typeof initProvider>[2]>['load']>

// The seam's `kind` is optional — the availability probe calls load() with no
// argument, because that path only cares whether resolving throws. No test
// that hands back a *per-kind* fake can survive that call: it would not know
// which fake to build. So the absence is refused here, once, instead of every
// caller either widening its fake's parameter or writing `kind!`.
export function loader(build: (kind: ProviderKind) => Provider | Promise<Provider>): ProviderLoader {
  return kind => {
    if (!kind) throw new Error('loader: the facade asked for a provider without naming its kind')
    return build(kind)
  }
}

export function provider(partial: Partial<Provider> = {}): Provider {
  return {
    init: async () => {},
    applySettings: async () => {},
    shutdown: async () => {},

    capabilities: () => ({ kind: '', managesResidency: false, downloadsWeights: false }),
    available: () => false,
    roleEnabled: () => false,
    statusSnapshot: () => ({
      // 'idle' at 0% is the state a role is in before anything has been asked
      // of it. Aggregate has no such member, so 'loading' at 0% is its
      // equivalent — 'ready' would be a claim, and a test asserting readiness
      // it never stubbed would pass on it.
      roles: {
        llm: { state: 'idle', progress: 0, message: '', model: '' },
        embed: { state: 'idle', progress: 0, message: '', model: '' },
        vision: { state: 'idle', progress: 0, message: '', model: '' },
      },
      aggregate: { state: 'loading', progress: 0, message: '' },
    }),
    listModels: async () => ({ llm: [], embed: [], vision: [] }),
    // `ok: true` with neither `error` nor `warning` is the empty result — "no
    // objection found" — and it is the only empty one available: `ok: false`
    // without an `error` is not a rejection any caller can render.
    validateModel: () => ({ ok: true }),

    classify: async () => ({ type: 'link', category: '', title: '', summary: '', tags: [] }),
    embedText: async () => [],
    describeImage: async () => '',
    answer: async () => '',

    // The seven optional members are deliberately left absent. That is what a
    // pure-remote provider looks like, and it is what makes the facade's
    // `L()?.boot?.() ?? Promise.resolve()` fallbacks reachable from a test.
    ...partial,
  }
}
