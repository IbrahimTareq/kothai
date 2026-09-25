// Settings row for the backups Kothai keeps by itself in data/backups
// (server/backups.ts): whether the daily one runs, when it last did, why it
// did not, and a download of each kept copy.
//
// The downloads are not a convenience. On a PaaS the volume has no other way
// out, and a copy that stays on the disk it protects is lost with that disk.
import { useEffect, useState } from 'react'
import { SettingsRow, RowStatus } from './SettingsRow'
import { API, apiError } from '../../data/api'
import { fmtSize } from '../../domain/modelFiles'
import { relTime } from '../../util/format'
import type { BackupsResponse } from '../../types'
import { Button } from '../../ui/Button'
import { Segmented } from '../../ui/Segmented'

const KIND = { daily: 'Daily', 'before-restore': 'Before a restore' }

export function BackupsRow() {
  const [data, setData] = useState<BackupsResponse | null>(null)
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    API.backups()
      .then(setData)
      .catch(e => setError(apiError(e, 'Could not load your backups — is the server reachable?')))
  }, [])

  const toggle = async (enabled: boolean) => {
    setSaving(true)
    setError(null)
    try {
      setData(await API.setBackups(enabled))
    } catch (e) {
      setError(apiError(e, 'Could not change that — check the server and try again.'))
    }
    setSaving(false)
  }

  const latest = data?.files.find(f => f.kind === 'daily')
  const status = !data
    ? null
    : !data.enabled
      ? 'Off — nothing is backed up automatically.'
      : latest
        ? `Last backup ${relTime(Date.parse(latest.at))}, ${fmtSize(latest.size)}.`
        : 'No backup yet — the first is made within the hour.'

  return (
    <SettingsRow
      title="Automatic backups"
      desc={
        <>
          Once a day, a backup like the one above is saved to <code>data/backups</code> on this machine. The newest 7
          are kept, each about the size of your library. A copy on this disk is lost with it, so download one now and
          then.
        </>
      }
      action={
        data && (
          <Segmented
            label="Automatic backups"
            value={data.enabled ? 'on' : 'off'}
            onChange={v => toggle(v === 'on')}
            disabled={saving}
            options={[
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Off' },
            ]}
          />
        )
      }
    >
      {status && (
        <RowStatus>
          <div>{status}</div>
          {data && data.files.length > 0 && (
            <div className="avail-actions">
              <Button onClick={() => setOpen(!open)} aria-expanded={open}>
                {open ? 'Hide backups' : `Show backups (${data.files.length})`}
              </Button>
            </div>
          )}
        </RowStatus>
      )}
      {data?.failure && (
        <RowStatus tone="error">
          The last backup failed {relTime(Date.parse(data.failure.at))}: {data.failure.error} Kothai tries again every
          hour.
        </RowStatus>
      )}
      {open && data && (
        <div className="settings-row-extra">
          <ul className="model-files">
            {data.files.map(f => (
              <li key={f.name} className="model-file">
                <div className="mf-main">
                  <span className="mf-name" title={f.name}>
                    {new Date(f.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · {KIND[f.kind]}
                  </span>
                  <span className="mf-size">{fmtSize(f.size)}</span>
                </div>
                <Button asChild>
                  <a href={`/api/backups/${encodeURIComponent(f.name)}`} download>
                    Download
                  </a>
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && <RowStatus tone="error">{error}</RowStatus>}
    </SettingsRow>
  )
}
