// Settings.tsx — the app's settings surface. Built around two primitives so new
// settings can be dropped in as the app grows: <SettingsGroup> for a labelled
// block, and <SettingsRow> for one action inside a bordered row list (both in
// components/SettingsRow.tsx, so per-section components can use them too —
// Import is one, see components/ImportSection.tsx).
// Model Cores is a group: each model role (language / embedding / vision) is a
// collapsible <RoleAccordion> whose header shows the role, its purpose, and the
// currently selected model. Picking applies via /api/settings; the server swaps
// models in the background. Everything below it — export, backup, import,
// re-tag, erase — is one row list, each row a title + explanation on the left
// and its control on the right, expanding in place when a step needs confirming.
import { useState, useEffect } from 'react'
import { Icon } from '../components/icons'
import { RoleAccordion, RemoteModelField, ROLE_META, fmtGB, type Role } from '../components/ModelPicker'
import { SettingsGroup, SettingsRow } from '../components/SettingsRow'
import { ImportSection } from '../components/ImportSection'
import { API } from '../data/api'
import type { Residency, SettingsResponse, VaultStatus } from '../types'

export function SettingsView({ vault, theme, setTheme }: {
  vault: VaultStatus
  theme: 'dark' | 'light'
  setTheme: (t: 'dark' | 'light') => void
}) {
  const [cfg, setCfg] = useState<SettingsResponse | null>(null)
  const [busyRole, setBusyRole] = useState<Role | null>(null)
  const [pendingRole, setPendingRole] = useState<Role | null>(null) // role currently downloading
  const [backlog, setBacklog] = useState<number | null>(null)
  const [enriching, setEnriching] = useState(false)
  const [enrichError, setEnrichError] = useState(false)
  // Note count for the re-tag confirmation. It lives on /api/status rather
  // than on the VaultStatus prop, which is only the model-loading view of it.
  const [noteCount, setNoteCount] = useState<number | null>(null)
  const [retagArmed, setRetagArmed] = useState(false)
  const [retagging, setRetagging] = useState(false)
  const [retagQueued, setRetagQueued] = useState<number | null>(null)
  const [retagError, setRetagError] = useState<string | null>(null)
  const [wipeArmed, setWipeArmed] = useState(false)
  const [wipeConfirm, setWipeConfirm] = useState('')
  const [wiping, setWiping] = useState(false)
  const [wipeResult, setWipeResult] = useState<Awaited<ReturnType<typeof API.wipeAll>> | null>(null)
  const [wipeError, setWipeError] = useState<string | null>(null)

  useEffect(() => { API.settings().then(setCfg).catch(() => {}) }, [])
  useEffect(() => { API.status().then((s) => setNoteCount(s.count)).catch(() => {}) }, [])

  const switching = vault.state === 'loading'
  useEffect(() => { if (!switching) setPendingRole(null) }, [switching])

  const pick = async (role: Role, key: string) => {
    if (!cfg || busyRole || cfg.current[role] === key) return
    setBusyRole(role)
    setPendingRole(role)
    setCfg((c) => (c ? { ...c, current: { ...c.current, [role]: key } } : c))
    try {
      await API.saveSettings({ [role]: key })
    } catch {
      API.settings().then(setCfg).catch(() => {}) // revert to server truth
    }
    setBusyRole(null)
  }

  const pickRemote = async (role: Role, name: string) => {
    if (!cfg || busyRole || cfg.remote[role] === name) return
    setBusyRole(role)
    setCfg((c) => (c ? { ...c, remote: { ...c.remote, [role]: name } } : c))
    try {
      await API.saveSettings({ remote: { [role]: name } })
    } catch {
      API.settings().then(setCfg).catch(() => {}) // revert to server truth
    }
    setBusyRole(null)
  }

  const pickPolicy = async (role: Role, p: Residency) => {
    if (!cfg || busyRole || cfg.residency[role] === p) return
    const wasOff = cfg.residency[role] === 'off'
    setBusyRole(role)
    // Turning a role on can trigger a real (possibly multi-GB) background
    // download — give it the same per-role "↓ X%" feedback + auto-expand a
    // model-key swap already gets, instead of only the generic top progress bar.
    if (wasOff && p !== 'off') setPendingRole(role)
    setCfg((c) => (c ? { ...c, residency: { ...c.residency, [role]: p } } : c))
    try {
      await API.saveSettings({ residency: { [role]: p } })
      if (wasOff && p !== 'off') {
        const { count } = await API.backlog()
        if (count > 0) setBacklog(count)
      }
    } catch {
      API.settings().then(setCfg).catch(() => {}) // revert to server truth
    }
    setBusyRole(null)
  }

  // Enrich-now: only dismiss the banner on confirmed success — a fire-and-forget
  // dismiss-then-request would silently swallow a failure with no way to retry.
  const enrichNow = async () => {
    setEnriching(true)
    setEnrichError(false)
    try {
      await API.enrichBacklog()
      setBacklog(null)
    } catch {
      setEnrichError(true)
    }
    setEnriching(false)
  }

  // Re-tag everything. Deliberately two-step: it re-runs the language model
  // over every saved note, which on a real library is hours of background work
  // and cannot be called back once queued. The count comes from the server so
  // the confirmation states what actually happened rather than what the client
  // guessed.
  const retagAll = async () => {
    if (retagging) return
    setRetagging(true)
    setRetagError(null)
    setRetagQueued(null)
    try {
      const { queued } = await API.retagAll()
      setRetagQueued(queued)
      setRetagArmed(false)
      // Everything is pending again, so the backlog banner's count is stale.
      API.backlog().then((b) => setBacklog(b.count > 0 ? b.count : null)).catch(() => {})
    } catch (e) {
      setRetagError(e instanceof Error && e.message ? e.message : 'Could not start re-tagging.')
    }
    setRetagging(false)
  }

  // Danger zone. The typed token is the confirmation — it's sent to the
  // server, which enforces it independently (see server/routes/wipe.js), so
  // this input is a deliberate speed bump rather than the only thing standing
  // between a stray click and every note the user has.
  const WIPE_TOKEN = 'DELETE'

  const wipeAll = async () => {
    if (wipeConfirm !== WIPE_TOKEN || wiping) return
    setWiping(true)
    setWipeError(null)
    try {
      const result = await API.wipeAll(wipeConfirm)
      setWipeResult(result)
      setWipeArmed(false)
      setWipeConfirm('')
      // Everything on screen that came from the store is now gone; re-read
      // the backlog so the enrich banner doesn't keep offering to enrich
      // notes that no longer exist.
      setBacklog(null)
      API.backlog().then((b) => setBacklog(b.count)).catch(() => {})
    } catch (e) {
      const err = e instanceof Error ? (e as Error & { code?: string }) : null
      setWipeError(
        err?.code === 'import_in_progress' ? 'An import is running — wait for it to finish, then try again.'
        : err?.message || 'Could not erase your data — check the server and try again.',
      )
      setWipeResult(null)
    }
    setWiping(false)
  }

  const summarizeWipe = (r: NonNullable<typeof wipeResult>) => {
    const c = r.cleared
    if (!c.notes && !c.collections && !c.chats) return 'There was nothing left to erase.'
    const parts = [`Erased ${c.notes} note${c.notes === 1 ? '' : 's'}`]
    if (c.collections > 0) parts.push(`${c.collections} space${c.collections === 1 ? '' : 's'}`)
    if (c.chats > 0) parts.push(`${c.chats} chat${c.chats === 1 ? '' : 's'}`)
    return parts.join(', ') + '. Your models and settings are untouched.'
  }

  // Approximate RAM footprint: idle = always-on roles, peak = everything enabled.
  const roles = Object.keys(ROLE_META) as Role[]
  const sizeOf = (c: SettingsResponse, r: Role) => c.presets[r].find((p) => p.key === c.current[r])?.sizeBytes || 0
  const idleGB = cfg ? fmtGB(roles.filter((r) => cfg.residency[r] === 'always').reduce((s, r) => s + sizeOf(cfg, r), 0)) : ''
  const peakGB = cfg ? fmtGB(roles.filter((r) => cfg.residency[r] !== 'off').reduce((s, r) => s + sizeOf(cfg, r), 0)) : ''
  const remote = cfg && !cfg.capabilities.managesResidency

  return (
    <div className="settings-view">
      <header className="gal-head">
        <div className="gal-title">
          <span className="gt-icon"><Icon name="settings" size={20} /></span>
          <div>
            <h2>Settings</h2>
          </div>
        </div>
      </header>

      {switching && (
        <div className="settings-progress">
          <div className="settings-progress-track">
            <div className="settings-progress-bar" style={{ width: (vault.pct || 0) + '%' }}></div>
          </div>
          <span className="settings-progress-msg mono">{vault.msg || vault.txt}</span>
        </div>
      )}

      {!cfg
        ? <div className="settings-loading mono">LOADING…</div>
        : <div className="settings-body">
            <SettingsGroup label="MODEL CORES"
              sub={remote
                ? `Inference runs on a remote endpoint${cfg.endpoint.host ? ` (${cfg.endpoint.host})` : ''}. Set the endpoint and credentials with STASH_AI_BASE_URL and STASH_AI_API_KEY.`
                : <>Idle ≈ <b>{idleGB || '0.0 GB'}</b> · Peak ≈ <b>{peakGB || '0.0 GB'}</b> of RAM, from each model's residency below.</>}>
              {backlog !== null && (
                <div className="backlog-banner">
                  <span>
                    {enrichError
                      ? "Couldn't start enrichment — check the server and try again."
                      : <>{backlog} saved note{backlog === 1 ? '' : 's'} can now be enriched with your current AI settings.</>}
                  </span>
                  <span className="backlog-actions">
                    <button className="backlog-go" onClick={enrichNow} disabled={enriching}>
                      {enriching ? 'Starting…' : 'Enrich now'}
                    </button>
                    <button className="backlog-later" onClick={() => setBacklog(null)} disabled={enriching}>Later</button>
                  </span>
                </div>
              )}
              {roles.map((role) => (
                remote ? (
                  <div key={role} className="role-acc open">
                    <div className="role-acc-head">
                      <span className="role-acc-info">
                        <span className="role-acc-title mono">{ROLE_META[role].title}</span>
                        <span className="role-acc-sub">{ROLE_META[role].sub}</span>
                      </span>
                      <span className="role-acc-current mono">{cfg.remote[role] || '—'}</span>
                    </div>
                    <div className="model-list">
                      <RemoteModelField
                        role={role}
                        value={cfg.remote[role]}
                        options={cfg.presets[role]}
                        busy={busyRole === role}
                        onCommit={(v) => pickRemote(role, v)}
                      />
                    </div>
                  </div>
                ) : (
                  <RoleAccordion key={role} role={role}
                    presets={cfg.presets[role]}
                    currentKey={cfg.current[role]}
                    policy={cfg.residency[role]}
                    onPolicy={(p) => pickPolicy(role, p)}
                    busy={busyRole !== null || switching}
                    switching={switching && pendingRole === role}
                    pct={vault.pct || 0}
                    defaultOpen={switching && pendingRole === role}
                    onPick={(key) => pick(role, key)} />
                )
              ))}
            </SettingsGroup>

            <ImportSection />

            <SettingsGroup label="YOUR DATA">
              <div className="settings-rows">
                <SettingsRow title="Export"
                  desc={<>Everything you've saved — notes, spaces, chats, and settings — as one JSON file. Good for backups or moving to a new install.</>}
                  action={<a className="row-btn" href="/api/export" download>Download export</a>} />

                <SettingsRow title="Backup"
                  desc={<>A snapshot of the database itself, exactly as stored, safe to download while Kothai is running. Images you pasted or dropped live outside the database, so keep a copy of <code>data/uploads</code> alongside it.</>}
                  action={<a className="row-btn" href="/api/backup" download>Download backup</a>} />

                <SettingsRow title="Re-tag everything"
                  desc={<>Re-run the language model over every saved note, so titles, summaries and tags are rebuilt from everything a note carries now. Worth doing after a big import or after switching language models. Tags you've edited by hand are kept, and it runs in the background.</>}
                  action={!retagArmed && (
                    <button className="row-btn" onClick={() => { setRetagArmed(true); setRetagError(null); setRetagQueued(null) }} disabled={retagging}>
                      Re-tag all notes…
                    </button>
                  )}>
                  {retagArmed && (
                    <div className="settings-row-extra">
                      <div className="danger-confirm retag-confirm">
                        <label>
                          Re-tag {noteCount === null ? 'every saved note' : <>all <b>{noteCount}</b> note{noteCount === 1 ? '' : 's'}</>}? It can't be stopped once it starts.
                        </label>
                        <div className="danger-confirm-row">
                          <button className="retag-go" onClick={retagAll} disabled={retagging}>
                            {retagging ? 'Starting…' : 'Yes, re-tag everything'}
                          </button>
                          <button className="danger-cancel" onClick={() => setRetagArmed(false)} disabled={retagging}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                  {retagQueued !== null && (
                    <div className="settings-row-extra">
                      <div className="import-result" role="status" aria-live="polite">
                        Queued {retagQueued} note{retagQueued === 1 ? '' : 's'}. They'll re-tag in the background — you can keep using the app.
                      </div>
                    </div>
                  )}
                  {retagError && (
                    <div className="settings-row-extra">
                      <div className="import-error" role="status" aria-live="polite">{retagError}</div>
                    </div>
                  )}
                </SettingsRow>

                <SettingsRow danger title="Erase all data"
                  desc={<>Erase everything you've saved — notes, spaces, chats, tags, and uploaded images. Your models and settings stay as they are. <b>This cannot be undone</b>, so download an export first if there's any doubt.</>}
                  action={!wipeArmed && (
                    <button className="row-btn danger" onClick={() => { setWipeArmed(true); setWipeError(null); setWipeResult(null) }}>
                      Erase all data…
                    </button>
                  )}>
                  {wipeArmed && (
                    <div className="settings-row-extra">
                      <div className="danger-confirm">
                        <label htmlFor="wipe-confirm">Type <b>{WIPE_TOKEN}</b> to confirm.</label>
                        <div className="danger-confirm-row">
                          <input id="wipe-confirm" className="danger-input" value={wipeConfirm} autoFocus
                            disabled={wiping} spellCheck={false} autoComplete="off" placeholder={WIPE_TOKEN}
                            onChange={(e) => setWipeConfirm(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') wipeAll(); if (e.key === 'Escape') { setWipeArmed(false); setWipeConfirm('') } }} />
                          <button className="danger-go" onClick={wipeAll} disabled={wipeConfirm !== WIPE_TOKEN || wiping}>
                            {wiping ? 'Erasing…' : 'Erase everything'}
                          </button>
                          <button className="danger-cancel" onClick={() => { setWipeArmed(false); setWipeConfirm('') }} disabled={wiping}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                  {wipeResult && (
                    <div className="settings-row-extra">
                      <div className="import-result" role="status" aria-live="polite">{summarizeWipe(wipeResult)}</div>
                    </div>
                  )}
                  {wipeError && (
                    <div className="settings-row-extra">
                      <div className="import-error" role="status" aria-live="polite">{wipeError}</div>
                    </div>
                  )}
                </SettingsRow>
              </div>
            </SettingsGroup>

            {/* Lives here rather than in the chrome because on phones the top
                of every screen is now given back to content — see the tab bar
                in foundation/responsive.css. The desktop rail keeps its own
                theme button; both read the same state, so they stay in step. */}
            <SettingsGroup label="APPEARANCE">
              <div className="settings-rows">
                <SettingsRow title="Theme"
                  desc={<>Light or dark. Remembered on this device, not in your vault, so each device you open Kothai on keeps its own.</>}
                  action={
                    <div className="seg" role="group" aria-label="Theme">
                      <button className={'seg-btn' + (theme === 'light' ? ' on' : '')}
                        aria-pressed={theme === 'light'} onClick={() => setTheme('light')}>Light</button>
                      <button className={'seg-btn' + (theme === 'dark' ? ' on' : '')}
                        aria-pressed={theme === 'dark'} onClick={() => setTheme('dark')}>Dark</button>
                    </div>
                  } />
              </div>
            </SettingsGroup>
          </div>}
    </div>
  )
}
