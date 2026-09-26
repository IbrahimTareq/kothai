// Settings row for the enrichment queue (server/ai/queue.ts): how far through
// its current run it is and, once idle, how many notes still lack a step the
// current AI settings could fill.
//
// It replaced a banner that appeared only right after a role was switched on.
// Notes an endpoint outage left on their heuristic titles never raised it, so
// nothing on screen said they were still owed a pass.
import { useEffect, useState } from 'react'
import { SettingsRow, RowStatus } from './SettingsRow'
import { API, apiError } from '../../data/api'
import { Button } from '../../ui/Button'

// Polled only while a run is going. An idle queue changes only when something
// queues work, and Settings says so by bumping `nudge`.
const POLL_MS = 3000

export function EnrichmentRow({ nudge }: { nudge: number }) {
  const [p, setP] = useState<Awaited<ReturnType<typeof API.backlog>> | null>(null)
  const [tick, setTick] = useState(0)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = () =>
      API.backlog()
        .then(next => {
          if (!live) return
          setP(next)
          setError(null)
          if (next.total > 0) timer = setTimeout(read, POLL_MS)
        })
        .catch(e => {
          if (!live) return
          // Polling stops here, so a kept "Enriching — 3 of 5" would sit frozen
          // under the error as if the run were still being watched.
          setP(null)
          setError(apiError(e, 'Could not read the enrichment queue — is the server reachable?'))
        })
    read()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [nudge, tick])

  const enrichNow = async () => {
    setStarting(true)
    setError(null)
    try {
      await API.enrichBacklog()
      setTick(t => t + 1)
    } catch (e) {
      setError(apiError(e, "Couldn't start enrichment — check the server and try again."))
    }
    setStarting(false)
  }

  const status = !p
    ? null
    : p.total > 0
      ? `Enriching — ${p.done} of ${p.total} done, ${p.total - p.done} left.`
      : p.count > 0
        ? `${p.count} note${p.count === 1 ? ' is' : 's are'} missing a step your current AI settings can fill.`
        : 'Every note is enriched.'

  return (
    <SettingsRow
      title="Enrichment"
      desc={
        <>
          After a save, the AI models fill in each note's title, tags and search embedding in the background, one job at
          a time. This shows how far along that is, and what is still owed.
        </>
      }
      action={
        p?.total === 0 &&
        p.count > 0 && (
          <Button tone="solid" onClick={enrichNow} disabled={starting}>
            {starting ? 'Starting…' : 'Enrich now'}
          </Button>
        )
      }
    >
      {status && <RowStatus>{status}</RowStatus>}
      {error && <RowStatus tone="error">{error}</RowStatus>}
    </SettingsRow>
  )
}
