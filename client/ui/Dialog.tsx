import * as RadixDialog from '@radix-ui/react-dialog'
import { useRef } from 'react'
import type { ComponentProps, RefObject } from 'react'

// A modal: the item view and quick capture. Both were a plain div over the
// page — no dialog role, no aria-modal, and no focus trap, so Tab walked out
// of the item view into the board behind it, and closing one left focus
// wherever the page had put it. Each also wired its own backdrop click and
// its own Escape listener. Radix holds focus inside, returns it on close,
// and dismisses on Escape or an outside press — through its layer stack, so
// Escape in a menu opened from inside closes the menu first.
//
// The content sits inside the overlay rather than beside it, so the overlay's
// own flex centring still places the panel. The dialog is named by `title`,
// read out but not shown: both surfaces already say what they are visually.
//
// It opens focused on the panel itself, not its first control — the item
// view's first tabbable thing is whatever link the media happens to hold — or
// on initialFocus. That is a prop rather than the surface's own effect because
// the portal mounts the panel a render late: capture focused its text box in an
// effect, and Radix then moved focus to the panel over the top of it.
//
// On close, focus goes back to whatever had it when the dialog first rendered.
// Radix returns it to a <Dialog.Trigger> and cancels its own restore to do so;
// both of these open from app state with no trigger, so it went to <body> and
// a keyboard user who opened an item from the board lost their place in it.
export function Dialog({
  title,
  onClose,
  overlayClassName,
  initialFocus,
  children,
  ...content
}: ComponentProps<'div'> & {
  title: string
  onClose: () => void
  overlayClassName: string
  initialFocus?: RefObject<HTMLElement | null>
}) {
  const opener = useRef(document.activeElement as HTMLElement | null)
  return (
    <RadixDialog.Root open onOpenChange={open => !open && onClose()}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={overlayClassName}>
          <RadixDialog.Content
            {...content}
            aria-describedby={undefined}
            onOpenAutoFocus={e => {
              e.preventDefault()
              ;(initialFocus?.current ?? (e.currentTarget as HTMLElement)).focus()
            }}
            onCloseAutoFocus={e => {
              e.preventDefault()
              opener.current?.focus()
            }}
          >
            <RadixDialog.Title className="dialog-title">{title}</RadixDialog.Title>
            {children}
          </RadixDialog.Content>
        </RadixDialog.Overlay>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}
