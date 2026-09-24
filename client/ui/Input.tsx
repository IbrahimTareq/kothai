import type { ComponentProps } from 'react'

// The one box for typing into. Seven boxed fields had drifted into five
// backgrounds, three focus colours, three paddings and two radii — two of them
// with no focus style at all — though Settings already said "every field on
// this surface is one box". This is that box, for every surface.
//
// compact is for fields that list or filter many short values (the endpoint
// model combobox, the rule-tag filter), where --text-sm crowds the list.
// danger focuses red, for the field inside a destructive confirm.
//
// In-place editors are not this: a canvas note, a chat or space rename, a tag
// pill, the composers and Everything's underline search each take the shape
// of what they edit. Those are raw fields on the ratchet in lint-tokens.ts.
type FieldProps = { compact?: boolean; danger?: boolean }

const fieldClass = ({ compact, danger }: FieldProps, className?: string) =>
  ['field', compact && 'field--compact', danger && 'field--danger', className].filter(Boolean).join(' ')

export function Input({ compact, danger, className, ...rest }: ComponentProps<'input'> & FieldProps) {
  return <input className={fieldClass({ compact, danger }, className)} {...rest} />
}

export function Textarea({ compact, danger, className, ...rest }: ComponentProps<'textarea'> & FieldProps) {
  return <textarea className={fieldClass({ compact, danger }, className)} {...rest} />
}
