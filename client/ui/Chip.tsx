import type { ComponentProps } from 'react'

// A pill that is one of a set you pick from, add to or take from: Everything's
// filters, a space's rule tags, an item's tags. .chip was already one box, but
// the tag pills beside it were drawn again in Expanded — padding-sized where
// .chip is toolbar-tall, removing with a red border where a rule tag reddened
// only its ×, and "+ Add tag" filled with the accent while "+ rule tag" and
// "Add to space" below it were dashed and quiet. One pill, four states:
//
//   on         a filter that is applied; sets aria-pressed
//   compact    in a list rather than on a toolbar (Expanded's tags)
//   add        the dashed "+ …" that adds one to the set
//   onRemove   its × takes it away, and reddens the pill on hover
//
// A removable chip is text with one button, its ×. The whole pill used to be
// the remove button, and it looks exactly like a filter chip, so a tap meant to
// pick a tag took it away (design critique, 2026-10-12).
//
// A chip that opens a popover gets its open look from Radix's data-state.
type ChipProps = ComponentProps<'button'> & {
  on?: boolean
  compact?: boolean
  add?: boolean
  onRemove?: () => void
  removeLabel?: string
}

export function Chip({ on, compact, add, onRemove, removeLabel, className, children, ...rest }: ChipProps) {
  const cls = [
    'chip',
    on && 'on',
    compact && 'chip--compact',
    add && 'chip--add',
    onRemove && 'chip--removable',
    className,
  ]
  if (onRemove)
    return (
      <span className={cls.filter(Boolean).join(' ')}>
        {children}
        <button type="button" className="chip-x" aria-label={removeLabel} onClick={onRemove}>
          ×
        </button>
      </span>
    )
  return (
    <button className={cls.filter(Boolean).join(' ')} aria-pressed={on} {...rest}>
      {children}
    </button>
  )
}
