// CONNECTION — where inference runs, and the two ways to change it.
//
// Lifted out of Settings.tsx, where it was the largest block in the view and
// six of that component's twenty-two useState. It reads one prop and reports
// one thing back, which is what made it worth moving: nothing else in Settings
// touches this state, and nothing here needs to know what else Settings shows.
//
// Two panels, deliberately mutually exclusive with the idle actions and with
// each other — connecting and leaving both rewrite every role, and offering
// both at once would invite starting one mid-way through the other.
import { useState } from 'react'
import { RoleAccordion, fmtGB, type Role } from './ModelPicker'
import { SettingsGroup } from './SettingsRow'
import { EndpointPicker, type EndpointChoice } from './EndpointPicker'
import { API } from '../data/api'
import type { SettingsResponse } from '../types'

const ROLES = ['llm', 'embed', 'vision'] as const

export function ConnectionPanel({ cfg, onChanged }: {
  cfg: SettingsResponse
  /** Both paths rewrite roles, models and capabilities, so the view is handed
   *  the server's whole new answer rather than a patch to merge. */
  onChanged: (next: SettingsResponse) => void
}) {
  // Collapsed until asked for, because most people set this once and never
  // look at it again.
  const [editing, setEditing] = useState(false)
  const [choice, setChoice] = useState<EndpointChoice | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Disconnecting is where the on-device models get chosen, so the confirm step
  // is a panel rather than a second click: falling back to stored defaults meant
  // the pickers were only reachable afterwards, unprompted.
  const [leaving, setLeaving] = useState(false)
  const [leaveSel, setLeaveSel] = useState<Record<Role, string> | null>(null)

  // "up to", not "exactly": a model already in the download cache costs
  // nothing, and Settings cannot see that cache while an endpoint serves every
  // role — the route that lists it is gated on the install downloading weights.
  const leaveBytes = cfg.localPresets && leaveSel
    ? ROLES.reduce((sum, role) => sum + (cfg.localPresets![role].find((p) => p.key === leaveSel[role])?.sizeBytes || 0), 0)
    : 0

  // Both writes end the same way — adopt the server's new settings and close
  // whichever panel was open — so only the call and the message differ.
  const commit = async (write: () => Promise<unknown>, whenItFails: string) => {
    if (busy) return
    setBusy(true)
    setErr(null)
    try {
      await write()
      onChanged(await API.settings())
      setEditing(false)
      setLeaving(false)
      setLeaveSel(null)
      setChoice(null)
    } catch (e) {
      setErr((e as Error).message || whenItFails)
    }
    setBusy(false)
  }

  const saveEndpoint = () => choice && commit(
    () => API.saveEndpoint(
      { providerId: choice.providerId, baseUrl: choice.baseUrl, apiKey: choice.apiKey },
      choice.defaults,
    ),
    'Could not save that endpoint.',
  )

  const disconnect = () => commit(() => API.clearEndpoint(leaveSel || undefined), 'Could not disconnect.')

  const host = cfg.endpoint.configured ? cfg.endpoint.host : ''

  return (
    <SettingsGroup label="CONNECTION">
      <div className="conn">
        <div className="conn-state">
          {/* One element, two kinds of content — which is how a plain English
              sentence ended up set in Geist Mono at 14px, the loudest of the
              mismatches this surface had. A hostname is machine text and keeps
              the mono face; the sentence is prose and takes the title role. */}
          <span className={'conn-where' + (host ? ' mono' : '')}>
            {cfg.endpoint.configured
              ? host || 'a remote endpoint'
              : 'Models run on this machine'}
          </span>
          <span className="conn-sub">
            {cfg.endpoint.configured
              ? 'Your key is stored on this machine only, and never appears in a backup or an export.'
              : cfg.localSupported
                ? 'Nothing leaves the box. Connect a service to stop hosting models yourself.'
                : 'This is the lite image, which runs no models itself — it needs a service.'}
          </span>
        </div>
        {!editing && !leaving && (
          <div className="conn-actions">
            <button className="btn btn--sm mono" onClick={() => { setEditing(true); setErr(null) }}>
              {cfg.endpoint.configured ? 'Change' : 'Connect a service'}
            </button>
            {cfg.endpoint.configured && cfg.localSupported && (
              <button className="btn btn--sm mono" disabled={busy}
                onClick={() => { setLeaving(true); setLeaveSel({ ...cfg.current }); setErr(null) }}>
                Disconnect
              </button>
            )}
          </div>
        )}
      </div>

      {leaving && cfg.localPresets && leaveSel && (
        <div className="conn-edit">
          <p className="conn-warn">
            These will run on this machine instead. Nothing is sent anywhere, and there is no key
            or bill — but the weights have to be downloaded the first time each one is used.
          </p>
          {ROLES.map((role) => (
            <RoleAccordion key={role} role={role}
              presets={cfg.localPresets![role]}
              currentKey={leaveSel[role]}
              busy={busy}
              switching={false}
              pct={0}
              defaultOpen={false}
              onPick={(key) => setLeaveSel((sel) => (sel ? { ...sel, [role]: key } : sel))} />
          ))}
          <div className="conn-actions">
            <button className="btn btn--sm btn--primary mono" disabled={busy} onClick={disconnect}>
              {busy ? 'Switching…' : `Switch — up to ${fmtGB(leaveBytes)} to download`}
            </button>
            <button className="btn btn--sm mono" disabled={busy}
              onClick={() => { setLeaving(false); setLeaveSel(null) }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {err && <div className="conn-err mono">{err}</div>}

      {editing && (
        <div className="conn-edit">
          <EndpointPicker
            endpoints={cfg.endpoints}
            keyPlaceholder={cfg.endpoint.configured ? 'paste a new key' : 'paste it here'}
            onChange={setChoice}
          />
          {/* Only when the change would move the embedding role: the
              whole library is re-embedded in the background, and a
              warning on every endpoint edit would be noise. */}
          {choice && cfg.capabilities.roles.embed === 'local'
            && Boolean(choice.defaults.embed) && (
            <p className="conn-warn">
              This service serves embeddings, so search moves to it and every note is re-indexed
              in the background. Search keeps working while that runs.
            </p>
          )}
          <div className="conn-actions">
            <button className="btn btn--sm btn--solid mono" disabled={!choice || busy} onClick={saveEndpoint}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button className="btn btn--sm mono" disabled={busy}
              onClick={() => { setEditing(false); setChoice(null); setErr(null) }}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </SettingsGroup>
  )
}
