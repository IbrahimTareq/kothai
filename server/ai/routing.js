// Which provider serves which role, and how N providers' outputs merge back
// into the single shapes routes and the client already consume.
//
// Pure by design: no imports beyond ROLES, so every branch is unit-testable
// without a provider, an endpoint or @qvac/sdk. server/ai/index.js is the
// only caller.
import { ROLES } from './roles.js'

// The rule, in one place:
//   provider=local                       → every role on-device (unchanged).
//   provider=remote, no local provider   → every role remote (the lite image,
//                                          where @qvac/sdk isn't installed).
//   provider=remote, local available     → embedding stays on-device, the
//                                          language and vision roles go out.
//
// Embedding is the role singled out because it is the one a hosted endpoint
// frequently cannot serve at all — Ollama Cloud, Groq, Anthropic and
// OpenRouter expose no /embeddings — and the one whose model is small enough
// (~300 MB, CPU-only) to keep here regardless. STASH_AI_EMBED_PROVIDER=remote
// opts back into sending it out, for endpoints that do serve embeddings and
// installs that already have an index built that way.
export function resolveRoleProviders({ provider, embedProvider = null, localAvailable = false }) {
  if (provider !== 'remote') return { llm: 'local', embed: 'local', vision: 'local' }
  const embed = !localAvailable || embedProvider === 'remote' ? 'remote' : 'local'
  return { llm: 'remote', embed, vision: 'remote' }
}

// Distinct provider kinds a role map needs, so the facade initialises exactly
// the providers it will use and no more.
export function kindsInUse(byRole) {
  return [...new Set(ROLES.map((role) => byRole[role]))]
}
