import { findEndpoint } from './endpoints.ts'
import { ROLES, type Role } from './roles.ts'

// ---- inference endpoint resolution ----------------------------------------
// Precedence is env -> credential file -> nothing, and env wins as a PAIR: if
// KOTHAI_AI_BASE_URL is set, the key must come from the environment too. Mixing
// a stored key into an operator-supplied URL would send a credential somewhere
// its owner never pointed it. The same holds per role (a role's env URL takes
// only its own env key, never the shared one), and it holds for the file as a
// whole: if ANY *_BASE_URL env var is set the credential file is ignored, since
// a stored role key could otherwise be paired with a URL the operator set.
//
// Every field is nullable on the way in: the file may hold a URL with no key
// (a local Ollama needs none), and readCredentials() itself returns null when
// there is no file at all.
export interface RoleEndpoint {
  baseUrl: string | null
  apiKey: string | null
  providerId: string | null
}

export interface AiCredentials extends Partial<RoleEndpoint> {
  roles?: Partial<Record<Exclude<Role, 'llm'>, RoleEndpoint>>
}

export interface AiConfig {
  roles: Record<Role, RoleEndpoint>
  envModels: Partial<Record<Role, string>>
  source: 'env' | 'file' | 'none'
}

const NO_ENDPOINT: RoleEndpoint = { baseUrl: null, apiKey: null, providerId: null }

export function resolveAiConfig(env: NodeJS.ProcessEnv = process.env, creds: AiCredentials | null = null): AiConfig {
  const strip = (u: string): string => u.replace(/\/+$/, '')
  const envModels: Partial<Record<Role, string>> = {}
  if (env.KOTHAI_AI_LLM_MODEL) envModels.llm = env.KOTHAI_AI_LLM_MODEL
  if (env.KOTHAI_AI_VISION_MODEL) envModels.vision = env.KOTHAI_AI_VISION_MODEL
  if (env.KOTHAI_AI_EMBED_MODEL) envModels.embed = env.KOTHAI_AI_EMBED_MODEL

  const envMode = !!(env.KOTHAI_AI_BASE_URL || env.KOTHAI_AI_VISION_BASE_URL || env.KOTHAI_AI_EMBED_BASE_URL)
  let roles: Record<Role, RoleEndpoint>
  let source: AiConfig['source']
  if (envMode) {
    // providerId only ever comes from the file: an operator setting an endpoint
    // by environment variable is naming a URL, not picking a catalogue entry.
    const pair = (url: string | undefined, key: string | undefined): RoleEndpoint =>
      url ? { baseUrl: strip(url), apiKey: key || null, providerId: null } : NO_ENDPOINT
    const llm = pair(env.KOTHAI_AI_BASE_URL, env.KOTHAI_AI_API_KEY)
    roles = {
      llm,
      vision: env.KOTHAI_AI_VISION_BASE_URL ? pair(env.KOTHAI_AI_VISION_BASE_URL, env.KOTHAI_AI_VISION_API_KEY) : llm,
      embed: env.KOTHAI_AI_EMBED_BASE_URL ? pair(env.KOTHAI_AI_EMBED_BASE_URL, env.KOTHAI_AI_EMBED_API_KEY) : llm,
    }
    source = 'env'
  } else {
    const entry = (e: Partial<RoleEndpoint> | undefined): RoleEndpoint =>
      e?.baseUrl
        ? { baseUrl: strip(e.baseUrl), apiKey: e.apiKey || null, providerId: e.providerId || null }
        : NO_ENDPOINT
    const shared = entry(creds ?? undefined)
    // Borrowing an endpoint that serves no embeddings (Claude) is no endpoint
    // at all for that role: embeddings and every re-embed went to Claude's
    // URL and failed on every note. Decided here, so boot, roleEnabled and the
    // settings route's re-embed check cannot disagree. Env names no catalogue
    // entry (providerId is always null there), so this is file mode only.
    const chatOnly = findEndpoint(shared.providerId)?.servesEmbeddings === false
    const roleEntry = (role: 'vision' | 'embed'): RoleEndpoint => {
      const own = entry(creds?.roles?.[role])
      if (own.baseUrl) return own
      return role === 'embed' && chatOnly ? NO_ENDPOINT : shared
    }
    roles = { llm: shared, vision: roleEntry('vision'), embed: roleEntry('embed') }
    const any = ROLES.some(r => roles[r].baseUrl)
    source = any ? 'file' : 'none'
  }
  return { roles, envModels, source }
}
