// Playground.tsx — every primitive in client/ui/, in each of its states, on
// one page: the reference to look at (and screenshot) when composition is the
// question, which no check in this repo can answer. main.tsx serves it at /ui
// in development only; the production build strips it. The layout here is
// inline token styles so it adds nothing to the app's stylesheet, and
// test/client/playground.test.ts fails if a primitive is missing from it.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { applyTheme } from '../app/theme'
import { Icon } from '../components/icons'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { Confirm } from '../ui/Confirm'
import { Dialog } from '../ui/Dialog'
import { Input, Textarea } from '../ui/Input'
import { Menu } from '../ui/Menu'
import { PageHeader } from '../ui/PageHeader'
import { Popover } from '../ui/Popover'
import { Segmented } from '../ui/Segmented'
import { Tooltip } from '../ui/Tooltip'

const row: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-12)' }
const stack: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 'var(--space-14)' }

function Section({ name, children }: { name: string; children: ReactNode }) {
  return (
    <section style={stack}>
      <div className="eyebrow">{name}</div>
      {children}
    </section>
  )
}

export function Playground() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [view, setView] = useState<'grid4' | 'grid6' | 'grid8'>('grid4')
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest')
  const [filter, setFilter] = useState(true)
  const [spaces, setSpaces] = useState<string[]>(['Reading'])
  const [comboOpen, setComboOpen] = useState(false)
  const [dialog, setDialog] = useState(false)
  const [armed, setArmed] = useState(false)
  const [confirms, setConfirms] = useState(false)
  const dialogField = useRef<HTMLInputElement>(null)

  // The app keeps the theme in localStorage; this page flips it on the root
  // only, so looking at the other theme here never changes the user's choice.
  useEffect(() => {
    applyTheme(document, theme)
  }, [theme])

  const toggle = (s: string) => setSpaces(v => (v.includes(s) ? v.filter(x => x !== s) : [...v, s]))

  return (
    <div style={{ height: '100%', overflowY: 'auto' }}>
      <PageHeader
        lead={<Icon name="spark" size={13} />}
        title="Primitives"
        meta="client/ui"
        actions={
          <Segmented
            label="Theme"
            value={theme}
            onChange={setTheme}
            options={[
              { value: 'dark', label: 'Dark' },
              { value: 'light', label: 'Light' },
            ]}
          />
        }
        filters={
          <div style={row}>
            <Chip on={filter} onClick={() => setFilter(f => !f)}>
              Filter
            </Chip>
            <Chip removable>Removable</Chip>
            <Chip add>+ Add</Chip>
          </div>
        }
        display={
          <Segmented
            label="Columns"
            value={view}
            onChange={setView}
            options={[
              { value: 'grid4', label: <Icon name="grid4" size={16} />, title: '4 columns' },
              { value: 'grid6', label: <Icon name="grid6" size={16} />, title: '6 columns' },
              { value: 'grid8', label: <Icon name="grid8" size={16} />, title: '8 columns' },
            ]}
          />
        }
      />

      <div style={{ ...stack, gap: 'var(--space-28)', padding: 'var(--space-20) var(--space-28) var(--space-48)' }}>
        <Section name="Button — size × tone, danger, disabled, asChild">
          {(['default', 'solid', 'ghost'] as const).map(tone => (
            <div key={tone} style={row}>
              {(['xs', undefined, 'lg'] as const).map(size => (
                <Button key={size ?? 'sm'} size={size} tone={tone === 'default' ? undefined : tone}>
                  {tone} {size ?? 'sm'}
                </Button>
              ))}
              <Button size="icon" tone={tone === 'default' ? undefined : tone} aria-label="Icon">
                <Icon name="edit" size={14} />
              </Button>
              <Button tone={tone === 'default' ? undefined : tone} disabled>
                disabled
              </Button>
            </div>
          ))}
          <div style={row}>
            <Button danger>danger</Button>
            <Button danger tone="solid">
              danger solid
            </Button>
            <Button asChild>
              <a href="#ui">asChild link</a>
            </Button>
          </div>
        </Section>

        <Section name="Chip — on, compact, add, removable">
          <div style={row}>
            <Chip on>On</Chip>
            <Chip>Off</Chip>
            <Chip add>+ rule tag</Chip>
            <Chip removable>madinah</Chip>
          </div>
          <div style={row}>
            <Chip compact add>
              + Add tag
            </Chip>
            <Chip compact removable>
              travel
            </Chip>
          </div>
        </Section>

        <Section name="Segmented — text, disabled">
          <div style={row}>
            <Segmented
              label="Sort"
              value={sort}
              onChange={setSort}
              options={[
                { value: 'newest', label: 'Newest' },
                { value: 'oldest', label: 'Oldest' },
              ]}
            />
            <Segmented
              label="Disabled"
              value="a"
              onChange={() => {}}
              disabled
              options={[
                { value: 'a', label: 'Off' },
                { value: 'b', label: 'On demand' },
                { value: 'c', label: 'Always on' },
              ]}
            />
          </div>
        </Section>

        <Section name="Input / Textarea — default, compact, danger, disabled">
          <div style={{ ...stack, maxWidth: '60ch' }}>
            <Input placeholder="Default field" />
            <Input compact className="mono" placeholder="compact mono — model ids" />
            <Input danger placeholder="danger — focus me" />
            <Input disabled placeholder="disabled" />
            <Textarea placeholder="Textarea" />
          </div>
        </Section>

        <Section name="Menu — checkable and plain">
          <div style={row}>
            <Menu
              title="Add to space"
              empty="No spaces yet"
              trigger={<Button>Checkable menu</Button>}
              items={['Reading', 'Recipes', 'Travel'].map(s => ({
                key: s,
                label: s,
                checked: spaces.includes(s),
                onSelect: () => toggle(s),
              }))}
            />
            <Menu
              empty="In every space"
              trigger={<Button>Plain menu</Button>}
              items={['Reading', 'Recipes'].map(s => ({
                key: s,
                label: s,
                trailing: <Icon name="spark" size={11} />,
                onSelect: () => {},
              }))}
            />
            <Menu empty="No spaces yet" trigger={<Button>Empty menu</Button>} items={[]} />
          </div>
        </Section>

        <Section name="Popover — trigger (modal) and anchor (combobox)">
          <div style={{ ...row, alignItems: 'flex-start' }}>
            <Popover label="Add rule tag" trigger={<Chip add>+ rule tag</Chip>}>
              <p className="eyebrow">Filter</p>
              <Input compact placeholder="filter or add a tag…" />
            </Popover>
            <div style={{ flex: 1, maxWidth: '60ch' }}>
              <Popover
                open={comboOpen}
                onOpenChange={setComboOpen}
                anchor={
                  <div style={row}>
                    <Input
                      compact
                      style={{ flex: 1 }}
                      placeholder="anchored — focus stays here"
                      onFocus={() => setComboOpen(true)}
                    />
                  </div>
                }
              >
                <div className="menu-item">qwen2.5-7b-instruct</div>
                <div className="menu-item">llama-3.1-8b-instruct</div>
              </Popover>
            </div>
          </div>
        </Section>

        <Section name="Tooltip — label, label with detail">
          <div style={row}>
            {(['top', 'right', 'bottom', 'left'] as const).map(side => (
              <Tooltip key={side} label={`Tip ${side}`} side={side}>
                <Button size="icon" tone="ghost" aria-label={`Tip ${side}`}>
                  <Icon name="copy" size={16} />
                </Button>
              </Tooltip>
            ))}
            <Tooltip
              label="Smart space"
              detail="Any item tagged with a rule below joins this space automatically."
              side="bottom"
            >
              <Button size="icon" tone="ghost" aria-label="Smart space">
                <Icon name="spark" size={13} />
              </Button>
            </Tooltip>
          </div>
        </Section>

        <Section name="Dialog">
          <div style={row}>
            <Button onClick={() => setDialog(true)}>Open dialog</Button>
          </div>
          {dialog && (
            <Dialog
              title="Playground dialog"
              initialFocus={dialogField}
              onClose={() => setDialog(false)}
              overlayClassName="cap-overlay"
              className="cap-modal"
            >
              <div className="confirm" style={{ ...stack, width: '100%' }}>
                <Input ref={dialogField} placeholder="initialFocus lands here" />
                <div style={row}>
                  <Button tone="solid" onClick={() => setDialog(false)}>
                    Done
                  </Button>
                </div>
              </div>
            </Dialog>
          )}
        </Section>

        <Section name="Confirm — boxed, danger, guard, inline, compact">
          <div style={{ ...stack, maxWidth: '60ch' }}>
            {/* Behind a button, as in the app: each takes focus when it appears,
                so mounted at load they would pull the page down to the last. */}
            {confirms ? (
              <>
                <Confirm
                  question="Re-tag every note?"
                  confirmLabel="Yes, re-tag"
                  onConfirm={() => setConfirms(false)}
                  onCancel={() => setConfirms(false)}
                />
                <Confirm
                  danger
                  guard="DELETE"
                  question={
                    <>
                      Type <b>DELETE</b> to confirm.
                    </>
                  }
                  confirmLabel="Erase everything"
                  onConfirm={() => setConfirms(false)}
                  onCancel={() => setConfirms(false)}
                />
              </>
            ) : (
              <div style={row}>
                <Button onClick={() => setConfirms(true)}>Arm the boxed confirms</Button>
              </div>
            )}
            <div style={row}>
              {armed ? (
                <Confirm
                  inline
                  danger
                  confirmLabel="Delete space"
                  onConfirm={() => setArmed(false)}
                  onCancel={() => setArmed(false)}
                />
              ) : (
                <Button size="icon" tone="ghost" aria-label="Arm" onClick={() => setArmed(true)}>
                  <Icon name="trash" size={16} />
                </Button>
              )}
            </div>
            {confirms && (
              <Confirm
                inline
                compact
                danger
                question="Delete “A long chat title that runs out of room”?"
                confirmLabel="Delete"
                onConfirm={() => setConfirms(false)}
                onCancel={() => setConfirms(false)}
              />
            )}
          </div>
        </Section>

        <Section name="Eyebrow">
          <div className="eyebrow">Chat history</div>
        </Section>
      </div>
    </div>
  )
}
