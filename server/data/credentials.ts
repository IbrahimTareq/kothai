// Inference credentials — the endpoint base URL and its API key.
//
// Deliberately NOT in SQLite. /api/backup is a VACUUM INTO over the whole
// database (server/routes/backup.ts), so anything held in a table is copied
// into every backup the user downloads. The guarantee this file exists to
// keep is that a credential never leaves through a backup or an export; the
// original env-only design kept the same guarantee a different way, and
// environment variables still take precedence (see config.ts).
import { readFileSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { DATA_DIR, type RoleEndpoint } from '../config.ts'

const FILE = 'credentials.json'

type CredentialRole = 'embed' | 'vision'

interface Credentials extends RoleEndpoint {
  roles?: Partial<Record<CredentialRole, RoleEndpoint>>
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

// A role entry is held to the same standard as the shared one; anything that
// is not an object with a usable URL or key is dropped, not repaired.
function readEndpoint(v: unknown): RoleEndpoint | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const ep = { baseUrl: str(o.baseUrl), apiKey: str(o.apiKey), providerId: str(o.providerId) }
  return ep.baseUrl || ep.apiKey ? ep : null
}

// Missing, unreadable or malformed all read as "nothing configured" rather
// than throwing: the app serves notes perfectly well with no inference at
// all, so a corrupt file must never be the reason it fails to boot.
export function readCredentials(dir: string = DATA_DIR): Credentials | null {
  try {
    const parsed: Record<string, unknown> = JSON.parse(readFileSync(path.join(dir, FILE), 'utf8'))
    const { baseUrl, apiKey, providerId } = readEndpoint(parsed) ?? { baseUrl: null, apiKey: null, providerId: null }
    const roles: NonNullable<Credentials['roles']> = {}
    const rawRoles = parsed.roles && typeof parsed.roles === 'object' ? (parsed.roles as Record<string, unknown>) : {}
    for (const role of ['embed', 'vision'] as const) {
      const ep = readEndpoint(rawRoles[role])
      if (ep) roles[role] = ep
    }
    const hasRoles = Object.keys(roles).length > 0
    if (!baseUrl && !apiKey && !hasRoles) return null
    // providerId is not a credential — it is here because this file is the one
    // place that already knows which provider is connected, and the provider
    // needs it to look up quirks like a separate embeddings catalogue
    // (server/ai/endpoints.ts).
    return hasRoles ? { baseUrl, apiKey, providerId, roles } : { baseUrl, apiKey, providerId }
  } catch {
    return null
  }
}

// Throws on failure, deliberately: a key that appears to save and is gone
// after the next restart is worse than an error the user can see now.
export function writeCredentials(
  { baseUrl = null, apiKey = null, providerId = null, roles }: Partial<Credentials>,
  dir: string = DATA_DIR,
): Credentials {
  const file = path.join(dir, FILE)
  // Saving the shared endpoint must not wipe a vision or embed override the
  // caller never mentioned; only an explicit roles object replaces them.
  const kept = roles ?? readCredentials(dir)?.roles
  roles = kept && Object.keys(kept).length ? kept : undefined
  writeFileSync(file, JSON.stringify({ baseUrl, apiKey, providerId, roles }, null, 2), { mode: 0o600 })
  // writeFileSync's `mode` applies only when it creates the file, so an
  // existing permissive file would keep its old permissions without this.
  chmodSync(file, 0o600)
  return roles ? { baseUrl, apiKey, providerId, roles } : { baseUrl, apiKey, providerId }
}

// Merges into the existing file so a role edit never touches the shared entry
// or the other role. null removes the role's entry.
export function writeRoleCredentials(
  role: CredentialRole,
  ep: RoleEndpoint | null,
  dir: string = DATA_DIR,
): Credentials {
  const current = readCredentials(dir)
  const { [role]: _dropped, ...others } = current?.roles ?? {}
  const roles = ep ? { ...others, [role]: ep } : others
  return writeCredentials(
    {
      baseUrl: current?.baseUrl ?? null,
      apiKey: current?.apiKey ?? null,
      providerId: current?.providerId ?? null,
      roles,
    },
    dir,
  )
}

export function clearCredentials(dir: string = DATA_DIR): void {
  try {
    unlinkSync(path.join(dir, FILE))
  } catch {
    /* already gone */
  }
}
