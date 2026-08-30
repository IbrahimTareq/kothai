// ModelPicker.tsx — shared model-selection primitives used by both the Settings
// tab (hot-swap an already-running model) and the first-run Onboarding flow
// (pick models before the initial download). A role is a collapsible accordion
// of presets; each preset is a radio-style row showing its label, blurb, and size.
import { useState, useEffect } from 'react'
import { Icon } from './icons'
import type { ModelPreset, Residency } from '../types'

export type Role = 'llm' | 'embed' | 'vision'

export function fmtGB(bytes: number): string {
  return bytes ? (bytes / 1e9).toFixed(1) + ' GB' : ''
}

export const ROLE_META: Record<Role, { title: string; sub: string }> = {
  llm: { title: 'LANGUAGE', sub: 'Classifies what you save and answers your questions.' },
  embed: { title: 'EMBEDDING', sub: 'Powers semantic search. Switching re-indexes every note in the background.' },
  vision: { title: 'VISION', sub: 'Describes images so they become searchable. Loads only when needed.' },
}

// Human copy for the three residency policies, in display order.
export const POLICY_META: { key: Residency; label: string; desc: string }[] = [
  { key: 'off', label: 'Off', desc: 'No download, no RAM. Features that need this model are disabled.' },
  { key: 'ondemand', label: 'On demand', desc: 'Loads when needed, frees its RAM after a few idle minutes. First use after idle takes a moment.' },
  { key: 'always', label: 'Always on', desc: 'Fastest responses — stays in RAM the whole time the app runs.' },
]

// Segmented Off / On demand / Always control + a one-line tradeoff blurb.
export function ResidencyControl({ value, busy, onPick }: { value: Residency; busy: boolean; onPick: (p: Residency) => void }) {
  const current = POLICY_META.find((p) => p.key === value)
  return (
    <div className="residency">
      <div className="residency-seg" role="radiogroup">
        {POLICY_META.map((p) => (
          <button key={p.key} className={'residency-btn mono' + (value === p.key ? ' active' : '')}
            disabled={busy} onClick={() => onPick(p.key)}>{p.label}</button>
        ))}
      </div>
      {current && <div className="residency-desc">{current.desc}</div>}
    </div>
  )
}

interface ModelRowProps {
  p: ModelPreset
  active: boolean
  busy: boolean
  switching: boolean
  pct: number
  onPick: () => void
}

function ModelRow({ p, active, busy, switching, pct, onPick }: ModelRowProps) {
  return (
    <button className={'model-row' + (active ? ' active' : '')} disabled={busy} onClick={onPick}>
      <span className="model-radio">{active && <span className="model-radio-dot"></span>}</span>
      <span className="model-main">
        <span className="model-name">{p.label}</span>
        <span className="model-desc">{p.desc}</span>
      </span>
      <span className="model-size mono">
        {active && switching ? <span className="model-dl">↓ {pct}%</span> : fmtGB(p.sizeBytes)}
      </span>
    </button>
  )
}

interface RoleAccordionProps {
  role: Role
  presets: ModelPreset[]
  currentKey: string
  busy: boolean
  switching: boolean
  pct: number
  defaultOpen?: boolean
  onPick: (key: string) => void
  policy?: Residency
  onPolicy?: (p: Residency) => void
}

// One collapsible model role. Collapsed, the header still communicates state by
// showing the selected model's label.
export function RoleAccordion({ role, presets, currentKey, busy, switching, pct, defaultOpen, onPick, policy, onPolicy }: RoleAccordionProps) {
  const [open, setOpen] = useState(!!defaultOpen)
  const current = presets.find((p) => p.key === currentKey)
  const meta = ROLE_META[role]
  return (
    <div className={'role-acc' + (open ? ' open' : '')}>
      <button className="role-acc-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="role-acc-info">
          <span className="role-acc-title mono">{meta.title}</span>
          <span className="role-acc-sub">{meta.sub}</span>
        </span>
        <span className="role-acc-current mono">
          {switching ? <span className="model-dl">↓ {pct}%</span> : policy === 'off' ? 'OFF' : current?.label || '—'}
        </span>
        <span className="role-acc-chev"><Icon name="chevron" size={16} /></span>
      </button>
      {open && (
        <div className="model-list">
          {policy && onPolicy && <ResidencyControl value={policy} busy={busy} onPick={onPolicy} />}
          {presets.map((p) => (
            <ModelRow key={p.key} p={p}
              active={currentKey === p.key}
              busy={busy}
              switching={switching}
              pct={pct}
              onPick={() => onPick(p.key)} />
          ))}
        </div>
      )}
    </div>
  )
}

// Remote model names are endpoint-defined ids, not a curated catalogue, so
// this is a free-text field with the endpoint's list as suggestions rather
// than a radio group. Residency and download size have no meaning here: there
// is no RAM to manage and nothing to download.
export function RemoteModelField({
  role,
  value,
  options,
  busy,
  onCommit,
}: {
  role: Role
  value: string
  options: ModelPreset[]
  busy: boolean
  onCommit: (v: string) => void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const listId = `models-${role}`
  return (
    <div className="remote-model">
      <input
        className="remote-model-input mono"
        list={listId}
        value={draft}
        disabled={busy}
        placeholder="model name, e.g. llama3.2:3b"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== value && onCommit(draft.trim())}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      />
      <datalist id={listId}>
        {options.map((o) => <option key={o.key} value={o.key} />)}
      </datalist>
      <div className="remote-model-desc">
        {options.length ? `${options.length} models offered by the endpoint.` : 'Endpoint did not return a model list — type the name directly.'}
      </div>
    </div>
  )
}
