// Runtime configuration — the one place every path and the port are resolved
// from the environment. Defaults reproduce the pre-config behavior exactly, so
// an install that sets nothing behaves as it always has.
//
// Resolution order per value: specific env var → derived from STASH_HOME → default.
// Vars are STASH_-prefixed because PaaS and self-hosted environments inject a
// lot of generic names; PORT keeps its bare name since every platform sets it.
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

// Exported pure so tests can exercise precedence without touching process.env.
export function resolveConfig(env = process.env, root = ROOT) {
  const home = env.STASH_HOME ? path.resolve(root, env.STASH_HOME) : null

  const pick = (name, leaf) => {
    if (env[name]) return path.resolve(root, env[name])
    if (home) return path.join(home, leaf)
    return path.join(root, leaf)
  }

  const DATA_DIR = pick('STASH_DATA_DIR', 'data')
  return {
    PORT: /^\d+$/.test(env.PORT ?? '') ? Number(env.PORT) : 5173,
    DATA_DIR,
    UPLOAD_DIR: path.join(DATA_DIR, 'uploads'),
    MODELS_DIR: pick('STASH_MODELS_DIR', 'models'),
    CONFIG_PATH: pick('STASH_CONFIG_PATH', 'qvac.config.json'),
    // Which provider serves the embedding role when AI_PROVIDER is 'remote'.
    // Unset means "on-device if this image has a local provider" — see
    // ai/routing.js's resolveRoleProviders, which is also where an
    // unrecognised value is ignored rather than rejected here.
    AI_EMBED_PROVIDER: env.STASH_AI_EMBED_PROVIDER || null,
    // Which provider the INSTALLER already asked about, so the first-run
    // screen does not ask again. An id from ai/endpoints.js, or 'local'. Never
    // a credential — the installer deliberately collects none, because a key
    // typed on a command line lands in shell history.
    SETUP_PROVIDER: env.STASH_SETUP_PROVIDER || null,
    // Escape hatch for the outbound-fetch guard (server/lib/ssrf.js): lets link
    // previews reach private/loopback addresses again, for people stashing
    // intranet links on a trusted LAN. Opt-in only, and the allowed spellings
    // are deliberately narrow — a typo must fail closed, since anything that
    // silently disables an SSRF guard is worse than no guard at all.
    ALLOW_PRIVATE_FETCH: ['1', 'true'].includes((env.STASH_ALLOW_PRIVATE_FETCH || '').toLowerCase()),
    // Optional single password gating the whole app (server/lib/auth.js).
    // Unset means no auth at all, which is the historical behavior and stays
    // the default: every LAN and Tailscale install must be unaffected by an
    // upgrade. Env-only, like the remote credentials above — it is never
    // written to SQLite, so it cannot leak through a backup or an export.
    PASSWORD: env.STASH_PASSWORD || null,
  }
}

const config = Object.freeze(resolveConfig())

export const PORT = config.PORT
export const DATA_DIR = config.DATA_DIR
export const UPLOAD_DIR = config.UPLOAD_DIR
export const MODELS_DIR = config.MODELS_DIR
export const CONFIG_PATH = config.CONFIG_PATH
export const AI_EMBED_PROVIDER = config.AI_EMBED_PROVIDER
export const SETUP_PROVIDER = config.SETUP_PROVIDER
export const ALLOW_PRIVATE_FETCH = config.ALLOW_PRIVATE_FETCH
export const PASSWORD = config.PASSWORD

// ---- inference endpoint ---------------------------------------------------
// Resolved on demand rather than frozen at import, because the app can now be
// given an endpoint at runtime (server/data/credentials.js) and must act on it
// without a container restart.
//
// Precedence is env -> credential file -> nothing, and env wins as a PAIR: if
// STASH_AI_BASE_URL is set, the key must come from the environment too. Mixing
// a stored key into an operator-supplied URL would send a credential somewhere
// its owner never pointed it.
export function resolveAiConfig(env = process.env, creds = null) {
  const strip = u => u.replace(/\/+$/, '')
  // providerId only ever comes from the file: an operator setting an endpoint
  // by environment variable is naming a URL, not picking a catalogue entry.
  const source = env.STASH_AI_BASE_URL
    ? { baseUrl: strip(env.STASH_AI_BASE_URL), apiKey: env.STASH_AI_API_KEY || null, providerId: null }
    : creds?.baseUrl
      ? { baseUrl: strip(creds.baseUrl), apiKey: creds.apiKey || null, providerId: creds.providerId || null }
      : { baseUrl: null, apiKey: null, providerId: null }
  // An endpoint from either source implies remote. STASH_AI_PROVIDER=remote
  // with no URL stays remote too — that is the lite image's default, and it
  // produces the "set a base URL" state rather than a crash.
  const provider = env.STASH_AI_PROVIDER === 'remote' || source.baseUrl ? 'remote' : 'local'
  return { ...source, provider }
}

// The credential file, loaded once at boot and refreshed whenever it is
// written. Kept here rather than read from disk on every access so that
// getAiConfig() stays synchronous for the many sync callers.
let aiCredentials = null

export function setAiCredentials(creds) {
  aiCredentials = creds
}

export function getAiConfig() {
  return resolveAiConfig(process.env, aiCredentials)
}
