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
// file's opinion. That is why `capabilities()` reports no kind.
import type { Provider } from '../../server/ai/providers/types.ts'

export function provider(partial: Partial<Provider> = {}): Provider {
  return {
    init: async () => {},
    applySettings: async () => {},
    shutdown: async () => {},

    capabilities: () => ({ kind: '' }),
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

    // The optional members (answerStream, onRecover) are deliberately left
    // absent: it is what makes the facade's streaming fallback reachable from
    // a test.
    ...partial,
  }
}
