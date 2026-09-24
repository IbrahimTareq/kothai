// CAPTURE TOKEN — lets a script or a Shortcut save a link to a password-
// protected install without a session. It opens POST /api/save and nothing
// else (server/routes/auth.ts), so this screen can describe it as save-only.
import { useEffect, useState } from 'react'
import { SettingsGroup, SettingsRow, RowStatus } from './SettingsRow'
import { API, apiError } from '../../data/api'
import type { CaptureTokenState } from '../../types'
import { writeClipboard } from '../../util/clipboard'
import { Button } from '../../ui/Button'
import { Input } from '../../ui/Input'

export function CaptureTokenSection() {
  const [state, setState] = useState<CaptureTokenState | null>(null)
  // Held only until the user leaves Settings: the server kept just its hash,
  // so once this is gone the token cannot be shown again.
  const [token, setToken] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    API.captureToken()
      .then(setState)
      .catch(() => {})
  }, [])

  const run = async (call: () => Promise<CaptureTokenState>, fallback: string) => {
    if (busy) return
    setBusy(true)
    setError(null)
    setCopied(false)
    try {
      const next = await call()
      setState(next)
      setToken(next.token ?? null)
    } catch (e) {
      setError(apiError(e, fallback))
    }
    setBusy(false)
  }

  const create = () => run(API.createCaptureToken, 'Could not create a token — check the server and try again.')
  const revoke = () => run(API.clearCaptureToken, 'Could not revoke the token — check the server and try again.')

  const copy = async () => {
    if (token) setCopied(await writeClipboard(token))
  }

  const desc = !state
    ? ''
    : !state.gated
      ? 'This install has no password, so saving already works without a token. A token starts to matter once KOTHAI_PASSWORD is set.'
      : token
        ? 'Token created. Copy it now — it is shown only once.'
        : state.exists
          ? 'A token is active. It cannot be shown again — regenerate to get a new one, which stops the old one working.'
          : 'No token yet.'

  return (
    <SettingsGroup
      label="CAPTURE TOKEN"
      sub="Lets a script or an iOS Shortcut save links without signing in. It can only save — it cannot read, change or delete anything in your library."
    >
      <div className="settings-rows">
        <SettingsRow
          title="Token"
          desc={desc}
          action={
            state?.exists ? (
              <span className="capture-token-actions">
                <Button onClick={create} disabled={busy}>
                  Regenerate
                </Button>
                <Button danger onClick={revoke} disabled={busy}>
                  Revoke
                </Button>
              </span>
            ) : (
              <Button tone="solid" onClick={create} disabled={busy || !state}>
                {busy ? 'Creating…' : 'Create token'}
              </Button>
            )
          }
        >
          {token && (
            <div className="settings-row-extra">
              <Input
                readOnly
                className="wizard-input mono"
                value={token}
                aria-label="Capture token"
                onFocus={e => e.currentTarget.select()}
              />
              <Button onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
              <p className="settings-row-desc">
                Send it as <code>Authorization: Bearer …</code> on a JSON <code>POST /api/save</code>.
              </p>
            </div>
          )}
          {error && <RowStatus tone="error">{error}</RowStatus>}
        </SettingsRow>
      </div>
    </SettingsGroup>
  )
}
