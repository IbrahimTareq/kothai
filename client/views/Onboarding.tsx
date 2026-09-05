// Onboarding.tsx — first-run model picker. On a fresh install the server holds
// off on downloading any model until the user confirms a selection here. Picking
// only updates local state; "Download & start" commits the choice via
// /api/setup, which kicks off the initial download. We then show the shared boot
// progress bar until the models report ready, at which point onComplete() hands
// control to the main app.
import { useState, useEffect } from 'react'
import { Icon } from '../components/icons'
import { RoleAccordion, fmtGB, type Role } from '../components/ModelPicker'
import { API } from '../data/api'
import type { SettingsResponse, VaultStatus } from '../types'

// Every locally-served role downloads up front at setup (on-demand roles are
// then unloaded), so first use is a fast local load — count them all toward the
// download size. Roles an endpoint serves download nothing and are filtered out
// below, so a mixed install only asks about the ones it will fetch.
const UPFRONT: Role[] = ['llm', 'embed', 'vision']

export function Onboarding({ vault, onComplete }: { vault: VaultStatus; onComplete: () => void }) {
  const [cfg, setCfg] = useState<SettingsResponse | null>(null)
  const [sel, setSel] = useState<Record<Role, string> | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    API.settings().then((c) => { setCfg(c); setSel({ ...c.current }) }).catch(() => setErr('Could not reach the server.'))
  }, [])

  // The models start loading once we submit; when they're ready, enter the app.
  useEffect(() => { if (submitted && vault.state === 'ready') onComplete() }, [submitted, vault.state, onComplete])

  const pick = (role: Role, key: string) => setSel((s) => (s ? { ...s, [role]: key } : s))

  // Only the roles this machine actually serves on-device get downloaded, so a
  // mixed install asks about those and leaves the endpoint-served roles alone.
  const localRoles = cfg ? UPFRONT.filter((role) => cfg.capabilities.roles[role] === 'local') : []
  const allLocal = localRoles.length === UPFRONT.length

  const upfrontBytes = cfg && sel
    ? localRoles.reduce((sum, role) => sum + (cfg.presets[role].find((p) => p.key === sel[role])?.sizeBytes || 0), 0)
    : 0

  const start = async () => {
    if (!sel || submitted) return
    setErr(null)
    setSubmitted(true)
    try {
      await API.setup(sel)
    } catch (e) {
      setSubmitted(false)
      setErr((e as Error).message || 'Setup failed. Please try again.')
    }
  }

  const skip = async () => {
    if (submitted) return
    setErr(null)
    try {
      await API.setup({ skip: true })
      onComplete()
    } catch (e) {
      setErr((e as Error).message || 'Setup failed. Please try again.')
    }
  }

  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <header className="onboarding-head">
          <span className="onboarding-mark"><Icon name="settings" size={22} /></span>
          <h1>Choose your models</h1>
          {/* Until settings arrive, assume the all-local case — it's the common
              one, and the mixed copy would be wrong for it. */}
          <p className="onboarding-lede">
            {!cfg || allLocal
              ? <>Kothai runs entirely on your machine. Pick the local models that fit your hardware —
                  you can change any of these later in Settings.</>
              : <>The rest of your inference runs on a remote endpoint — these are the models that stay on
                  your machine. Pick what fits your hardware; you can change this later in Settings.</>}
          </p>
        </header>

        {err && <div className="onboarding-err mono">{err}</div>}

        {!cfg || !sel
          ? <div className="settings-loading mono">LOADING…</div>
          : submitted
            ? (
              <div className="onboarding-progress">
                <div className="settings-progress-track">
                  <div className="settings-progress-bar" style={{ width: (vault.pct || 0) + '%' }}></div>
                </div>
                <span className="settings-progress-msg mono">
                  {vault.state === 'error' ? (vault.msg || 'Model load failed') : (vault.msg || 'Downloading models…')}
                </span>
              </div>
            )
            : (
              <>
                <div className="onboarding-picker">
                  {localRoles.map((role) => (
                    <RoleAccordion key={role} role={role}
                      presets={cfg.presets[role]}
                      currentKey={sel[role]}
                      busy={false}
                      switching={false}
                      pct={0}
                      defaultOpen={role === localRoles[0]}
                      onPick={(key) => pick(role, key)} />
                  ))}
                </div>
                <footer className="onboarding-foot">
                  <span className="onboarding-size mono">
                    {upfrontBytes ? `Initial download ≈ ${fmtGB(upfrontBytes)}` : ''}
                  </span>
                  <button className="onboarding-start" onClick={start}>Download &amp; start</button>
                </footer>
                <button className="onboarding-skip" onClick={skip}>
                  {allLocal
                    ? 'Skip for now — run without AI. You can enable models any time in Settings.'
                    : 'Skip for now — run on your endpoint alone. You can enable these models any time in Settings.'}
                </button>
              </>
            )}
      </div>
    </div>
  )
}
