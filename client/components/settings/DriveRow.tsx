// Settings row for Google Drive backups (server/drive.ts): connect with a code
// entered at google.com/device, see what is on Drive, and restore from it.
//
// Restoring from here is the new-machine path: install, connect the same
// Google account, pick a backup. It replaces the library, so it takes the same
// named confirmation as RestoreRow.
import { useEffect, useState } from 'react'
import { SettingsRow, RowStatus } from './SettingsRow'
import { API, apiError } from '../../data/api'
import { fmtSize } from '../../domain/modelFiles'
import { relTime } from '../../util/format'
import { writeClipboard } from '../../util/clipboard'
import type { DriveResponse } from '../../types'
import { Button } from '../../ui/Button'
import { Confirm } from '../../ui/Confirm'

// How often to ask whether the code was entered. The server polls Google; this
// only asks the server, so it can be brisk.
const PENDING_POLL_MS = 2000

const when = (at: string) => new Date(at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })

export function DriveRow() {
  const [data, setData] = useState<DriveResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [armed, setArmed] = useState<string | null>(null) // backup id awaiting confirmation
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = () =>
    API.drive()
      .then(setData)
      .catch(e => setError(apiError(e, 'Could not load Google Drive — is the server reachable?')))

  useEffect(() => {
    load()
  }, [])

  // Waiting on the owner to enter the code, somewhere else entirely.
  useEffect(() => {
    if (!data?.pending) return
    const timer = setInterval(load, PENDING_POLL_MS)
    return () => clearInterval(timer)
  }, [data?.pending?.userCode])

  const run = async (step: () => Promise<unknown>, failed: string) => {
    setBusy(true)
    setError(null)
    try {
      await step()
      await load()
    } catch (e) {
      setError(apiError(e, failed, { drive_not_configured: 'Google Drive is not set up on this install.' }))
    }
    setBusy(false)
  }

  const restore = async (id: string) => {
    setBusy(true)
    setError(null)
    try {
      await API.restoreFromDrive(id)
      // Every open view holds the library that was just replaced.
      window.location.reload()
    } catch (e) {
      setError(apiError(e, 'Could not restore that backup.'))
      setBusy(false)
    }
  }

  const copy = async () => {
    if (data?.pending && (await writeClipboard(data.pending.userCode))) setCopied(true)
  }

  if (!data) return null
  const pending = data.pending

  return (
    <SettingsRow
      title="Google Drive"
      desc={
        data.connected ? (
          <>
            Each daily backup is also copied to <b>Kothai Backups</b> in the Google Drive of{' '}
            <b>{data.email ?? 'your account'}</b>, off this machine. The newest 7 are kept there. Kothai sees only the
            files it put there, nothing else in your Drive.
          </>
        ) : (
          <>
            Copy each daily backup to your Google Drive, off this machine — and restore from it on a new one. Kothai
            asks only for the files it creates, never the rest of your Drive.
          </>
        )
      }
      action={
        data.configured &&
        !pending &&
        (data.connected ? (
          <Button onClick={() => run(API.disconnectDrive, 'Could not disconnect.')} disabled={busy}>
            Disconnect
          </Button>
        ) : (
          <Button onClick={() => run(API.connectDrive, 'Could not reach Google.')} disabled={busy}>
            {busy ? 'Connecting…' : 'Connect Google Drive'}
          </Button>
        ))
      }
    >
      {!data.configured && (
        <RowStatus>
          Not set up on this install: signing in to Google needs <code>KOTHAI_GOOGLE_CLIENT_ID</code> and{' '}
          <code>KOTHAI_GOOGLE_CLIENT_SECRET</code>. See the backups guide.
        </RowStatus>
      )}
      {pending && (
        <div className="settings-row-extra telegram-pair">
          <div className="telegram-pair-step">
            <Button tone="solid" asChild>
              <a href={pending.verificationUrl} target="_blank" rel="noreferrer">
                Open google.com/device
              </a>
            </Button>
            <span className="settings-row-desc">on any device, and enter:</span>
            <span className="telegram-pairing-code mono">{pending.userCode}</span>
            <Button size="xs" tone="ghost" onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <div className="telegram-waiting">
            <span role="status" aria-live="polite">
              Waiting for Google…
            </span>
            <Button size="xs" tone="ghost" onClick={() => run(API.disconnectDrive, 'Could not cancel.')}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {data.connected && data.backups.length > 0 && (
        <RowStatus>
          <div>
            Last copied {relTime(Date.parse(data.backups[0].at))}, {fmtSize(data.backups[0].size)}.
          </div>
          <div className="avail-actions">
            <Button onClick={() => setOpen(!open)} aria-expanded={open}>
              {open ? 'Hide backups on Drive' : `Show backups on Drive (${data.backups.length})`}
            </Button>
          </div>
        </RowStatus>
      )}
      {data.connected && data.backups.length === 0 && !data.listError && (
        <RowStatus>Nothing copied yet — the newest daily backup goes up within the hour.</RowStatus>
      )}
      {open && data.connected && (
        <div className="settings-row-extra">
          <ul className="model-files">
            {data.backups.map(b => (
              <li key={b.id} className="model-file">
                <div className="mf-main">
                  <span className="mf-name">{when(b.at)}</span>
                  <span className="mf-size">{fmtSize(b.size)}</span>
                </div>
                {armed === b.id ? (
                  <Confirm
                    danger
                    question={<>Replace your whole library with the backup from {when(b.at)}?</>}
                    confirmLabel="Replace library"
                    busyLabel="Restoring…"
                    busy={busy}
                    onConfirm={() => restore(b.id)}
                    onCancel={() => setArmed(null)}
                  />
                ) : (
                  <Button onClick={() => setArmed(b.id)} disabled={busy}>
                    Restore
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.failure && (
        <RowStatus tone="error">
          The last copy to Drive failed {relTime(Date.parse(data.failure.at))}: {data.failure.error} Kothai tries again
          every hour.
        </RowStatus>
      )}
      {data.listError && <RowStatus tone="error">{data.listError}</RowStatus>}
      {data.error && <RowStatus tone="error">{data.error}</RowStatus>}
      {error && <RowStatus tone="error">{error}</RowStatus>}
    </SettingsRow>
  )
}
