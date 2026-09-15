// Provider tiles, endpoint URL, key, and a live connection test.
//
// Shared deliberately: first run (views/SetupWizard) and Settings both need
// exactly this, and two copies would drift the moment a provider is added or
// the probe's wording changes.
import { useState } from 'react'
import { API } from '../data/api'
import type { EndpointOption } from '../types'

export interface EndpointChoice {
  providerId: string
  baseUrl: string
  apiKey: string
  models: string[]
  defaults: { llm: string; embed: string; vision: string }
}

type Probe = { state: 'idle' | 'testing' | 'ok' | 'fail'; message: string; models: string[] }

export function EndpointPicker({
  endpoints,
  preselect,
  keyPlaceholder = 'paste it here',
  onChange,
}: {
  endpoints: EndpointOption[]
  preselect?: string | null
  // Settings already has a key on file, so it says so rather than implying the
  // field is empty because nothing is set.
  keyPlaceholder?: string
  // Fires on every edit, so the parent owns the submit button and its label —
  // "Continue" in first run, "Save" in Settings.
  onChange: (choice: EndpointChoice | null) => void
}) {
  const [picked, setPicked] = useState<EndpointOption | null>(
    () => endpoints.find((e) => e.id === preselect) || null,
  )
  const [key, setKey] = useState('')
  const [probe, setProbe] = useState<Probe>({ state: 'idle', message: '', models: [] })

  // Every catalogue entry carries its own URL — there is no hand-typed
  // endpoint here. Someone pointing at their own server uses --endpoint or
  // STASH_AI_BASE_URL, which win over anything set in the app.
  const baseUrl = (picked?.baseUrl || '').trim()

  const publish = (next: EndpointOption | null, nextKey = key, models = probe.models) => {
    onChange(
      next?.baseUrl
        ? { providerId: next.id, baseUrl: next.baseUrl.trim(), apiKey: nextKey.trim(), models, defaults: next.defaults }
        : null,
    )
  }

  const pick = (e: EndpointOption) => {
    setPicked(e)
    setProbe({ state: 'idle', message: '', models: [] })
    publish(e, key, [])
  }

  const test = async () => {
    if (!baseUrl) return
    setProbe({ state: 'testing', message: '', models: [] })
    try {
      const r = await API.testEndpoint(baseUrl, key.trim())
      const next: Probe = r.ok
        ? { state: 'ok', message: `${r.models.length} models available`, models: r.models }
        : { state: 'fail', message: r.error || 'Could not reach that endpoint.', models: [] }
      setProbe(next)
      publish(picked, key, next.models)
    } catch (e) {
      setProbe({ state: 'fail', message: (e as Error).message || 'Could not reach that endpoint.', models: [] })
    }
  }

  return (
    <>
      <div className="wizard-providers">
        {endpoints.map((e) => (
          <button
            key={e.id}
            type="button"
            className={`wizard-provider${picked?.id === e.id ? ' picked' : ''}`}
            onClick={() => pick(e)}
          >
            <span className="wizard-provider-label mono">{e.label}</span>
            {!e.servesEmbeddings && <span className="wizard-provider-tag mono">chat only</span>}
          </button>
        ))}
      </div>

      {picked && <p className="wizard-note">{picked.note}</p>}

      {picked && (
        <label className="wizard-field">
          <span className="wizard-field-label mono">
            API key{!picked.needsKey && <span className="wizard-optional"> — not needed for this one</span>}
          </span>
          <input
            className="wizard-input mono"
            type="password"
            value={key}
            placeholder={picked.needsKey ? keyPlaceholder : 'leave blank'}
            onChange={(ev) => { setKey(ev.target.value); publish(picked, ev.target.value) }}
          />
        </label>
      )}

      {picked && (
        <div className="wizard-probe">
          <button className="btn btn--sm" type="button" onClick={test}
            disabled={!baseUrl || probe.state === 'testing'}>
            {probe.state === 'testing' ? 'Checking…' : 'Test connection'}
          </button>
          {probe.state !== 'idle' && probe.state !== 'testing' && (
            <span className={`wizard-probe-msg mono ${probe.state}`}>{probe.message}</span>
          )}
        </div>
      )}
    </>
  )
}
