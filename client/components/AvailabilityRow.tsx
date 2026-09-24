// Settings row for finding saved links whose content no longer exists, and
// removing them.
//
// Two steps, never one. The scan writes a reversible flag; removing is a
// separate press with the count in front of you. That split is the whole point:
// a scan verdict is a network call, and a network call can be wrong for reasons
// that have nothing to do with the content — a throttle, a soft-ban, a changed
// API. A dead tile left in place costs a grid cell. A live save deleted costs
// something you chose to keep, silently and permanently.
import { useState } from 'react'
import { SettingsRow, RowStatus } from './SettingsRow'
import { API, apiError } from '../data/api'
import { Button } from '../ui/Button'
import { Confirm } from '../ui/Confirm'

type Scan = Awaited<ReturnType<typeof API.scanAvailability>>

export function AvailabilityRow() {
  const [scanning, setScanning] = useState(false)
  const [scan, setScan] = useState<Scan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [armed, setArmed] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [removed, setRemoved] = useState<number | null>(null)

  const run = async () => {
    setScanning(true)
    setError(null)
    setRemoved(null)
    setArmed(false)
    try {
      setScan(await API.scanAvailability())
    } catch (e) {
      setError(
        apiError(e, 'Could not check your links — is the server reachable?', {
          scan_in_progress: 'A scan is already running — wait for it to finish.',
        }),
      )
      setScan(null)
    }
    setScanning(false)
  }

  const remove = async () => {
    if (!scan || removing) return
    setRemoving(true)
    setError(null)
    try {
      const r = await API.removeUnavailable(scan.unavailable)
      setRemoved(r.removed)
      setScan({ ...scan, unavailable: r.unavailable })
      setArmed(false)
    } catch (e) {
      // The server refuses when the count moved since the scan — that is not a
      // failure to explain away, it means the list on screen was stale.
      setError(apiError(e, 'Could not remove those items.'))
    }
    setRemoving(false)
  }

  // One sentence from the counters. `aborted` is its own case: the server
  // checked everything and then deliberately wrote nothing.
  const summary = (r: Scan) => {
    if (r.aborted) return r.error || 'Too many links reported gone to believe — nothing was marked.'
    if (r.checked === 0)
      return 'No links here can be checked yet. Only TikTok links can be verified — Instagram has no way to ask without risking a block.'
    const parts = [`Checked ${r.checked}`, `${r.alive} fine`]
    if (r.dead > 0) parts.push(`${r.dead} gone`)
    if (r.unknown > 0) parts.push(`${r.unknown} couldn't be reached`)
    let s = `${parts.join(', ')}.`
    if (r.cleared) s += ` ${r.cleared} came back and had their mark cleared.`
    return s
  }

  return (
    <SettingsRow
      title="Unavailable content"
      desc={
        <>
          Check saved links and mark the ones whose content has been deleted, so you can clear them out. Only{' '}
          <b>TikTok</b> links can be verified — Instagram gives no reliable way to ask, and guessing there would mean
          deleting posts that are merely private or rate-limited. Nothing is removed until you say so.
        </>
      }
      action={
        <Button onClick={run} disabled={scanning || removing}>
          {scanning ? 'Checking…' : 'Check links'}
        </Button>
      }
    >
      {scan && (
        <RowStatus tone={scan.aborted ? 'error' : 'ok'}>
          <div>{summary(scan)}</div>
          {!scan.aborted && scan.unavailable > 0 && !armed && (
            <div className="avail-actions">
              <Button
                danger
                onClick={() => {
                  setArmed(true)
                  setError(null)
                }}
                disabled={removing}
              >
                Remove {scan.unavailable} unavailable item{scan.unavailable === 1 ? '' : 's'}…
              </Button>
            </div>
          )}
        </RowStatus>
      )}
      {armed && scan && (
        <div className="settings-row-extra">
          <Confirm
            danger
            question={
              <>
                Permanently delete <b>{scan.unavailable}</b> saved item{scan.unavailable === 1 ? '' : 's'} whose content
                is gone? This can't be undone.
              </>
            }
            confirmLabel="Yes, remove them"
            busyLabel="Removing…"
            busy={removing}
            onConfirm={remove}
            onCancel={() => setArmed(false)}
          />
        </div>
      )}
      {removed !== null && (
        <RowStatus>
          Removed {removed} item{removed === 1 ? '' : 's'}.
        </RowStatus>
      )}
      {error && <RowStatus tone="error">{error}</RowStatus>}
    </SettingsRow>
  )
}
