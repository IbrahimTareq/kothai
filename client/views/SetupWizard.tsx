// SetupWizard — the first thing a fresh install shows when it has no endpoint
// configured. Two questions: which provider, and the key — and a third after a
// provider that serves no embeddings (Claude): which provider does search by
// meaning, or none. It once opened on "where should the AI run?", cloud or this
// machine; with the on-device provider gone, a provider running beside Kothai
// is the Ollama tile among the others.
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
  onConnected,
  onSkip,
}: {
  endpoints: EndpointOption[]
  // A provider id the installer already collected, picked in advance — it has
  // been answered in the terminal, and asking again would make the installer's
  // question pointless.
  preselect?: string | null
  // Rejects with a message to show if the endpoint could not be saved.
  // `embed` is the embeddings step's answer; null when skipped or not asked.
  onConnected: (r: EndpointChoice, embed: EndpointChoice | null) => Promise<void>
  onSkip: () => void
}) {
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
      // Saved at the URL that answered, which for the Ollama tile may be its second.
      const checked = { ...choice, baseUrl: await API.checkEndpoint(choice.providerId, choice.baseUrl, choice.apiKey) }
      if (primary) return onConnected(primary, checked)
      if (endpoints.find(e => e.id === choice.providerId)?.servesEmbeddings) return onConnected(checked, null)
      setPrimary(checked)
      setChoice(null)
      setBusy(false)
    })

  // Step 3 — the half of the job the chosen provider cannot do.
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

  // Steps 1 and 2 — which provider, and the key.
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

        <footer className="onboarding-foot">
          <Button tone="solid" size="lg" onClick={connect} disabled={!choice || busy}>
            {busy ? 'Connecting…' : 'Connect'}
          </Button>
        </footer>

        <button className="onboarding-skip" onClick={onSkip}>
          Skip for now — run without AI. You can connect a service any time in Settings.
        </button>
      </div>
    </div>
  )
}
