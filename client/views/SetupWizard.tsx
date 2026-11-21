// SetupWizard — the first thing a fresh install shows when it has no endpoint
// configured. Three questions: where the AI runs, which provider, and the key —
// and a fourth after a provider that serves no embeddings (Claude): which
// provider does search by meaning, or none.
// It hands the answers up; Onboarding still owns the model picker and the
// actual POST, so there is exactly one place that talks to /api/setup.
import { useState } from 'react'
import { Icon } from '../components/icons'
import { EndpointPicker, type EndpointChoice } from '../components/settings/EndpointPicker'
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
  // `embed` is the embeddings step's answer; null when skipped or not asked.
  onConnected: (r: EndpointChoice, embed: EndpointChoice | null) => Promise<void>
  onSkip: () => void
}) {
  const [connecting, setConnecting] = useState(Boolean(preselect))
  const [choice, setChoice] = useState<EndpointChoice | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // A checked provider that serves no embeddings, held until the embeddings
  // step answers. Nothing is applied before then.
  const [primary, setPrimary] = useState<EndpointChoice | null>(null)

  // Success unmounts this screen, so busy is only ever cleared on failure, or
  // on moving to the embeddings step.
  const attempt = async (step: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setErr(null)
    try {
      await step()
    } catch (e) {
      setErr((e as Error).message || 'Could not connect.')
      setBusy(false)
    }
  }

  const connect = () =>
    choice &&
    attempt(async () => {
      await API.checkEndpoint(choice.providerId, choice.baseUrl, choice.apiKey)
      if (primary) return onConnected(primary, choice)
      if (endpoints.find(e => e.id === choice.providerId)?.servesEmbeddings) return onConnected(choice, null)
      setPrimary(choice)
      setChoice(null)
      setBusy(false)
    })

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

  // Step 4 — the half of the job the chosen provider cannot do.
  if (primary) {
    const label = endpoints.find(e => e.id === primary.providerId)?.label || 'That service'
    return (
      <div className="onboarding">
        <div className="onboarding-card">
          <header className="onboarding-head">
            <span className="onboarding-mark">
              <Icon name="settings" size={22} />
            </span>
            <h1>Pick a provider for search by meaning</h1>
            <p className="onboarding-lede">
              {label} reads and files what you save, but it makes no embeddings, which finding things by meaning needs.
              Another service can do just that part.
            </p>
          </header>

          <EndpointPicker
            key="embed"
            endpoints={endpoints.filter(e => e.servesEmbeddings)}
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

          <footer className="onboarding-foot">
            <Button
              size="lg"
              onClick={() => {
                setPrimary(null)
                setChoice(null)
              }}
              disabled={busy}
            >
              Back
            </Button>
            <Button tone="ghost" size="lg" onClick={() => attempt(() => onConnected(primary, null))} disabled={busy}>
              Skip: keyword search only
            </Button>
            <Button tone="solid" size="lg" onClick={connect} disabled={!choice || busy}>
              {busy ? 'Connecting…' : 'Connect'}
            </Button>
          </footer>
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
