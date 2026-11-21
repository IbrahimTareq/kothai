// Onboarding.tsx — first run. With no endpoint yet, the SetupWizard connects
// one; then each role is given a model the endpoint serves, and "Save & start"
// commits the names via /api/setup and hands control to the main app.
import { useState, useEffect } from 'react'
import { Icon } from '../components/icons'
import { RemoteModelField, ROLE_META, type Role } from '../components/settings/ModelPicker'
import { API } from '../data/api'
import type { SettingsResponse } from '../types'
import { SetupWizard } from './SetupWizard'
import { Button } from '../ui/Button'

const ROLES: Role[] = ['llm', 'embed', 'vision']

export function Onboarding({ onComplete }: { onComplete: () => void }) {
  const [cfg, setCfg] = useState<SettingsResponse | null>(null)
  const [remoteSel, setRemoteSel] = useState<Record<Role, string> | null>(null)
  const [err, setErr] = useState<string | null>(null)
  // The wizard runs only when this install has no endpoint yet.
  const [wizardDone, setWizardDone] = useState(false)

  useEffect(() => {
    API.settings()
      .then(c => {
        setCfg(c)
        setRemoteSel({ ...c.remote })
      })
      .catch(() => setErr('Could not reach the server.'))
  }, [])

  const pickRemote = (role: Role, id: string) => setRemoteSel(s => (s ? { ...s, [role]: id } : s))

  // Only ids that were filled in: a blank is a role left off until Settings,
  // and sending it would say nothing the server does not already assume.
  const remotePatch = () =>
    Object.fromEntries(ROLES.map(role => [role, (remoteSel?.[role] || '').trim()]).filter(([, id]) => id))

  const start = async () => {
    setErr(null)
    try {
      await API.setup({ remote: remotePatch() })
      onComplete()
    } catch (e) {
      setErr((e as Error).message || 'Setup failed. Please try again.')
    }
  }

  const skip = async () => {
    setErr(null)
    try {
      await API.setup({ skip: true })
      onComplete()
    } catch (e) {
      setErr((e as Error).message || 'Setup failed. Please try again.')
    }
  }

  // What the installer already asked, so the wizard never asks it twice.
  const preAnswered = cfg?.setup?.providerId || null
  const needsWizard = Boolean(cfg) && !cfg!.endpoint.configured && !wizardDone
  if (needsWizard) {
    return (
      <SetupWizard
        endpoints={cfg!.catalogue}
        preselect={preAnswered}
        onSkip={skip}
        onConnected={async (r, embed) => {
          // Apply it NOW rather than at submit. The picker below offers each
          // role the catalogue of the endpoint that serves it, so the server
          // has to know before we re-read settings and draw it. A failure
          // rejects back to the wizard, which shows it beside the key; moving
          // on regardless left the model picker drawn for an endpoint that
          // was never saved.
          await API.applyEndpoint({ providerId: r.providerId, baseUrl: r.baseUrl, apiKey: r.apiKey }, r.defaults)
          // A tile that serves no embeddings came with a second provider for
          // them, or none if the user chose keyword search only.
          if (embed) {
            const { providerId, baseUrl, apiKey } = embed
            await API.applyEndpoint({ providerId, baseUrl, apiKey }, { embed: embed.defaults.embed }, 'embed')
          }
          const fresh = await API.settings()
          setCfg(fresh)
          // Seed the endpoint's model fields from the provider's defaults so
          // the next screen is filled in rather than three empty boxes.
          setRemoteSel({ ...fresh.remote, ...r.defaults, ...(embed && { embed: embed.defaults.embed }) })
          setWizardDone(true)
        }}
      />
    )
  }

  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <header className="onboarding-head">
          <span className="onboarding-mark">
            <Icon name="settings" size={22} />
          </span>
          <h1>Name your models</h1>
          <p className="onboarding-lede">
            Every role runs on {cfg?.endpoint.host || 'your endpoint'}. Name a model it serves for each one — nothing
            downloads, and you can change these later in Settings.
          </p>
        </header>

        {err && <div className="onboarding-err">{err}</div>}

        {!cfg ? (
          <div className="settings-loading">Loading…</div>
        ) : (
          <>
            <div className="onboarding-picker">
              {ROLES.map(role => (
                // Same markup Settings uses for each role, so the two screens
                // don't drift apart visually.
                <div key={role} className="role-acc open">
                  <div className="role-acc-head">
                    <span className="role-acc-info">
                      <span className="role-acc-title">{ROLE_META[role].title}</span>
                      <span className="role-acc-sub">{ROLE_META[role].sub}</span>
                    </span>
                  </div>
                  <div className="model-list">
                    <RemoteModelField
                      role={role}
                      value={remoteSel?.[role] || ''}
                      options={cfg.presets[role]}
                      busy={false}
                      onCommit={id => pickRemote(role, id)}
                    />
                  </div>
                </div>
              ))}
            </div>
            <footer className="onboarding-foot">
              <Button tone="solid" size="lg" onClick={start}>
                Save &amp; start
              </Button>
            </footer>
            <button className="onboarding-skip" onClick={skip}>
              Skip for now — run without AI. You can enable models any time in Settings.
            </button>
          </>
        )}
      </div>
    </div>
  )
}
