// DUPLICATES — links saved more than once. Only the importer refuses a link
// that is already saved; a paste, a share or a Telegram message stores
// whatever arrives. Flagged rather than merged: which copy to keep is the
// user's call, since either may carry the tags, mind note or spaces.
import { useEffect, useState } from 'react'
import { SettingsGroup, SettingsRow, RowStatus } from './SettingsRow'
import { API, apiError } from '../../data/api'
import type { DuplicatesResponse } from '../../types'
import { Button } from '../../ui/Button'
import { Confirm } from '../../ui/Confirm'

export function DuplicatesSection() {
  const [data, setData] = useState<DuplicatesResponse | null>(null)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<string | null>(null) // armed for delete
  const [deleting, setDeleting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = () =>
    API.duplicates()
      .then(setData)
      .catch(() => setData(null))
  useEffect(() => {
    load()
  }, [])

  const remove = async (id: string) => {
    if (deleting) return
    setDeleting(id)
    setError(null)
    try {
      await API.del(id)
      setPending(null)
      // Re-read: a group of two that loses one is no longer a duplicate.
      await load()
    } catch (e) {
      setError(apiError(e, 'Could not delete that note — check the server and try again.'))
    }
    setDeleting(null)
  }

  const groups = data?.groups ?? []
  const extra = groups.reduce((sum, g) => sum + g.length - 1, 0)

  return (
    <SettingsGroup label="Duplicates">
      <div className="settings-rows">
        <SettingsRow
          title="Links saved more than once"
          desc={
            <>
              The same link saved twice — tracking bits like <code>?utm_</code> or <code>www.</code> ignored. Delete the
              copies you don't need; nothing is removed on its own.
            </>
          }
          action={
            groups.length > 0 && (
              <Button
                onClick={() => {
                  setOpen(!open)
                  setError(null)
                }}
                aria-expanded={open}
              >
                {open ? 'Hide' : 'Review'}
              </Button>
            )
          }
        >
          {data && (
            <RowStatus>
              {groups.length === 0
                ? 'No duplicates.'
                : `${groups.length} link${groups.length === 1 ? '' : 's'} saved more than once — ${extra} extra cop${extra === 1 ? 'y' : 'ies'}.`}
            </RowStatus>
          )}
          {open && groups.length > 0 && (
            <div className="settings-row-extra">
              {groups.map(g => (
                <div key={g[0].id} className="dup-group">
                  <div className="dup-url" title={g[0].url}>
                    {g[0].url}
                  </div>
                  <ul className="dup-notes">
                    {g.map(n => (
                      <li key={n.id} className="dup-note">
                        <span className="dup-title">{n.title || 'Untitled'}</span>
                        {/* Absolute, not relTime: copies saved days apart all read "1mo ago". */}
                        <span className="dup-when">
                          {new Date(n.createdAt).toLocaleDateString([], {
                            day: 'numeric',
                            month: 'short',
                            year: 'numeric',
                          })}
                        </span>
                        {pending === n.id ? (
                          <Confirm
                            inline
                            danger
                            className="dup-action"
                            confirmLabel="Delete"
                            busyLabel="Deleting…"
                            busy={deleting === n.id}
                            onConfirm={() => remove(n.id)}
                            onCancel={() => setPending(null)}
                          />
                        ) : (
                          <Button
                            danger
                            className="dup-action"
                            onClick={() => {
                              setPending(n.id)
                              setError(null)
                            }}
                          >
                            Delete
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
          {error && <RowStatus tone="error">{error}</RowStatus>}
        </SettingsRow>
      </div>
    </SettingsGroup>
  )
}
