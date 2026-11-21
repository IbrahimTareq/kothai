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
import { useEffect, useState } from 'react'
import { SettingsGroup } from './SettingsRow'
import { EndpointPicker, type EndpointChoice } from './EndpointPicker'
import { API } from '../../data/api'
import type { SettingsResponse } from '../../types'
import { Button } from '../../ui/Button'
import { Confirm } from '../../ui/Confirm'
import { Menu } from '../../ui/Menu'

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
  /** Both paths rewrite roles and models, so the view is handed
   *  the server's whole new answer rather than a patch to merge. */
  onChanged: (next: SettingsResponse) => void
}) {
  // Collapsed until asked for, because most people set this once and never
  // look at it again. The upgrade banner's link asks for it with #connect,
  // which is dropped once read so a later visit opens collapsed.
  const [target, setTarget] = useState<Target | null>(() => (location.hash === '#connect' ? 'shared' : null))
  useEffect(() => {
    if (location.hash === '#connect') history.replaceState(null, '', location.pathname)
  }, [])
  const [choice, setChoice] = useState<EndpointChoice | null>(null)
  // A checked shared tile that serves no embeddings, while embeddings borrow
  // the shared endpoint: held until the embeddings step answers, as in first
  // run. Saved alone, with only a warning, it left search by meaning nowhere.
  const [pending, setPending] = useState<EndpointChoice | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Disconnecting turns AI off, with no on-device models to fall back on any
  // more, so it asks first.
  const [leaving, setLeaving] = useState(false)

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
      setPending(null)
      setLeaving(false)
      setChoice(null)
    } catch (e) {
      setErr((e as Error).message || whenItFails)
    }
    setBusy(false)
  }

  const endpointOf = (c: EndpointChoice) => ({ providerId: c.providerId, baseUrl: c.baseUrl, apiKey: c.apiKey })
  const picked = choice && cfg.catalogue.find(e => e.id === choice.providerId)

  // `c` is the picker's choice; null only from the embeddings step's skip.
  const saveEndpoint = async (c: EndpointChoice | null) => {
    if (!target || busy) return
    if (pending) {
      return commit(async () => {
        const embed = c && { ...c, baseUrl: await API.checkEndpoint(c.providerId, c.baseUrl, c.apiKey) }
        await API.saveEndpoint(endpointOf(pending), pending.defaults)
        if (embed) await API.saveEndpoint(endpointOf(embed), { embed: embed.defaults.embed }, 'embed')
      }, 'Could not save that endpoint.')
    }
    if (!c) return
    if (target === 'shared' && picked && !picked.servesEmbeddings && cfg.endpoints.embed.inherited) {
      setBusy(true)
      setErr(null)
      try {
        setPending({ ...c, baseUrl: await API.checkEndpoint(c.providerId, c.baseUrl, c.apiKey) })
        setChoice(null)
      } catch (e) {
        setErr((e as Error).message || 'Could not reach that service.')
      }
      return setBusy(false)
    }
    commit(async () => {
      const checked = { ...c, baseUrl: await API.checkEndpoint(c.providerId, c.baseUrl, c.apiKey) }
      // A role's own endpoint names only that role's model.
      if (target === 'shared') await API.saveEndpoint(endpointOf(checked), c.defaults)
      else await API.saveEndpoint(endpointOf(checked), { [target]: c.defaults[target] }, target)
    }, 'Could not save that endpoint.')
  }

  const disconnect = () => commit(() => API.clearEndpoint(), 'Could not disconnect.')

  const host = cfg.endpoint.configured ? cfg.endpoint.host : ''
  const ownRoles = (['embed', 'vision'] as const).filter(r => !cfg.endpoints[r].inherited)
  // Claude for everything else: "use it for embeddings" would turn them off.
  const chatOnly = cfg.catalogue.find(e => e.id === cfg.endpoint.providerId)?.servesEmbeddings === false
  const roleItems = (['embed', 'vision'] as const).flatMap(role => {
    const open = () => {
      setTarget(role)
      setErr(null)
    }
    if (!ownRoles.includes(role)) return [{ key: role, label: PER_ROLE[role].use, onSelect: open }]
    const change = { key: role, label: `Change the endpoint for ${PER_ROLE[role].what.toLowerCase()}`, onSelect: open }
    if (role === 'embed' && chatOnly) return [change]
    return [
      change,
      {
        key: `${role}-shared`,
        label: `Use ${host || 'the main endpoint'} for ${PER_ROLE[role].what.toLowerCase()}`,
        onSelect: () => commit(() => API.clearEndpoint({ role }), 'Could not change that.'),
      },
    ]
  })
  // The tile picked for embeddings has to serve them.
  const forEmbed = target === 'embed' || Boolean(pending)
  const offered = forEmbed ? cfg.catalogue.filter(e => e.servesEmbeddings) : cfg.catalogue

  return (
    <SettingsGroup label="Connection">
      <div className="conn">
        <div className="conn-state">
          {/* One element, two kinds of content — which is how a plain English
              sentence ended up set in Geist Mono at 14px, the loudest of the
              mismatches this surface had. A hostname is machine text and keeps
              the mono face; the sentence is prose and takes the title role. */}
          <span className={`conn-where${host ? ' mono' : ''}`}>
            {cfg.endpoint.configured ? host || 'a remote endpoint' : 'No service connected'}
          </span>
          <span className="conn-sub">
            {cfg.endpoint.configured
              ? 'Your key is stored on this machine only, and never appears in a backup or an export.'
              : 'AI is off. Connect a service, or an Ollama on your own hardware, to have what you save read and filed.'}
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
            {cfg.endpoint.configured && (
              <Button
                disabled={busy}
                onClick={() => {
                  setLeaving(true)
                  setErr(null)
                }}
              >
                Disconnect
              </Button>
            )}
          </div>
        )}
      </div>

      {leaving && (
        <div className="conn-edit">
          <Confirm
            question="Disconnect? Nothing new is read, filed or searchable by meaning until you connect a service again."
            confirmLabel="Disconnect"
            busyLabel="Disconnecting…"
            busy={busy}
            onConfirm={disconnect}
            onCancel={() => setLeaving(false)}
          />
        </div>
      )}

      {err && <div className="conn-err">{err}</div>}

      {target && (
        <div className="conn-edit">
          {pending && (
            <>
              <span className="conn-where">Pick a provider for search by meaning</span>
              <p className="conn-warn">
                {cfg.catalogue.find(e => e.id === pending.providerId)?.label || 'That service'} makes no embeddings,
                which finding things by meaning needs. Another service can do just that part.
              </p>
            </>
          )}
          {target !== 'shared' && (
            <p className="conn-warn">
              Only {PER_ROLE[target].what.toLowerCase()} will use this service. Everything else stays on{' '}
              {host || 'the main endpoint'}.
            </p>
          )}
          <EndpointPicker
            key={pending ? 'embed' : target}
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
            (forEmbed || (target === 'shared' && cfg.endpoints.embed.inherited)) && (
              <p className="conn-warn">
                This service serves embeddings, so search moves to it and every note is re-indexed in the background.
                Search keeps working while that runs.
              </p>
            )}
          <div className="conn-actions">
            <Button tone="solid" disabled={!choice || busy} onClick={() => saveEndpoint(choice)}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
            {pending && (
              <Button disabled={busy} onClick={() => saveEndpoint(null)}>
                Skip: keyword search only
              </Button>
            )}
            <Button
              disabled={busy}
              onClick={() => {
                setTarget(null)
                setPending(null)
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
