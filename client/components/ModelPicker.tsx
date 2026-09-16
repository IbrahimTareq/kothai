// ModelPicker.tsx — shared model-selection primitives used by both the Settings
// tab (hot-swap an already-running model) and the first-run Onboarding flow
// (pick models before the initial download). A role is a collapsible accordion
// of presets; each preset is a radio-style row showing its label, blurb, and size.
import { useState, useEffect, useRef } from 'react'
import { Icon } from './icons'
import type { ModelPreset, Residency } from '../types'
import { relevantModels } from '../domain/modelRelevance'

export type Role = 'llm' | 'embed' | 'vision'

export function fmtGB(bytes: number): string {
  return bytes ? `${(bytes / 1e9).toFixed(1)} GB` : ''
}

export const ROLE_META: Record<Role, { title: string; sub: string }> = {
  llm: { title: 'LANGUAGE', sub: 'Classifies what you save and answers your questions.' },
  embed: { title: 'EMBEDDING', sub: 'Powers semantic search. Switching re-indexes every note in the background.' },
  vision: { title: 'VISION', sub: 'Describes images so they become searchable. Loads only when needed.' },
}

// A role-shaped example beats a generic one: the placeholder is the only hint
// on the screen about what an id for THIS role looks like.
const ROLE_PLACEHOLDER: Record<Role, string> = {
  llm: 'e.g. gpt-4o-mini',
  embed: 'e.g. text-embedding-3-small',
  vision: 'e.g. gpt-4o-mini',
}

// Human copy for the three residency policies, in display order.
export const POLICY_META: { key: Residency; label: string; desc: string }[] = [
  { key: 'off', label: 'Off', desc: 'No download, no RAM. Features that need this model are disabled.' },
  {
    key: 'ondemand',
    label: 'On demand',
    desc: 'Loads when needed, frees its RAM after a few idle minutes. First use after idle takes a moment.',
  },
  { key: 'always', label: 'Always on', desc: 'Fastest responses — stays in RAM the whole time the app runs.' },
]

// Segmented Off / On demand / Always control + a one-line tradeoff blurb.
export function ResidencyControl({
  value,
  busy,
  onPick,
}: {
  value: Residency
  busy: boolean
  onPick: (p: Residency) => void
}) {
  const current = POLICY_META.find(p => p.key === value)
  return (
    <div className="residency">
      <div className="residency-seg" role="radiogroup">
        {POLICY_META.map(p => (
          <button
            key={p.key}
            className={`residency-btn mono${value === p.key ? ' active' : ''}`}
            disabled={busy}
            onClick={() => onPick(p.key)}
          >
            {p.label}
          </button>
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
    <button className={`model-row${active ? ' active' : ''}`} disabled={busy} onClick={onPick}>
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
export function RoleAccordion({
  role,
  presets,
  currentKey,
  busy,
  switching,
  pct,
  defaultOpen,
  onPick,
  policy,
  onPolicy,
}: RoleAccordionProps) {
  const [open, setOpen] = useState(!!defaultOpen)
  const current = presets.find(p => p.key === currentKey)
  const meta = ROLE_META[role]
  return (
    <div className={`role-acc${open ? ' open' : ''}`}>
      <button className="role-acc-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span className="role-acc-info">
          <span className="role-acc-title mono">{meta.title}</span>
          <span className="role-acc-sub">{meta.sub}</span>
        </span>
        <span className="role-acc-current mono">
          {switching ? <span className="model-dl">↓ {pct}%</span> : policy === 'off' ? 'OFF' : current?.label || '—'}
        </span>
        <span className="role-acc-chev">
          <Icon name="chevron" size={16} />
        </span>
      </button>
      {open && (
        <div className="model-list">
          {policy && onPolicy && <ResidencyControl value={policy} busy={busy} onPick={onPolicy} />}
          {presets.map(p => (
            <ModelRow
              key={p.key}
              p={p}
              active={currentKey === p.key}
              busy={busy}
              switching={switching}
              pct={pct}
              onPick={() => onPick(p.key)}
            />
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
  const [open, setOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [active, setActive] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => setDraft(value), [value])

  // Close on an outside click. Without this the list survives a click on the
  // next field and two can be open at once.
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])

  const ids = options.map(o => o.key)
  const { matched, rest } = relevantModels(role, ids)
  const pool = showAll ? [...matched, ...rest] : matched
  // Typing filters; an exact match should not collapse the list to one row the
  // user then cannot escape, so a draft equal to the value shows everything.
  const q = draft.trim().toLowerCase()
  const shown = q && q !== value.toLowerCase() ? pool.filter(id => id.toLowerCase().includes(q)) : pool

  const commit = (id: string) => {
    setDraft(id)
    setOpen(false)
    if (id !== value) onCommit(id)
  }

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) return setOpen(true)
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive(i => (shown.length ? (i + step + shown.length) % shown.length : 0))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (open && shown[active]) return commit(shown[active])
      return commit(draft.trim())
    }
    if (e.key === 'Escape' && open) {
      e.preventDefault()
      setOpen(false)
      setDraft(value)
    }
  }

  return (
    <div className="remote-model" ref={box}>
      <div className="remote-model-box">
        <input
          className="remote-model-input mono"
          value={draft}
          disabled={busy}
          role="combobox"
          aria-expanded={open}
          aria-controls={`models-${role}`}
          placeholder={ROLE_PLACEHOLDER[role]}
          onChange={e => {
            setDraft(e.target.value)
            setOpen(true)
            setActive(0)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKey}
          onBlur={() => {
            if (!open && draft.trim() !== value) onCommit(draft.trim())
          }}
        />
        <button
          className="btn btn--icon remote-model-toggle"
          type="button"
          disabled={busy || !ids.length}
          aria-label={open ? 'Hide models' : 'Show models'}
          onClick={() => setOpen(o => !o)}
        >
          <Icon name="chevron" size={14} />
        </button>
      </div>

      {open && Boolean(ids.length) && (
        <ul className="remote-model-list" id={`models-${role}`} role="listbox">
          {shown.map((id, i) => (
            <li key={id}>
              <button
                type="button"
                role="option"
                aria-selected={id === value}
                className={`remote-model-opt mono${i === active ? ' active' : ''}${id === value ? ' picked' : ''}`}
                onMouseEnter={() => setActive(i)}
                // mousedown, not click: the input's blur would otherwise fire
                // first and close the list out from under the click.
                onMouseDown={e => {
                  e.preventDefault()
                  commit(id)
                }}
              >
                {id}
              </button>
            </li>
          ))}
          {!shown.length && <li className="remote-model-empty mono">No match — type the name and press Enter.</li>}
          {Boolean(rest.length) && !showAll && (
            <li>
              <button
                type="button"
                className="remote-model-more mono"
                onMouseDown={e => {
                  e.preventDefault()
                  setShowAll(true)
                }}
              >
                Show {rest.length} more this endpoint serves
              </button>
            </li>
          )}
        </ul>
      )}

      <div className="remote-model-desc">
        {!ids.length
          ? 'Endpoint did not return a model list — type the name directly.'
          : showAll
            ? `All ${ids.length} models this endpoint serves.`
            : `${matched.length} of ${ids.length} models suit this role.`}
      </div>
    </div>
  )
}
