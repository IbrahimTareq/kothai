// The bar above the Everything board while the Unavailable chip is on: how
// many saved links the daily sweep found gone, and the one control that
// deletes them.
//
// Deleting is its own press, behind a Confirm, with the count on screen sent
// along — the server refuses if the marked set changed since. The sweep only
// ever marks: a verdict is a network call, and a network call can be wrong for
// reasons that have nothing to do with the content. A dead tile left in place
// costs a grid cell; a live save deleted costs something you chose to keep.
import { useState } from 'react'
import { API, apiError } from '../data/api'
import { Button } from '../ui/Button'
import { Confirm } from '../ui/Confirm'

export function UnavailableBar({ count, onRemoved }: { count: number; onRemoved: () => void }) {
  const [armed, setArmed] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const links = `saved link${count === 1 ? '' : 's'}`

  const remove = async () => {
    setRemoving(true)
    setError(null)
    try {
      await API.removeUnavailable(count)
      onRemoved()
    } catch (e) {
      // A count_mismatch is not a failure to explain away: the number on
      // screen was stale, and the server refused rather than delete a
      // different set than the one agreed to.
      setError(apiError(e, 'Could not remove those items.'))
      setArmed(false)
      setRemoving(false)
    }
  }

  return (
    <div className="unavail-bar">
      {armed ? (
        <Confirm
          inline
          danger
          question={
            <>
              Permanently delete <b>{count}</b> {links} whose content is gone? This can't be undone.
            </>
          }
          confirmLabel="Yes, remove them"
          busyLabel="Removing…"
          busy={removing}
          onConfirm={remove}
          onCancel={() => setArmed(false)}
        />
      ) : (
        <>
          {/* "no longer public" because the Instagram check cannot tell a
              deleted post from one whose account went private. */}
          <span className="unavail-bar-text">
            <b>{count}</b> {links} {count === 1 ? 'is' : 'are'} gone — deleted, or no longer public.
          </span>
          <Button
            danger
            onClick={() => {
              setArmed(true)
              setError(null)
            }}
          >
            Remove all…
          </Button>
        </>
      )}
      {error && <span className="unavail-bar-error">{error}</span>}
    </div>
  )
}
