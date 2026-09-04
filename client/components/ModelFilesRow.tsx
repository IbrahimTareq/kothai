// Settings row for the model download cache — what the weights are costing on
// disk, and getting that space back.
//
// The cache only ever grows: QVAC never prunes, so every model this install has
// ever been pointed at is still on disk, and "Erase all data" deliberately
// keeps them (the point of a wipe is to lose your notes, not to re-download
// 2.5 GB). Nothing in the app used to say how much that was, which on a
// self-hosted box is the difference between noticing and running out of disk.
//
// Deleting weights is the rare destructive action that is genuinely undoable —
// anything removed re-downloads the next time it is selected — so this is one
// confirm press, not a typed token. What it is NOT allowed to do is take the
// running install offline: files the current selection needs carry a badge
// instead of a button, and the server refuses them regardless (409 `in_use`).
import { useState, useEffect } from 'react'
import { SettingsRow } from './SettingsRow'
import { API } from '../data/api'
import { fileLabel, fmtSize, storageSummary } from '../domain/modelFiles'
import { ROLE_META } from './ModelPicker'
import type { ModelFilesResponse } from '../types'

export function ModelFilesRow() {
  const [data, setData] = useState<ModelFilesResponse | null>(null)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<string | null>(null)   // armed for delete
  const [deleting, setDeleting] = useState<string | null>(null)
  const [freed, setFreed] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = () => API.modelFiles().then(setData).catch(() => setData(null))
  useEffect(() => { load() }, [])

  const remove = async (name: string) => {
    if (deleting) return
    setDeleting(name)
    setError(null)
    try {
      const r = await API.deleteModelFile(name)
      setFreed(r.freedBytes)
      setPending(null)
      // Re-read rather than patching the list in place: the totals and every
      // in-use badge come from the server, and this row's whole value is that
      // the numbers on screen are the numbers on disk.
      await load()
    } catch (e) {
      const err = e instanceof Error ? (e as Error & { code?: string }) : null
      setError(err?.message || 'Could not delete that file — check the server and try again.')
    }
    setDeleting(null)
  }

  return (
    <SettingsRow title="Downloaded models"
      desc={<>Model weights are downloaded once and kept. Switching a model leaves the old files behind, and erasing your data doesn't touch them — this is where that space goes. Anything you delete downloads again the next time you pick it.</>}
      action={data && (
        <button className="row-btn" onClick={() => { setOpen(!open); setError(null) }} aria-expanded={open}>
          {open ? 'Hide files' : 'Manage files'}
        </button>
      )}>
      {data && (
        <div className="settings-row-extra">
          <div className="import-result" role="status" aria-live="polite">{storageSummary(data)}</div>
        </div>
      )}
      {open && data && (
        <div className="settings-row-extra">
          <ul className="model-files">
            {data.entries.map((f) => (
              <li key={f.name} className="model-file">
                <div className="mf-main">
                  <span className="mf-name" title={f.name}>{fileLabel(f)}</span>
                  <span className="mf-size">{fmtSize(f.sizeBytes)}</span>
                </div>
                {f.inUse
                  // Named by role rather than "in use": the next question after
                  // "why can't I delete this" is "then what is using it", and
                  // the answer is a model picker three rows up.
                  ? <span className="mf-badge">In use · {f.usedBy ? ROLE_META[f.usedBy].title.toLowerCase() : 'selected'}</span>
                  : pending === f.name
                    ? (
                      <span className="mf-confirm">
                        <button className="danger-go" onClick={() => remove(f.name)} disabled={deleting === f.name}>
                          {deleting === f.name ? 'Deleting…' : `Delete ${fmtSize(f.sizeBytes)}`}
                        </button>
                        <button className="danger-cancel" onClick={() => setPending(null)} disabled={deleting === f.name}>
                          Cancel
                        </button>
                      </span>
                    )
                    : (
                      <button className="row-btn danger mf-delete" onClick={() => { setPending(f.name); setError(null); setFreed(null) }}>
                        Delete
                      </button>
                    )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {freed !== null && (
        <div className="settings-row-extra">
          <div className="import-result" role="status" aria-live="polite">Freed {fmtSize(freed)}.</div>
        </div>
      )}
      {error && (
        <div className="settings-row-extra">
          <div className="import-error" role="status" aria-live="polite">{error}</div>
        </div>
      )}
    </SettingsRow>
  )
}
