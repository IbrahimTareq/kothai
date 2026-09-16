// SetupWizard — the first thing a fresh install shows when it has no endpoint
// configured. Three questions: where the AI runs, which provider, and the key.
// It hands the answers up; Onboarding still owns the model picker and the
// actual POST, so there is exactly one place that talks to /api/setup.
import { useState } from 'react'
import { Icon } from '../components/icons'
import { EndpointPicker, type EndpointChoice } from '../components/EndpointPicker'
import type { EndpointOption } from '../types'

// The wizard's answer is exactly what the shared picker produces; the alias
// keeps Onboarding's import stable.
export type WizardResult = EndpointChoice

export function SetupWizard({
  endpoints,
  preselect,
  onLocal,
  onConnected,
  onSkip,
}: {
  endpoints: EndpointOption[]
  // A provider id the installer already collected. When present the first
  // question is skipped entirely — it has been answered in the terminal, and
  // asking again would make the installer's question pointless.
  preselect?: string | null
  onLocal: () => void
  onConnected: (r: WizardResult) => void
  onSkip: () => void
}) {
  const [connecting, setConnecting] = useState(Boolean(preselect))
  const [choice, setChoice] = useState<WizardResult | null>(null)

  // Step 1 — where.
  if (!connecting) {
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
            <button className="wizard-choice" onClick={() => setConnecting(true)}>
              <span className="wizard-choice-title">A cloud service</span>
              <span className="wizard-choice-desc">
                Nothing to download. You paste an API key and pay the provider for what you use.
              </span>
            </button>
            <button className="wizard-choice" onClick={onLocal}>
              <span className="wizard-choice-title">On this machine</span>
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

        <EndpointPicker endpoints={endpoints} preselect={preselect} onChange={setChoice} />

        <footer className="onboarding-foot">
          <span className="onboarding-size mono"></span>
          <button className="btn btn--solid btn--lg" onClick={() => choice && onConnected(choice)} disabled={!choice}>
            Continue
          </button>
        </footer>

        <button className="onboarding-skip" onClick={() => (preselect ? onSkip() : setConnecting(false))}>
          {preselect ? 'Skip for now — run without AI.' : 'Back'}
        </button>
      </div>
    </div>
  )
}
