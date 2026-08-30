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
    // Inference provider. Selection is always explicit — an unknown value
    // falls back to local rather than throwing, so a typo degrades to the
    // historical behavior instead of refusing to boot.
    AI_PROVIDER: env.STASH_AI_PROVIDER === 'remote' ? 'remote' : 'local',
    // Remote credentials are env-only, never persisted to SQLite and never
    // returned by any API response — so they can't leak via a backup or an
    // export. Model NAMES are user-editable and live in the settings table.
    AI_BASE_URL: env.STASH_AI_BASE_URL ? env.STASH_AI_BASE_URL.replace(/\/+$/, '') : null,
    AI_API_KEY: env.STASH_AI_API_KEY || null,
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
export const AI_PROVIDER = config.AI_PROVIDER
export const AI_BASE_URL = config.AI_BASE_URL
export const AI_API_KEY = config.AI_API_KEY
export const ALLOW_PRIVATE_FETCH = config.ALLOW_PRIVATE_FETCH
export const PASSWORD = config.PASSWORD
