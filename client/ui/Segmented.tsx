import * as ToggleGroup from '@radix-ui/react-toggle-group'
import type { ReactNode } from 'react'

// Pick exactly one of a few, on a toolbar or a settings row. Five of these
// were drawn by hand, in two boxes (.seg and the residency picker's flush,
// hairline-split one) and four accessibility patterns: aria-pressed, tabs, a
// radiogroup whose buttons never said which was checked, and nothing at all.
// Radix makes every one a radiogroup with arrow-key movement.
//
// A title is the accessible name as well as the tooltip, since an icon-only
// option has no text of its own.
type Option<T> = { value: T; label: ReactNode; title?: string }

export function Segmented<T extends string>({
  label,
  value,
  onChange,
  options,
  disabled,
  className,
}: {
  label: string
  value: T
  onChange: (value: T) => void
  options: Option<T>[]
  disabled?: boolean
  className?: string
}) {
  return (
    <ToggleGroup.Root
      type="single"
      className={className ? `seg ${className}` : 'seg'}
      aria-label={label}
      value={value}
      // Radix lets a click on the chosen option clear it, reporting ''. These
      // controls always hold a choice, so that click changes nothing.
      onValueChange={v => v && onChange(v as T)}
      disabled={disabled}
    >
      {options.map(o => (
        <ToggleGroup.Item key={o.value} value={o.value} className="seg-btn" title={o.title} aria-label={o.title}>
          {o.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  )
}
