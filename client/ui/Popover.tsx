import * as RadixPopover from '@radix-ui/react-popover'
import { useRef } from 'react'
import type { ReactElement, ReactNode } from 'react'

// A floating panel for content that is not a list of actions — a field, a
// hint, a list you filter. For a list of actions use <Menu>.
//
// Opened by a trigger, it is modal: focus moves in, and a click outside only
// dismisses it, which is the job the old .menu-backdrop did.
//
// Attached to an anchor instead, it is a combobox's list: focus stays in the
// field so typing keeps filtering, and a press back on the field (or its
// toggle) is not "outside". The endpoint model field's list was an absolute
// ul inside its accordion, which clipped it to one row until the accordion's
// overflow was lifted, and which the next accordion painted over until the
// open one was raised — two workarounds a portal does not need.
export function Popover({
  trigger,
  anchor,
  label,
  open,
  onOpenChange,
  children,
}: {
  label?: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children: ReactNode
} & ({ trigger: ReactElement; anchor?: never } | { anchor: ReactElement; trigger?: never })) {
  const anchorRef = useRef<HTMLDivElement>(null)
  return (
    <RadixPopover.Root open={open} onOpenChange={onOpenChange} modal={!anchor}>
      {anchor ? (
        <RadixPopover.Anchor asChild ref={anchorRef}>
          {anchor}
        </RadixPopover.Anchor>
      ) : (
        <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      )}
      <RadixPopover.Portal>
        <RadixPopover.Content
          className={anchor ? 'pop pop--list' : 'pop'}
          aria-label={label}
          align="start"
          sideOffset={anchor ? 4 : 6}
          collisionPadding={8}
          onOpenAutoFocus={anchor ? e => e.preventDefault() : undefined}
          onInteractOutside={
            anchor ? e => anchorRef.current?.contains(e.target as Node) && e.preventDefault() : undefined
          }
        >
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  )
}
