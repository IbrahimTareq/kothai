// Settings.tsx — the app's settings surface. Built around two primitives so new
// settings can be dropped in as the app grows: <SettingsGroup> for a labelled
// block, and <SettingsRow> for one action inside a bordered row list (both in
// components/settings/SettingsRow.tsx, so per-section components can use them too —
// Import is one, see components/settings/ImportSection.tsx).
// Model Cores is a group: each model role (language / embedding / vision) is a
// row whose header shows the role, its purpose, and the model it is set to,
// above the field that names it. Naming applies via /api/settings. Everything
// below it — export, backup, import,
// re-tag, erase — is one row list, each row a title + explanation on the left
// and its control on the right, expanding in place when a step needs confirming.
import { useState, useEffect } from 'react'
import { RemoteModelField, ROLE_META, type Role } from '../components/settings/ModelPicker'
import { SettingsGroup, SettingsRow, RowStatus } from '../components/settings/SettingsRow'
import { ConnectionPanel } from '../components/settings/ConnectionPanel'
import { ImportSection } from '../components/settings/ImportSection'
import { TelegramSection } from '../components/settings/TelegramSection'
import { CaptureTokenSection } from '../components/settings/CaptureTokenSection'
import { DuplicatesSection } from '../components/settings/DuplicatesSection'
import { UsageSection } from '../components/settings/UsageSection'
import { RestoreRow } from '../components/settings/RestoreRow'
import { BackupsRow } from '../components/settings/BackupsRow'
import { DriveRow } from '../components/settings/DriveRow'
import { EnrichmentRow } from '../components/settings/EnrichmentRow'
import { API, apiError } from '../data/api'
import type { SettingsResponse } from '../types'
import { Button } from '../ui/Button'
import { PageHeader } from '../ui/PageHeader'
import { Segmented } from '../ui/Segmented'
import { Confirm } from '../ui/Confirm'
import { DemoSettings, useDemo } from '../components/Demo'

export function SettingsView({
  theme,
  setTheme,
}: {
  theme: 'dark' | 'light'
  setTheme: (t: 'dark' | 'light') => void
}) {
  const demo = !!useDemo()
  const [cfg, setCfg] = useState<SettingsResponse | null>(null)
  const [busyRole, setBusyRole] = useState<Role | null>(null)
  // Bumped after anything here queues enrichment, so the Enrichment row
  // re-reads at once rather than waiting for a poll it isn't running.
  const [enrichNudge, setEnrichNudge] = useState(0)
  // Note count for the re-tag confirmation, from /api/status.
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

  // Mark the role busy, move the UI before the server answers, and on failure
  // re-read the server rather than trying to undo the optimistic edit by hand.
  const pickRemote = async (role: Role, name: string) => {
    if (!cfg || busyRole || cfg.remote[role] === name) return
    // A blank name is the role off, so naming one turns it on.
    const waking = !cfg.remote[role] && Boolean(name)
    setBusyRole(role)
    setCfg(c => (c ? { ...c, remote: { ...c.remote, [role]: name } } : c))
    try {
      await API.saveSettings({ remote: { [role]: name } })
      // Only once the name actually stuck: a role now on may have notes to
      // fill, and the Enrichment row should count them straight away.
      if (waking) setEnrichNudge(n => n + 1)
    } catch {
      API.settings()
        .then(setCfg)
        .catch(() => {}) // revert to server truth
    } finally {
      setBusyRole(null)
    }
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
      // Every note is queued again; the Enrichment row picks up the run.
      setEnrichNudge(n => n + 1)
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
      // Everything on screen that came from the store is now gone; re-read so
      // the Enrichment row doesn't keep offering to enrich notes that no
      // longer exist.
      setEnrichNudge(n => n + 1)
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

  const roles = Object.keys(ROLE_META) as Role[]

  return (
    <div className="settings-view">
      <PageHeader title="Settings" />

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
            sub={`Inference runs on a remote endpoint${cfg.endpoint.host ? ` (${cfg.endpoint.host})` : ''}. The endpoint and its key were set during setup and are stored on this machine only; KOTHAI_AI_BASE_URL and KOTHAI_AI_API_KEY override them.`}
          >
            {roles.map(role => (
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
                    envSet={cfg.envModels[role]}
                    onCommit={v => pickRemote(role, v)}
                  />
                </div>
              </div>
            ))}
          </SettingsGroup>

          <ImportSection />

          <TelegramSection />

          <CaptureTokenSection />

          <DuplicatesSection />

          <UsageSection />

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

              <EnrichmentRow nudge={enrichNudge} />

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
