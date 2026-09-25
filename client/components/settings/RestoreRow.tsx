// Settings row for putting a backup (Download backup, just above it) back in
// place of the library.
//
// Two steps: choose the file, then confirm with its name in front of you. A
// restore replaces everything, so picking the wrong file from a downloads
// folder must not be one click from happening. The server keeps the library
// it replaces under data/backups, which is what makes a mistake recoverable.
import { useState } from 'react'
import { SettingsRow, RowStatus } from './SettingsRow'
import { API, apiError } from '../../data/api'
import { Button } from '../../ui/Button'
import { Confirm } from '../../ui/Confirm'

export function RestoreRow() {
  const [file, setFile] = useState<File | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const restore = async () => {
    if (!file || restoring) return
    setRestoring(true)
    setError(null)
    try {
      await API.restoreBackup(file)
      // Every open view holds the library that was just replaced; a reload is
      // the one way to drop all of it at once.
      window.location.reload()
    } catch (e) {
      setError(apiError(e, 'Could not restore that backup — is the server reachable?'))
      setRestoring(false)
    }
  }

  return (
    <SettingsRow
      title="Restore"
      desc={
        <>
          Replace everything in this library — notes, spaces, chats and images — with a backup. Model settings stay as
          they are on this install. Your current library is kept in <code>data/backups</code> first.
        </>
      }
      action={
        !file && (
          <Button asChild className="import-pick">
            <label>
              <input
                type="file"
                accept=".gz,.tgz,.db"
                onChange={e => {
                  setFile(e.target.files?.[0] ?? null)
                  setError(null)
                  e.target.value = ''
                }}
              />
              <span>Choose backup…</span>
            </label>
          </Button>
        )
      }
    >
      {file && (
        <div className="settings-row-extra">
          <Confirm
            danger
            question={
              <>
                Replace your whole library with <b>{file.name}</b>?
              </>
            }
            confirmLabel="Replace library"
            busyLabel="Restoring…"
            busy={restoring}
            onConfirm={restore}
            onCancel={() => setFile(null)}
          />
        </div>
      )}
      {error && <RowStatus tone="error">{error}</RowStatus>}
    </SettingsRow>
  )
}
