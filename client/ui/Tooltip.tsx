import * as RadixTooltip from '@radix-ui/react-tooltip'
import type { ReactElement } from 'react'

// A name for something that shows only a glyph. Three were hand-rolled — the
// rail's labels, Expanded's action labels and a smart space's spark — each an
// absolutely positioned span inside its trigger, so one sat under a later row
// and none answered to a keyboard. Radix portals the tip, opens it on hover
// and focus, and closes it on Escape.
//
// It is never the accessible name: the trigger carries its own aria-label, as
// the rail's buttons must on a phone, where they are tabs and no tip shows.
//
// label is a short name. detail adds a sentence under it, for the one tip
// that explains rather than names.
export function Tooltip({
  label,
  detail,
  side = 'top',
  children,
}: {
  label: string
  detail?: string
  side?: 'top' | 'right' | 'bottom' | 'left'
  children: ReactElement
}) {
  return (
    // No delay: the hand-rolled tips showed on hover at once, and a rail you
    // sweep along should name each stop as you pass it.
    <RadixTooltip.Provider delayDuration={0}>
      <RadixTooltip.Root>
        <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content
            className={detail ? 'tip tip--detail' : 'tip'}
            side={side}
            sideOffset={8}
            collisionPadding={8}
          >
            {detail ? (
              <>
                <b>{label}</b>
                {detail}
              </>
            ) : (
              label
            )}
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  )
}
