// Settings.tsx — the app's settings surface. Built around two primitives so new
// settings can be dropped in as the app grows: <SettingsGroup> for a labelled
// block, and <SettingsRow> for one action inside a bordered row list (both in
// components/settings/SettingsRow.tsx, so per-section components can use them too —
// Import is one, see components/settings/ImportSection.tsx).
// Model Cores is a group: each model role (language / embedding / vision) is a
// collapsible <RoleAccordion> whose header shows the role, its purpose, and the
// currently selected model. Picking applies via /api/settings; the server swaps
// models in the background. Everything below it — export, backup, import,
// re-tag, erase — is one row list, each row a title + explanation on the left
// and its control on the right, expanding in place when a step needs confirming.
import { useState, useEffect } from 'react'
import { RoleAccordion, RemoteModelField, ROLE_META, fmtGB, type Role } from '../components/settings/ModelPicker'
import { SettingsGroup, SettingsRow, RowStatus } from '../components/settings/SettingsRow'
import { ConnectionPanel } from '../components/settings/ConnectionPanel'
import { ImportSection } from '../components/settings/ImportSection'
import { TelegramSection } from '../components/settings/TelegramSection'
import { CaptureTokenSection } from '../components/settings/CaptureTokenSection'
import { AvailabilityRow } from '../components/settings/AvailabilityRow'
import { RestoreRow } from '../components/settings/RestoreRow'
import { BackupsRow } from '../components/settings/BackupsRow'
import { DriveRow } from '../components/settings/DriveRow'
import { ModelFilesRow } from '../components/settings/ModelFilesRow'
import { API, apiError } from '../data/api'
import type { Residency, SettingsResponse, ModelLoad } from '../types'
import { Button } from '../ui/Button'
import { PageHeader } from '../ui/PageHeader'
import { Segmented } from '../ui/Segmented'
import { Confirm } from '../ui/Confirm'
import { DemoSettings, useDemo } from '../components/Demo'

