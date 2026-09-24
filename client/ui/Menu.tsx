import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import type { ReactElement, ReactNode, SyntheticEvent } from 'react'

// A list of actions opened from a trigger. Items are data, not children: the
// three hand-built pickers this replaced each drew their own row (two radii,
// two hover fills, one of them dimmed) because a row was whatever the caller
// wrote. Radix owns focus, arrow keys, typeahead, Escape and outside clicks,
// which each picker also re-implemented, one with a backdrop div.
//
// A checkable item stays open when picked, so several can be toggled in a row;
// a plain item closes the menu, since its job is done.
type Item = {
  key: string
  label: string
  trailing?: ReactNode
  checked?: boolean
  onSelect: () => void
}

// React bubbles events out of a portal through the component tree, not the
// DOM. An ItemCard hosts one of these, and without this a click or Enter on
// an item also reached the card's own handlers and opened the expanded view.
const contain = (e: SyntheticEvent) => e.stopPropagation()

export function Menu({
  trigger,
  title,
  items,
  empty,
}: {
  trigger: ReactElement
  title?: string
  items: Item[]
  empty: string
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="menu"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          onClick={contain}
          onKeyDown={contain}
        >
          {title && <DropdownMenu.Label className="menu-title eyebrow">{title}</DropdownMenu.Label>}
          {items.length === 0 && <div className="menu-empty">{empty}</div>}
          {items.map(it => {
            const body = (
              <>
                <span className="menu-label">{it.label}</span>
                {it.trailing && <span className="menu-trailing">{it.trailing}</span>}
              </>
            )
            return it.checked === undefined ? (
              <DropdownMenu.Item key={it.key} className="menu-item" onSelect={it.onSelect}>
                {body}
              </DropdownMenu.Item>
            ) : (
              <DropdownMenu.CheckboxItem
                key={it.key}
                className="menu-item"
                checked={it.checked}
                onSelect={e => {
                  e.preventDefault()
                  it.onSelect()
                }}
              >
                <span className="menu-check">
                  <DropdownMenu.ItemIndicator>✓</DropdownMenu.ItemIndicator>
                </span>
                {body}
              </DropdownMenu.CheckboxItem>
            )
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
