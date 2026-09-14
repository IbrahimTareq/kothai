// SetupWizard — the first thing a fresh install shows when it has no endpoint
// configured. Three questions: where the AI runs, which provider, and the key.
// It hands the answers up; Onboarding still owns the model picker and the
// actual POST, so there is exactly one place that talks to /api/setup.
import { useState } from 'react'
import { Icon } from '../components/icons'
import { API } from '../data/api'
import type { EndpointOption } from '../types'

export interface WizardResult {
  providerId: string
  baseUrl: string
  apiKey: string
  models: string[]
  defaults: { llm: string; embed: string; vision: string }
}

type Probe = { state: 'idle' | 'testing' | 'ok' | 'fail'; message: string; models: string[] }

export function SetupWizard({
  endpoints,
  onLocal,
  onConnected,
  onSkip,
}: {
  endpoints: EndpointOption[]
  onLocal: () => void
  onConnected: (r: WizardResult) => void
  onSkip: () => void
}) {
  const [picked, setPicked] = useState<EndpointOption | null>(null)
  const [url, setUrl] = useState('')
  const [key, setKey] = useState('')
  const [probe, setProbe] = useState<Probe>({ state: 'idle', message: '', models: [] })

  const baseUrl = (picked?.baseUrl || url).trim()
  const canTest = baseUrl.length > 0 && (!picked?.needsKey || key.trim().length > 0)

  const test = async () => {
    if (!canTest) return
    setProbe({ state: 'testing', message: '', models: [] })
    try {
      const r = await API.testEndpoint(baseUrl, key.trim())
      setProbe(
        r.ok
          ? { state: 'ok', message: `${r.models.length} models available`, models: r.models }
          : { state: 'fail', message: r.error || 'Could not reach that endpoint.', models: [] },
      )
    } catch (e) {
      setProbe({ state: 'fail', message: (e as Error).message || 'Could not reach that endpoint.', models: [] })
    }
  }

  const proceed = () => {
    if (!picked) return
    onConnected({ providerId: picked.id, baseUrl, apiKey: key.trim(), models: probe.models, defaults: picked.defaults })
  }

  // Step 1 — where.
  if (!picked) {
    return (
      <div className="onboarding">
        <div className="onboarding-card">
          <header className="onboarding-head">
            <span className="onboarding-mark"><Icon name="settings" size={22} /></span>
            <h1>Where should the AI run?</h1>
            <p className="onboarding-lede">
              Kothai reads everything you save and files it. That reading has to happen somewhere.
            </p>
          </header>

          <div className="wizard-choices">
            <button className="wizard-choice" onClick={() => setPicked(endpoints[0])}>
              <span className="wizard-choice-title mono">A cloud service</span>
              <span className="wizard-choice-desc">
                Nothing to download. You paste an API key and pay the provider for what you use.
              </span>
            </button>
            <button className="wizard-choice" onClick={onLocal}>
              <span className="wizard-choice-title mono">On this machine</span>
              <span className="wizard-choice-desc">
                Nothing leaves the box, no key, no bills. Downloads a few GB of models.
              </span>
            </button>
          </div>

          <button className="onboarding-skip" onClick={onSkip}>
            Skip for now — run without AI. You can enable models any time in Settings.
          </button>
        </div>
      </div>
    )
  }

  // Steps 2 and 3 — which provider, and the key.
  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <header className="onboarding-head">
          <span className="onboarding-mark"><Icon name="settings" size={22} /></span>
          <h1>Connect a service</h1>
          <p className="onboarding-lede">
            Pick where your models run. Your key is stored on this machine only, and never appears in a
            backup or an export.
          </p>
        </header>

        <div className="wizard-providers">
          {endpoints.map((e) => (
            <button
              key={e.id}
              className={`wizard-provider${picked.id === e.id ? ' picked' : ''}`}
              onClick={() => { setPicked(e); setProbe({ state: 'idle', message: '', models: [] }) }}
            >
              <span className="wizard-provider-label mono">{e.label}</span>
              {!e.servesEmbeddings && <span className="wizard-provider-tag mono">chat only</span>}
            </button>
          ))}
        </div>

        <p className="wizard-note">{picked.note}</p>

        {!picked.baseUrl && (
          <label className="wizard-field">
            <span className="wizard-field-label mono">Endpoint URL</span>
            <input
              className="wizard-input mono"
              value={url}
              placeholder="https://your-server/v1"
              onChange={(ev) => setUrl(ev.target.value)}
            />
          </label>
        )}

        <label className="wizard-field">
          <span className="wizard-field-label mono">
            API key{!picked.needsKey && <span className="wizard-optional"> — not needed for this one</span>}
          </span>
          <input
            className="wizard-input mono"
            type="password"
            value={key}
            placeholder={picked.needsKey ? 'paste it here' : 'leave blank'}
            onChange={(ev) => setKey(ev.target.value)}
          />
        </label>

        <div className="wizard-probe">
          <button className="wizard-test" onClick={test} disabled={!canTest || probe.state === 'testing'}>
            {probe.state === 'testing' ? 'Checking…' : 'Test connection'}
          </button>
          {probe.state !== 'idle' && probe.state !== 'testing' && (
            <span className={`wizard-probe-msg mono ${probe.state}`}>{probe.message}</span>
          )}
        </div>

        <footer className="onboarding-foot">
          <span className="onboarding-size mono">
            {probe.state === 'fail' ? 'You can continue anyway and fix it in Settings.' : ''}
          </span>
          <button className="onboarding-start" onClick={proceed} disabled={!baseUrl}>
            Continue
          </button>
        </footer>

        <button className="onboarding-skip" onClick={() => setPicked(null)}>
          Back
        </button>
      </div>
    </div>
  )
}