export function SettingsView({
  modelLoad,
  theme,
  setTheme,
}: {
  modelLoad: ModelLoad
  theme: 'dark' | 'light'
  setTheme: (t: 'dark' | 'light') => void
}) {
  const demo = !!useDemo()
  const [cfg, setCfg] = useState<SettingsResponse | null>(null)
  const [busyRole, setBusyRole] = useState<Role | null>(null)
  const [pendingRole, setPendingRole] = useState<Role | null>(null) // role currently downloading
  const [backlog, setBacklog] = useState<number | null>(null)
  const [enriching, setEnriching] = useState(false)
  const [enrichError, setEnrichError] = useState(false)
  // Note count for the re-tag confirmation. It lives on /api/status rather
  // than on the ModelLoad prop, which is only the model-loading view of it.
  const [noteCount, setNoteCount] = useState<number | null>(null)
  const [retagArmed, setRetagArmed] = useState(false)
  const [retagging, setRetagging] = useState(false)
  const [retagQueued, setRetagQueued] = useState<number | null>(null)
  const [retagError, setRetagError] = useState<string | null>(null)
  const [wipeArmed, setWipeArmed] = useState(false)
  const [wiping, setWiping] = useState(false)
  const [wipeResult, setWipeResult] = useState<Awaited<ReturnType<typeof API.wipeAll>> | null>(null)
  const [wipeError, setWipeError] = useState<string | null>(null)

  useEffect(() => {
    API.settings()
      .then(setCfg)
      .catch(() => {})
  }, [])
  useEffect(() => {
    API.status()
      .then(s => setNoteCount(s.count))
      .catch(() => {})
  }, [])

  const switching = modelLoad.state === 'loading'
  useEffect(() => {
    if (!switching) setPendingRole(null)
  }, [switching])

  // The three pickers below differ only in which field they set. The envelope
  // is the same every time — mark the role busy, move the UI before the server
  // answers, and on failure re-read the server rather than trying to undo the
  // optimistic edit by hand — and the revert in particular had been written
  // out three times. `project` is how the row should look if the write lands.
  const saveRole = async (
    role: Role,
    patch: Parameters<typeof API.saveSettings>[0],
    project: (c: SettingsResponse) => SettingsResponse,
  ) => {
    setBusyRole(role)
    setCfg(c => (c ? project(c) : c))
    try {
      await API.saveSettings(patch)
      return true
    } catch {
      API.settings()
        .then(setCfg)
        .catch(() => {}) // revert to server truth
      return false
    } finally {
      setBusyRole(null)
    }
  }

  const pick = (role: Role, key: string) => {
    if (!cfg || busyRole || cfg.current[role] === key) return
    setPendingRole(role)
    return saveRole(role, { [role]: key }, c => ({ ...c, current: { ...c.current, [role]: key } }))
  }

  const pickRemote = (role: Role, name: string) => {
    if (!cfg || busyRole || cfg.remote[role] === name) return
    return saveRole(role, { remote: { [role]: name } }, c => ({ ...c, remote: { ...c.remote, [role]: name } }))
  }

  const pickPolicy = async (role: Role, p: Residency) => {
    if (!cfg || busyRole || cfg.residency[role] === p) return
    // Turning a role on can trigger a real (possibly multi-GB) background
    // download — give it the same per-role "↓ X%" feedback + auto-expand a
    // model-key swap already gets, instead of only the generic top progress bar.
    const waking = cfg.residency[role] === 'off' && p !== 'off'
    if (waking) setPendingRole(role)
    const saved = await saveRole(role, { residency: { [role]: p } }, c => ({
      ...c,
      residency: { ...c.residency, [role]: p },
    }))
    // Only once the residency actually stuck, and a failure here is just a
    // missing banner: previously this shared the save's catch, so a backlog
    // probe that failed on its own re-read the whole settings document.
    if (!saved || !waking) return
    const count = await API.backlog()
      .then(b => b.count)
      .catch(() => 0)
    if (count > 0) setBacklog(count)
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
      API.backlog()
        .then(b => setBacklog(b.count > 0 ? b.count : null))
        .catch(() => {})
    } catch (e) {
      setRetagError(apiError(e, 'Could not start re-tagging.'))
    }
    setRetagging(false)
  }

  // Danger zone. The typed token is the confirmation — it's sent to the
  // server, which enforces it independently (see server/routes/wipe.ts), so
  // this input is a deliberate speed bump rather than the only thing standing
  // between a stray click and every note the user has.
  const WIPE_TOKEN = 'DELETE'

  const wipeAll = async () => {
    // <Confirm> only calls this once DELETE has been typed.
    if (wiping) return
    setWiping(true)
    setWipeError(null)
    try {
      const result = await API.wipeAll(WIPE_TOKEN)
      setWipeResult(result)
      setWipeArmed(false)
      // Everything on screen that came from the store is now gone; re-read
      // the backlog so the enrich banner doesn't keep offering to enrich
      // notes that no longer exist.
      setBacklog(null)
      API.backlog()
        .then(b => setBacklog(b.count))
        .catch(() => {})
    } catch (e) {
      setWipeError(
        apiError(e, 'Could not erase your data — check the server and try again.', {
          import_in_progress: 'An import is running — wait for it to finish, then try again.',
        }),
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
    return `${parts.join(', ')}. Your models and settings are untouched.`
  }

  // Approximate RAM footprint: idle = always-on roles, peak = everything enabled.
  const roles = Object.keys(ROLE_META) as Role[]
  const sizeOf = (c: SettingsResponse, r: Role) => c.presets[r].find(p => p.key === c.current[r])?.sizeBytes || 0
  const idleGB = cfg
    ? fmtGB(roles.filter(r => cfg.residency[r] === 'always').reduce((s, r) => s + sizeOf(cfg, r), 0))
    : ''
  const peakGB = cfg ? fmtGB(roles.filter(r => cfg.residency[r] !== 'off').reduce((s, r) => s + sizeOf(cfg, r), 0)) : ''
  // Per role, not per install: a mixed setup serves embedding from on-device
  // presets and the other two from endpoint-defined ids in the same panel.
  const isRemote = (role: Role) => cfg?.capabilities.roles[role] === 'remote'

  return (
    <div className="settings-view">
      <PageHeader title="Settings" />

      {switching && (
        <div className="settings-progress">
          <div className="settings-progress-track">
            <div className="settings-progress-bar" style={{ width: `${modelLoad.pct || 0}%` }}></div>
          </div>
          <span className="settings-progress-msg">{modelLoad.msg || modelLoad.txt}</span>
        </div>
      )}

      {/* On the demo the server refuses every setting here, and a page of
          greyed controls leaves gaps a fieldset cannot close: import takes a
          dropped file, and export and backup are plain links. */}
      {demo ? (
        <DemoSettings />
      ) : !cfg ? (
        <div className="settings-loading">Loading…</div>
      ) : (
        <div className="settings-body">
          <ConnectionPanel cfg={cfg} onChanged={setCfg} />

          <SettingsGroup
            label="Model cores"
            sub={
              roles.some(isRemote) ? (
                // Named by the same titles the accordions below carry, so the
                // sentence and the rows it describes read as one thing.
                `Inference ${
                  roles.every(isRemote)
                    ? ''
                    : `for ${roles
                        .filter(isRemote)
                        .map(r => ROLE_META[r].title.toLowerCase())
                        .join(' and ')} `
                }runs on a remote endpoint${cfg.endpoint.host ? ` (${cfg.endpoint.host})` : ''}. The endpoint and its key were set during setup and are stored on this machine only; KOTHAI_AI_BASE_URL and KOTHAI_AI_API_KEY override them.`
              ) : (
                <>
                  Idle ≈ <b>{idleGB || '0.0 GB'}</b> · Peak ≈ <b>{peakGB || '0.0 GB'}</b> of RAM, from each model's
                  residency below.
                </>
              )
            }
          >
            {backlog !== null && (
              <div className="backlog-banner">
                <span>
                  {enrichError ? (
                    "Couldn't start enrichment — check the server and try again."
                  ) : (
                    <>
                      {backlog} saved note{backlog === 1 ? '' : 's'} can now be enriched with your current AI settings.
                    </>
                  )}
                </span>
                <span className="backlog-actions">
                  <Button tone="solid" onClick={enrichNow} disabled={enriching}>
                    {enriching ? 'Starting…' : 'Enrich now'}
                  </Button>
                  <Button onClick={() => setBacklog(null)} disabled={enriching}>
                    Later
                  </Button>
                </span>
              </div>
            )}
            {roles.map(role =>
              isRemote(role) ? (
                <div key={role} className="role-acc open">
                  <div className="role-acc-head">
                    <span className="role-acc-info">
                      <span className="role-acc-title">{ROLE_META[role].title}</span>
                      <span className="role-acc-sub">{ROLE_META[role].sub}</span>
                    </span>
                    <span className="role-acc-current">{cfg.remote[role] || '—'}</span>
                  </div>
                  <div className="model-list">
                    <RemoteModelField
                      role={role}
                      value={cfg.remote[role]}
                      options={cfg.presets[role]}
                      busy={busyRole === role}
                      onCommit={v => pickRemote(role, v)}
                    />
                  </div>
                </div>
              ) : (
                <RoleAccordion
                  key={role}
                  role={role}
                  presets={cfg.presets[role]}
                  currentKey={cfg.current[role]}
                  policy={cfg.residency[role]}
                  onPolicy={p => pickPolicy(role, p)}
                  busy={busyRole !== null || switching}
                  switching={switching && pendingRole === role}
                  pct={modelLoad.pct || 0}
                  defaultOpen={switching && pendingRole === role}
                  onPick={key => pick(role, key)}
                />
              ),
            )}
          </SettingsGroup>

          {/* Only where weights exist: a remote-inference install downloads
                nothing, and the routes behind this row 404 there. */}
          {cfg.capabilities.downloadsWeights && (
            <SettingsGroup label="Storage">
              <div className="settings-rows">
                <ModelFilesRow />
              </div>
            </SettingsGroup>
          )}

          <ImportSection />

          <TelegramSection />

          <CaptureTokenSection />

          <SettingsGroup label="Your data">
            <div className="settings-rows">
              <SettingsRow
                title="Export"
                desc={
                  <>
                    Everything you've saved — notes, spaces, chats, and settings — as one JSON file. Good for backups or
                    moving to a new install.
                  </>
                }
                action={
                  <Button asChild>
                    <a href="/api/export" download>
                      Download export
                    </a>
                  </Button>
                }
              />

              <SettingsRow
                title="Backup"
                desc={
                  <>
                    Your whole library — the database and every image — as one file, safe to download while Kothai is
                    running. Restore it below, on this install or a new one.
                  </>
                }
                action={
                  <Button asChild>
                    <a href="/api/backup" download>
                      Download backup
                    </a>
                  </Button>
                }
              />

              <BackupsRow />

              <DriveRow />

              <RestoreRow />

              <AvailabilityRow />

              <SettingsRow
                title="Re-tag everything"
                desc={
                  <>
                    Re-run the language model over every saved note, so titles, summaries and tags are rebuilt from
                    everything a note carries now. Worth doing after a big import or after switching language models.
                    Tags you've edited by hand are kept, and it runs in the background.
                  </>
                }
                action={
                  !retagArmed && (
                    <Button
                      onClick={() => {
                        setRetagArmed(true)
                        setRetagError(null)
                        setRetagQueued(null)
                      }}
                      disabled={retagging}
                    >
                      Re-tag all notes…
                    </Button>
                  )
                }
              >
                {retagArmed && (
                  <div className="settings-row-extra">
                    {/* Neutral, not danger: it rebuilds derived metadata rather
                        than destroying anything. */}
                    <Confirm
                      question={
                        <>
                          Re-tag{' '}
                          {noteCount === null ? (
                            'every saved note'
                          ) : (
                            <>
                              all <b>{noteCount}</b> note{noteCount === 1 ? '' : 's'}
                            </>
                          )}
                          ? It can't be stopped once it starts.
                        </>
                      }
                      confirmLabel="Yes, re-tag everything"
                      busyLabel="Starting…"
                      busy={retagging}
                      onConfirm={retagAll}
                      onCancel={() => setRetagArmed(false)}
                    />
                  </div>
                )}
                {retagQueued !== null && (
                  <RowStatus>
                    Queued {retagQueued} note{retagQueued === 1 ? '' : 's'}. They'll re-tag in the background — you can
                    keep using the app.
                  </RowStatus>
                )}
                {retagError && <RowStatus tone="error">{retagError}</RowStatus>}
              </SettingsRow>

              <SettingsRow
                danger
                title="Erase all data"
                desc={
                  <>
                    Erase everything you've saved — notes, spaces, chats, tags, and uploaded images. Your models and
                    settings stay as they are. <b>This cannot be undone</b>, so download an export first if there's any
                    doubt.
                  </>
                }
                action={
                  !wipeArmed && (
                    <Button
                      danger
                      onClick={() => {
                        setWipeArmed(true)
                        setWipeError(null)
                        setWipeResult(null)
                      }}
                    >
                      Erase all data…
                    </Button>
                  )
                }
              >
                {wipeArmed && (
                  <div className="settings-row-extra">
                    <Confirm
                      danger
                      guard={WIPE_TOKEN}
                      question={
                        <>
                          Type <b>{WIPE_TOKEN}</b> to confirm.
                        </>
                      }
                      confirmLabel="Erase everything"
                      busyLabel="Erasing…"
                      busy={wiping}
                      onConfirm={wipeAll}
                      onCancel={() => setWipeArmed(false)}
                    />
                  </div>
                )}
                {wipeResult && <RowStatus>{summarizeWipe(wipeResult)}</RowStatus>}
                {wipeError && <RowStatus tone="error">{wipeError}</RowStatus>}
              </SettingsRow>
            </div>
          </SettingsGroup>
        </div>
      )}

      {/* Phone-only, and hidden above --bp-md by settings.css: this
          exists because the phone tab bar has no room for a theme
          switch and the topbar it used to sit in was given back to
          content. The desktop rail still carries its own button, so
          showing this there would be two controls for one setting.
          Outside the demo branch above: inside it, a demo visitor on a
          phone had no theme switch anywhere, and the theme is this
          device's alone, so the demo has no reason to refuse it. */}
      <SettingsGroup label="Appearance" className="settings-appearance">
        <div className="settings-rows">
          <SettingsRow
            title="Theme"
            desc={
              <>
                Light or dark. Remembered on this device, not in your vault, so each device you open Kothai on keeps its
                own.
              </>
            }
            action={
              <Segmented
                label="Theme"
                value={theme}
                onChange={setTheme}
                options={[
                  { value: 'light', label: 'Light' },
                  { value: 'dark', label: 'Dark' },
                ]}
              />
            }
          />
        </div>
      </SettingsGroup>
    </div>
  )
}
