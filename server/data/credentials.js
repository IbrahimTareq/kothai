// Inference credentials — the endpoint base URL and its API key.
//
// Deliberately NOT in SQLite. /api/backup is a VACUUM INTO over the whole
// database (server/routes/backup.js), so anything held in a table is copied
// into every backup the user downloads. The guarantee this file exists to
// keep is that a credential never leaves through a backup or an export; the
// original env-only design kept the same guarantee a different way, and
// environment variables still take precedence (see config.js).
import { readFileSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../config.js'

const FILE = 'credentials.json'

// Missing, unreadable or malformed all read as "nothing configured" rather
// than throwing: the app serves notes perfectly well with no inference at
// all, so a corrupt file must never be the reason it fails to boot.
export function readCredentials(dir = DATA_DIR) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(dir, FILE), 'utf8'))
    const baseUrl = typeof parsed.baseUrl === 'string' && parsed.baseUrl ? parsed.baseUrl : null
    const apiKey = typeof parsed.apiKey === 'string' && parsed.apiKey ? parsed.apiKey : null
    // Which catalogue entry this endpoint came from. Not a credential — it is
    // here because it is the one place that already knows which provider is
    // connected, and the provider needs it to look up quirks like a separate
    // embeddings catalogue (server/ai/endpoints.js).
    const providerId = typeof parsed.providerId === 'string' && parsed.providerId ? parsed.providerId : null
    return baseUrl || apiKey ? { baseUrl, apiKey, providerId } : null
  } catch {
    return null
  }
}

// Throws on failure, deliberately: a key that appears to save and is gone
// after the next restart is worse than an error the user can see now.
export function writeCredentials({ baseUrl = null, apiKey = null, providerId = null }, dir = DATA_DIR) {
  const file = path.join(dir, FILE)
  writeFileSync(file, JSON.stringify({ baseUrl, apiKey, providerId }, null, 2), { mode: 0o600 })
  // writeFileSync's `mode` applies only when it creates the file, so an
  // existing permissive file would keep its old permissions without this.
  chmodSync(file, 0o600)
  return { baseUrl, apiKey, providerId }
}

export function clearCredentials(dir = DATA_DIR) {
  try {
    unlinkSync(path.join(dir, FILE))
  } catch {
    /* already gone */
  }
}
