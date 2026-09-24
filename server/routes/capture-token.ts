// Create, replace and revoke the capture token from Settings — see
// server/routes/auth.ts for the one route the token opens, and
// server/data/capture-token.ts for why only its hash is kept.
import { randomBytes } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import { PASSWORD } from '../config.ts'
import { readCaptureTokenHash, writeCaptureTokenHash, clearCaptureToken } from '../data/capture-token.ts'
import { hashToken } from '../lib/auth.ts'
import { json } from '../lib/http.ts'

// `gated` tells Settings whether the token does anything yet: with no
// KOTHAI_PASSWORD there is no gate, so /api/save is already open to anyone who
// can reach the port and the token is only waiting for a password to be set.
const stateOf = () => ({ exists: readCaptureTokenHash() !== null, gated: Boolean(PASSWORD) })

export function handleGetCaptureToken(res: ServerResponse): void {
  json(res, 200, stateOf())
}

// The only response that ever carries the token. It cannot be shown again —
// only its hash was kept — so replacing it is how a lost one is recovered.
export function handleCreateCaptureToken(res: ServerResponse): void {
  const token = randomBytes(32).toString('base64url')
  writeCaptureTokenHash(hashToken(token))
  json(res, 200, { ...stateOf(), token })
}

export function handleClearCaptureToken(res: ServerResponse): void {
  clearCaptureToken()
  json(res, 200, stateOf())
}
