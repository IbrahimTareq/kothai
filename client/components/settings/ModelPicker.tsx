// ModelPicker.tsx — the model-name field shared by the Settings tab and the
// first-run Onboarding flow, and the copy each role is introduced with.
import { useState, useEffect } from 'react'
import { Icon } from '../icons'
import type { ModelOption } from '../../types'
import { relevantModels } from '../../domain/modelRelevance'
import { Button } from '../../ui/Button'
import { Input } from '../../ui/Input'
import { Popover } from '../../ui/Popover'

export type Role = 'llm' | 'embed' | 'vision'

export const ROLE_META: Record<Role, { title: string; sub: string }> = {
  llm: { title: 'Language', sub: 'Classifies what you save and answers your questions.' },
  embed: { title: 'Embedding', sub: 'Powers semantic search. Switching re-indexes every note in the background.' },
  vision: { title: 'Vision', sub: 'Describes images so they become searchable.' },
}

// A role-shaped example beats a generic one: the placeholder is the only hint
// on the screen about what an id for THIS role looks like.
const ROLE_PLACEHOLDER: Record<Role, string> = {
  llm: 'e.g. gpt-4o-mini',
  embed: 'e.g. text-embedding-3-small',
  vision: 'e.g. gpt-4.1-mini',
}

// Model names are endpoint-defined ids, not a curated catalogue, so this is a
// free-text field with the endpoint's list as suggestions rather than a radio
// group.
export function RemoteModelField({
  role,
  value,
  options,
  busy,
  envSet,
  onCommit,
}: {
  role: Role
  value: string
  options: ModelOption[]
  busy: boolean
  // KOTHAI_AI_<ROLE>_MODEL wins over a saved name (remote-singleton.ts's
  // withEnvModels), so an editable field would take a name nothing uses.
  envSet?: boolean
  onCommit: (v: string) => void
}) {
  const [draft, setDraft] = useState(value)
  const [open, setOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [active, setActive] = useState(0)
  useEffect(() => setDraft(value), [value])

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
    // Not gated on `open`: <Popover> sees Escape first (a capture listener on
    // document) and closes the list, and React re-renders before the key
    // reaches this field — so a check for an open list found it already shut
    // and left the half-typed draft in place, to be committed on blur.
    if (e.key === 'Escape') {
      setOpen(false)
      setDraft(value)
    }
  }

  if (envSet) {
    return (
      <div className="remote-model">
        <Input
          compact
          readOnly
          className="remote-model-input mono"
          aria-label={`${role} model`}
          value={`Set by KOTHAI_AI_${role.toUpperCase()}_MODEL`}
        />
      </div>
    )
  }

  return (
    <div className="remote-model">
      {/* An outside press closes the list (<Popover> owns that now): without
          it the list survived a click on the next field, and two were open. */}
      <Popover
        open={open && Boolean(ids.length)}
        onOpenChange={setOpen}
        anchor={
          <div className="remote-model-box">
            <Input
              compact
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
            <Button
              size="icon"
              className="remote-model-toggle"
              type="button"
              disabled={busy || !ids.length}
              aria-label={open ? 'Hide models' : 'Show models'}
              onClick={() => setOpen(o => !o)}
            >
              <Icon name="chevron" size={14} />
            </Button>
          </div>
        }
      >
        <ul className="remote-model-list" id={`models-${role}`} role="listbox">
          {shown.map((id, i) => (
            <li key={id}>
              <button
                type="button"
                role="option"
                aria-selected={id === value}
                className={`menu-item remote-model-opt mono${i === active ? ' active' : ''}${id === value ? ' picked' : ''}`}
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
          {!shown.length && <li className="remote-model-empty">No match — type the name and press Enter.</li>}
          {Boolean(rest.length) && !showAll && (
            <li>
              <button
                type="button"
                className="remote-model-more"
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
      </Popover>

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
