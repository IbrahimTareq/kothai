// The capture token's hash — what lets a Shortcut or a script save a link to a
// password-protected install without a session.
//
// Deliberately NOT in SQLite, for the reason credentials.ts gives: /api/backup
// is a VACUUM INTO over the whole database, so anything in a table is copied
// into every backup the user downloads. Only the SHA-256 digest is kept, so
// even a copied data/ folder does not carry a working token.
import { readFileSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../config.ts'

const FILE = 'capture-token.json'
const SHA256_HEX = /^[0-9a-f]{64}$/

// Missing, unreadable or malformed all read as "no token" rather than
// throwing: a corrupt file must never be the reason the server fails to boot,
// and "no token" fails closed — the gate then refuses every bearer request.
export function readCaptureTokenHash(dir: string = DATA_DIR): string | null {
  try {
    const parsed: Record<string, unknown> = JSON.parse(readFileSync(path.join(dir, FILE), 'utf8'))
    return typeof parsed.hash === 'string' && SHA256_HEX.test(parsed.hash) ? parsed.hash : null
  } catch {
    return null
  }
}

// Throws on failure, deliberately: a token that appears to be created and
// does not work is worse than an error the user can see now.
export function writeCaptureTokenHash(hash: string, dir: string = DATA_DIR): void {
  const file = path.join(dir, FILE)
  writeFileSync(file, JSON.stringify({ hash }, null, 2), { mode: 0o600 })
  // writeFileSync's `mode` applies only when it creates the file, so an
  // existing permissive file would keep its old permissions without this.
  chmodSync(file, 0o600)
}

export function clearCaptureToken(dir: string = DATA_DIR): void {
  try {
    unlinkSync(path.join(dir, FILE))
  } catch {
    /* already gone */
  }
}
