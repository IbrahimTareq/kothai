// SetupWizard — the first thing a fresh install shows when it has no endpoint
// configured. Three questions: where the AI runs, which provider, and the key.
// It hands the answers up; Onboarding still owns the model picker and the
// actual POST, so there is exactly one place that talks to /api/setup.
import { useState } from 'react'
import { Icon } from '../components/icons'
import { EndpointPicker, type EndpointChoice } from '../components/EndpointPicker'
import { API } from '../data/api'
import type { EndpointOption } from '../types'
import { Button } from '../ui/Button'

export function SetupWizard({
  endpoints,
  preselect,
  localSupported,
  onLocal,
  onConnected,
  onSkip,
}: {
  endpoints: EndpointOption[]
  // A provider id the installer already collected. When present the first
  // question is skipped entirely — it has been answered in the terminal, and
  // asking again would make the installer's question pointless.
  preselect?: string | null
  // False on the lite image, where @qvac/sdk is absent.
  localSupported: boolean
  onLocal: () => void
  // Rejects with a message to show if the endpoint could not be saved.
  onConnected: (r: EndpointChoice) => Promise<void>
  onSkip: () => void
}) {
  const [connecting, setConnecting] = useState(Boolean(preselect))
  const [choice, setChoice] = useState<EndpointChoice | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Success unmounts this screen, so busy is only ever cleared on failure.
  const connect = async () => {
    if (!choice || busy) return
    setBusy(true)
    setErr(null)
    try {
      await API.checkEndpoint(choice.providerId, choice.baseUrl, choice.apiKey)
      await onConnected(choice)
    } catch (e) {
      setErr((e as Error).message || 'Could not connect.')
      setBusy(false)
    }
  }

  // Step 1 — where.
  if (!connecting) {
    return (
      <div className="onboarding">
        <div className="onboarding-card">
          <header className="onboarding-head">
            <span className="onboarding-mark">
              <Icon name="settings" size={22} />
            </span>
            <h1>Where should the AI run?</h1>
            <p className="onboarding-lede">
              Kothai reads everything you save and files it. That reading has to happen somewhere.
            </p>
          </header>

          <div className="wizard-choices">
            <button className="wizard-choice" onClick={() => setConnecting(true)}>
              <span className="wizard-choice-title">A cloud service</span>
              <span className="wizard-choice-desc">
                Nothing to download. You paste an API key and pay the provider for what you use.
              </span>
            </button>
            {/* Greyed rather than hidden on the lite image: a lone cloud card
                read as the only way Kothai can run, with no hint that a full
                image could keep everything on the box. */}
            <button className="wizard-choice" onClick={onLocal} disabled={!localSupported}>
              <span className="wizard-choice-title">On this machine</span>
              <span className="wizard-choice-desc">
                {localSupported
                  ? 'Nothing leaves the box, no key, no bills. Downloads a few GB of models.'
                  : 'Not in the lite image, which runs no models itself. Install the full image to keep everything local.'}
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
          <span className="onboarding-mark">
            <Icon name="settings" size={22} />
          </span>
          <h1>Connect a service</h1>
          <p className="onboarding-lede">
            What you save is sent to this service to be read and filed. You can switch any time in Settings.
          </p>
        </header>

        <EndpointPicker
          endpoints={endpoints}
          preselect={preselect}
          onChange={c => {
            setChoice(c)
            setErr(null)
          }}
        />

        {err && (
          <p className="conn-err" role="alert">
            {err}
          </p>
        )}

        {/* Back beside the button it undoes, where every other wizard keeps
            it, not as a link under the card that read as leaving setup. */}
        <footer className="onboarding-foot">
          {!preselect && (
            <Button size="lg" onClick={() => setConnecting(false)} disabled={busy}>
              Back
            </Button>
          )}
          <Button tone="solid" size="lg" onClick={connect} disabled={!choice || busy}>
            {busy ? 'Connecting…' : 'Connect'}
          </Button>
        </footer>

        {preselect && (
          <button className="onboarding-skip" onClick={onSkip}>
            Skip for now — run without AI.
          </button>
        )}
      </div>
    </div>
  )
}
