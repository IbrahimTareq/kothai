import { Slot } from '@radix-ui/react-slot'
import type { ComponentProps } from 'react'

// The one writer of .btn's class list (lint:tokens fails any other). While each
// call site spelled its own modifiers, every button was a fresh design choice.
//
// danger is a flag rather than a tone because it composes with solid: that
// pair is the confirm half of every arm/confirm, and was drawn from scratch
// three times before .btn could express it.
//
// asChild puts the box on the child instead of a <button>, for the two things
// that must look like one and cannot be one: an <a download> (a button cannot
// save a file without script) and the <label> wrapping a hidden file input.
type Props = ComponentProps<'button'> & {
  size?: 'xs' | 'lg' | 'icon'
  tone?: 'solid' | 'ghost'
  danger?: boolean
  asChild?: boolean
}

export function Button({ size, tone, danger, asChild, className, ...rest }: Props) {
  const Box = asChild ? Slot : 'button'
  const cls = ['btn', size && `btn--${size}`, tone && `btn--${tone}`, danger && 'btn--danger', className]
  return <Box className={cls.filter(Boolean).join(' ')} {...rest} />
}
