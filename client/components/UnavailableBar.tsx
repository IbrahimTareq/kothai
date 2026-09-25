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

export function UnavailableBar({
  count,
  onRemoved,
  onStale,
}: {
  count: number
  onRemoved: () => void
  onStale: () => void
}) {
  // The count as it stood when Confirm opened, not the live prop: the facets
  // can refresh while the question is on screen, and a live read would send a
  // number the user never saw — one the server would accept, deleting a set
  // they did not agree to. null while Confirm is closed.
  const [agreed, setAgreed] = useState<number | null>(null)
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const links = (n: number) => `saved link${n === 1 ? '' : 's'}`

  const remove = async (expected: number) => {
    setRemoving(true)
    setError(null)
    try {
      await API.removeUnavailable(expected)
      onRemoved()
    } catch (e) {
      // A count_mismatch is not a failure to explain away: the number on
      // screen was stale, and the server refused rather than delete a
      // different set than the one agreed to. The count is refreshed so the
      // bar shows the real number — left alone, every retry would send the
      // same stale one and be refused again.
      setError(apiError(e, 'Could not remove those items.'))
      if ((e as { code?: string }).code === 'count_mismatch') onStale()
      setAgreed(null)
      setRemoving(false)
    }
  }

  return (
    <div className="unavail-bar">
      {agreed !== null ? (
        <Confirm
          inline
          danger
          question={
            <>
              Permanently delete <b>{agreed}</b> {links(agreed)} whose content is gone? This can't be undone.
            </>
          }
          confirmLabel="Yes, remove them"
          busyLabel="Removing…"
          busy={removing}
          onConfirm={() => remove(agreed)}
          onCancel={() => setAgreed(null)}
        />
      ) : (
        <>
          {/* "no longer public" because the Instagram check cannot tell a
              deleted post from one whose account went private. */}
          <span className="unavail-bar-text">
            <b>{count}</b> {links(count)} {count === 1 ? 'is' : 'are'} gone — deleted, or no longer public.
          </span>
          <Button
            danger
            onClick={() => {
              setAgreed(count)
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
