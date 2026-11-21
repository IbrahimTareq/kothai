// Runtime configuration — the one place every path and the port are resolved
// from the environment. Defaults reproduce the pre-config behavior exactly, so
// an install that sets nothing behaves as it always has.
//
// Resolution order per value: specific env var → derived from KOTHAI_HOME → default.
// Vars are KOTHAI_-prefixed because PaaS and self-hosted environments inject a
// lot of generic names; PORT keeps its bare name since every platform sets it.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveAiConfig, type AiConfig, type AiCredentials } from './ai/endpoint-config.ts'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

// Written out rather than inferred, because 16 modules import the constants
// below: letting them infer from process.env (string | undefined) would push a
// wrong type into every one of those call sites at once.
interface Config {
  PORT: number
  DATA_DIR: string
  UPLOAD_DIR: string
  SETUP_PROVIDER: string | null
  ALLOW_PRIVATE_FETCH: boolean
  PASSWORD: string | null
}

// Exported pure so tests can exercise precedence without touching process.env.
export function resolveConfig(env: NodeJS.ProcessEnv = process.env, root: string = ROOT): Config {
  const home = env.KOTHAI_HOME ? path.resolve(root, env.KOTHAI_HOME) : null

  const pick = (name: string, leaf: string): string => {
    if (env[name]) return path.resolve(root, env[name])
    if (home) return path.join(home, leaf)
    return path.join(root, leaf)
  }

  const DATA_DIR = pick('KOTHAI_DATA_DIR', 'data')
  return {
    PORT: /^\d+$/.test(env.PORT ?? '') ? Number(env.PORT) : 5173,
    DATA_DIR,
    UPLOAD_DIR: path.join(DATA_DIR, 'uploads'),
    // Which provider the INSTALLER already asked about, so the first-run
    // screen does not ask again. An id from ai/endpoints.ts; an older
    // installer's 'local' (the removed on-device provider) matches none, so
    // first run asks as if nobody had. Never
    // a credential — the installer deliberately collects none, because a key
    // typed on a command line lands in shell history.
    SETUP_PROVIDER: env.KOTHAI_SETUP_PROVIDER || null,
    // Escape hatch for the outbound-fetch guard (server/lib/ssrf.ts): lets link
    // previews reach private/loopback addresses again, for people stashing
    // intranet links on a trusted LAN. Opt-in only, and the allowed spellings
    // are deliberately narrow — a typo must fail closed, since anything that
    // silently disables an SSRF guard is worse than no guard at all.
    ALLOW_PRIVATE_FETCH: ['1', 'true'].includes((env.KOTHAI_ALLOW_PRIVATE_FETCH || '').toLowerCase()),
    // Optional single password gating the whole app (server/lib/auth.ts).
    // Unset means no auth at all, which is the historical behavior and stays
    // the default: every LAN and Tailscale install must be unaffected by an
    // upgrade. Env-only, like the remote credentials above — it is never
    // written to SQLite, so it cannot leak through a backup or an export.
    PASSWORD: env.KOTHAI_PASSWORD || null,
  }
}

const config = Object.freeze(resolveConfig())

export const PORT: number = config.PORT
export const DATA_DIR: string = config.DATA_DIR
export const UPLOAD_DIR: string = config.UPLOAD_DIR
export const SETUP_PROVIDER: string | null = config.SETUP_PROVIDER
export const ALLOW_PRIVATE_FETCH: boolean = config.ALLOW_PRIVATE_FETCH
export const PASSWORD: string | null = config.PASSWORD

// ---- inference endpoint ---------------------------------------------------
// Resolved on demand rather than frozen at import, because the app can now be
// given an endpoint at runtime (server/data/credentials.ts) and must act on it
// without a container restart. Precedence and the env-wins-as-a-whole rule are
// documented where they are implemented, in server/ai/endpoint-config.ts.
export type { RoleEndpoint } from './ai/endpoint-config.ts'

// The credential file, loaded once at boot and refreshed whenever it is
// written. Kept here rather than read from disk on every access so that
// getAiConfig() stays synchronous for the many sync callers.
let aiCredentials: AiCredentials | null = null

export function setAiCredentials(creds: AiCredentials | null): void {
  aiCredentials = creds
}

export function getAiConfig(): AiConfig {
  return resolveAiConfig(process.env, aiCredentials)
}
