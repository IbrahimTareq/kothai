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
//
// Embeddings and images can each have an endpoint of their own: Claude serves
// no embeddings, so connecting it needs a second service for search by meaning.
import { useState } from 'react'
import { RoleAccordion, fmtGB, type Role } from './ModelPicker'
import { SettingsGroup } from './SettingsRow'
import { EndpointPicker, type EndpointChoice } from './EndpointPicker'
import { API } from '../../data/api'
import type { SettingsResponse } from '../../types'
import { Button } from '../../ui/Button'
import { Menu } from '../../ui/Menu'

const ROLES = ['llm', 'embed', 'vision'] as const

// The shared endpoint, or one role's own.
type Target = 'shared' | 'embed' | 'vision'
const PER_ROLE = {
  embed: { what: 'Embeddings', use: 'Use a different endpoint for embeddings' },
  vision: { what: 'Images', use: 'Use a different endpoint for images' },
} as const

export function ConnectionPanel({
  cfg,
  onChanged,
}: {
  cfg: SettingsResponse
  /** Both paths rewrite roles, models and capabilities, so the view is handed
   *  the server's whole new answer rather than a patch to merge. */
  onChanged: (next: SettingsResponse) => void
}) {
  // Collapsed until asked for, because most people set this once and never
  // look at it again.
  const [target, setTarget] = useState<Target | null>(null)
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
  const leaveBytes =
    cfg.localPresets && leaveSel
      ? ROLES.reduce(
          (sum, role) => sum + (cfg.localPresets![role].find(p => p.key === leaveSel[role])?.sizeBytes || 0),
          0,
        )
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
      setTarget(null)
      setLeaving(false)
      setLeaveSel(null)
      setChoice(null)
    } catch (e) {
      setErr((e as Error).message || whenItFails)
    }
    setBusy(false)
  }

  const saveEndpoint = () =>
    choice &&
    target &&
    commit(async () => {
      await API.checkEndpoint(choice.providerId, choice.baseUrl, choice.apiKey)
      const ep = { providerId: choice.providerId, baseUrl: choice.baseUrl, apiKey: choice.apiKey }
      // A role's own endpoint names only that role's model.
      if (target === 'shared') await API.saveEndpoint(ep, choice.defaults)
      else await API.saveEndpoint(ep, { [target]: choice.defaults[target] }, target)
    }, 'Could not save that endpoint.')

  const disconnect = () =>
    commit(() => API.clearEndpoint(leaveSel ? { models: leaveSel } : {}), 'Could not disconnect.')

  const host = cfg.endpoint.configured ? cfg.endpoint.host : ''
  const ownRoles = (['embed', 'vision'] as const).filter(r => !cfg.endpoints[r].inherited)
  const roleItems = (['embed', 'vision'] as const).flatMap(role => {
    const open = () => {
      setTarget(role)
      setErr(null)
    }
    if (!ownRoles.includes(role)) return [{ key: role, label: PER_ROLE[role].use, onSelect: open }]
    return [
      { key: role, label: `Change the endpoint for ${PER_ROLE[role].what.toLowerCase()}`, onSelect: open },
      {
        key: `${role}-shared`,
        label: `Use ${host || 'the main endpoint'} for ${PER_ROLE[role].what.toLowerCase()}`,
        onSelect: () => commit(() => API.clearEndpoint({ role }), 'Could not change that.'),
      },
    ]
  })
  // The tile picked for embeddings has to serve them.
  const offered = target === 'embed' ? cfg.catalogue.filter(e => e.servesEmbeddings) : cfg.catalogue
  const picked = choice && cfg.catalogue.find(e => e.id === choice.providerId)

  return (
    <SettingsGroup label="Connection">
      <div className="conn">
        <div className="conn-state">
          {/* One element, two kinds of content — which is how a plain English
              sentence ended up set in Geist Mono at 14px, the loudest of the
              mismatches this surface had. A hostname is machine text and keeps
              the mono face; the sentence is prose and takes the title role. */}
          <span className={`conn-where${host ? ' mono' : ''}`}>
            {cfg.endpoint.configured ? host || 'a remote endpoint' : 'Models run on this machine'}
          </span>
          <span className="conn-sub">
            {cfg.endpoint.configured
              ? 'Your key is stored on this machine only, and never appears in a backup or an export.'
              : cfg.localSupported
                ? 'Nothing leaves the box. Connect a service to stop hosting models yourself.'
                : 'This is the lite image, which runs no models itself — it needs a service.'}
          </span>
          {ownRoles.map(role => (
            <span key={role} className="conn-sub">
              {PER_ROLE[role].what} use <span className="mono">{cfg.endpoints[role].host || 'their own endpoint'}</span>
              .
            </span>
          ))}
        </div>
        {!target && !leaving && (
          <div className="conn-actions">
            <Button
              onClick={() => {
                setTarget('shared')
                setErr(null)
              }}
            >
              {cfg.endpoint.configured ? 'Change' : 'Connect a service'}
            </Button>
            {cfg.endpoint.configured && (
              <Menu trigger={<Button disabled={busy}>Per role</Button>} empty="" items={roleItems} />
            )}
            {cfg.endpoint.configured && cfg.localSupported && (
              <Button
                disabled={busy}
                onClick={() => {
                  setLeaving(true)
                  setLeaveSel({ ...cfg.current })
                  setErr(null)
                }}
              >
                Disconnect
              </Button>
            )}
          </div>
        )}
      </div>

      {leaving && cfg.localPresets && leaveSel && (
        <div className="conn-edit">
          <p className="conn-warn">
            These will run on this machine instead. Nothing is sent anywhere, and there is no key or bill — but the
            weights have to be downloaded the first time each one is used.
          </p>
          {ROLES.map(role => (
            <RoleAccordion
              key={role}
              role={role}
              presets={cfg.localPresets![role]}
              currentKey={leaveSel[role]}
              busy={busy}
              switching={false}
              pct={0}
              defaultOpen={false}
              onPick={key => setLeaveSel(sel => (sel ? { ...sel, [role]: key } : sel))}
            />
          ))}
          <div className="conn-actions">
            <Button tone="solid" disabled={busy} onClick={disconnect}>
              {busy ? 'Switching…' : `Switch — up to ${fmtGB(leaveBytes)} to download`}
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setLeaving(false)
                setLeaveSel(null)
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {err && <div className="conn-err">{err}</div>}

      {target && (
        <div className="conn-edit">
          {target !== 'shared' && (
            <p className="conn-warn">
              Only {PER_ROLE[target].what.toLowerCase()} will use this service. Everything else stays on{' '}
              {host || 'the main endpoint'}.
            </p>
          )}
          <EndpointPicker
            endpoints={offered}
            keyPlaceholder={cfg.endpoint.configured ? 'paste a new key' : 'paste it here'}
            onChange={setChoice}
          />
          {/* Only when the change would move the embedding role: the
              whole library is re-embedded in the background, and a
              warning on every endpoint edit would be noise. A role that
              borrows the shared endpoint moves with it. */}
          {choice &&
            Boolean(choice.defaults.embed) &&
            (target === 'embed' || (target === 'shared' && cfg.endpoints.embed.inherited)) && (
              <p className="conn-warn">
                This service serves embeddings, so search moves to it and every note is re-indexed in the background.
                Search keeps working while that runs.
              </p>
            )}
          {/* Claude as the shared endpoint takes embeddings with it unless they
              have their own, and it serves none. */}
          {target === 'shared' && picked && !picked.servesEmbeddings && cfg.endpoints.embed.inherited && (
            <p className="conn-warn">
              {picked.label} makes no embeddings. Afterwards, choose Per role, then a different endpoint for embeddings,
              or search by meaning stops working.
            </p>
          )}
          <div className="conn-actions">
            <Button tone="solid" disabled={!choice || busy} onClick={saveEndpoint}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setTarget(null)
                setChoice(null)
                setErr(null)
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </SettingsGroup>
  )
}
