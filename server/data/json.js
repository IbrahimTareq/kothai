// Shared filesystem helpers used by the SQLite store (db.js), the legacy-JSON
// migration (migrate.js), and image uploads. The store modules themselves no
// longer read/write JSON directly — readJson here now exists solely for
// migrate.js to pull in a pre-SQLite install's flat files.
import { readFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { DATA_DIR, UPLOAD_DIR } from '../config.js'

// Paths are resolved centrally (env-configurable) and re-exported here so every
// store module keeps importing them from one place.
export { DATA_DIR, UPLOAD_DIR }

// Ensure data/ exists (and uploads/ when asked).
export async function ensureDataDir({ uploads = false } = {}) {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true })
  if (uploads && !existsSync(UPLOAD_DIR)) await mkdir(UPLOAD_DIR, { recursive: true })
}

// Read a JSON file, returning `fallback` if it's missing or unparseable.
export async function readJson(file, fallback) {
  if (!existsSync(file)) return fallback
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}
