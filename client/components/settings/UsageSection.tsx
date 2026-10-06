// AI USAGE — where model time and money went over the last 30 days, by step
// (classify, vision, …) or by what set the work off (a save, an import, a
// re-tag …). Before this every figure was an estimate from list prices: the
// app recorded nothing about the calls it made.
//
// Cost is shown only as the endpoint reported it (OpenRouter does). Calls
// that came back without a price are counted next to the sum, not left out of
// it silently, so a partial bill never reads as the whole one.
import { useEffect, useState } from 'react'
import { SettingsGroup, SettingsRow } from './SettingsRow'
import { API } from '../../data/api'
import type { UsageGroup, UsageResponse } from '../../types'
import { Segmented } from '../../ui/Segmented'

const STEPS: Record<string, string> = {
  classify: 'Classify',
  vision: 'Cover images',
  embed: 'Embeddings',
  'tag-embed': 'Tag matching',
  answer: 'Ask answers',
  other: 'Other',
}
const TRIGGERS: Record<string, string> = {
  save: 'New saves',
  import: 'Imports',
  retag: 'Re-tag one note',
  'retag-all': 'Re-tag everything',
  backlog: 'Enrichment backlog',
  recovery: 'Outage recovery',
  boot: 'Startup',
  reembed: 'Re-embedding',
  'tag-edit': 'Tag edits',
  ask: 'Ask',
  other: 'Other',
}

const tokens = (n: number | null) =>
  n === null ? '—' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n)
const time = (ms: number) =>
  ms >= 3_600_000
    ? `${(ms / 3_600_000).toFixed(1)} h`
    : ms >= 60_000
      ? `${(ms / 60_000).toFixed(1)} min`
      : `${(ms / 1000).toFixed(1)} s`
function cost(g: UsageGroup) {
  const sum = g.costUsd === null ? '—' : `$${g.costUsd < 0.01 ? g.costUsd.toFixed(4) : g.costUsd.toFixed(2)}`
  return g.costUnknownCalls ? `${sum} + ${g.costUnknownCalls} unpriced` : sum
}

export function UsageSection() {
  const [data, setData] = useState<UsageResponse | null>(null)
  const [by, setBy] = useState<'step' | 'trigger'>('step')
  useEffect(() => {
    API.usage()
      .then(setData)
      .catch(() => setData(null))
  }, [])

  const groups = data ? (by === 'step' ? data.byStep : data.byTrigger) : []
  const names = by === 'step' ? STEPS : TRIGGERS

  return (
    <SettingsGroup label="AI usage">
      <div className="settings-rows">
        <SettingsRow
          title="Last 30 days"
          desc="Every model call, local or through an endpoint: how many, how many tokens, how long, and what it cost where the endpoint says."
          action={
            <Segmented
              label="Break usage down by"
              value={by}
              onChange={setBy}
              options={[
                { value: 'step', label: 'By step' },
                { value: 'trigger', label: 'By trigger' },
              ]}
            />
          }
        >
          {data && data.totals.calls === 0 && <p className="usage-empty">No AI calls in the last 30 days.</p>}
          {groups.length > 0 && (
            <div className="usage-scroll">
              <table className="usage-table">
                <thead>
                  <tr>
                    <th scope="col">{by === 'step' ? 'Step' : 'Trigger'}</th>
                    <th scope="col">Calls</th>
                    <th scope="col">Tokens in / out</th>
                    <th scope="col">Time</th>
                    <th scope="col">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map(g => (
                    <tr key={g.key}>
                      <th scope="row">{names[g.key] ?? g.key}</th>
                      <td>
                        {g.calls}
                        {g.failed > 0 && <span className="usage-failed"> ({g.failed} failed)</span>}
                      </td>
                      <td>
                        {tokens(g.inputTokens)} / {tokens(g.outputTokens)}
                      </td>
                      <td>{time(g.ms)}</td>
                      <td>{cost(g)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SettingsRow>
      </div>
    </SettingsGroup>
  )
}
