import * as RadixPopover from '@radix-ui/react-popover'
import type { ReactElement, ReactNode } from 'react'

// A floating panel for content that is not a list of actions — a field, a
// hint, a list you filter. For a list of actions use <Menu>. Modal, so a click
// outside only dismisses it, which is the job the old .menu-backdrop did.
export function Popover({
  trigger,
  label,
  open,
  onOpenChange,
  children,
}: {
  trigger: ReactElement
  label: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children: ReactNode
}) {
  return (
    <RadixPopover.Root open={open} onOpenChange={onOpenChange} modal>
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content className="pop" aria-label={label} align="start" sideOffset={6} collisionPadding={8}>
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  )
}
