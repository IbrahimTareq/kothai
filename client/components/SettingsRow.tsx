// The primitives the settings surface is built from, lifted out of
// Settings.tsx so per-section components (see ImportSection.tsx) can use them
// without importing the view that renders them.
import type { HTMLAttributes, ReactNode } from 'react'

// Reusable settings block: a mono label + optional sub-line, hosting any content.
// Drop a new <SettingsGroup label="…">…</SettingsGroup> to add a section.
export function SettingsGroup({
  label,
  sub,
  className,
  children,
}: {
  label: string
  sub?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <section className={`settings-group${className ? ` ${className}` : ''}`}>
      <div className="recent-h eyebrow">{label}</div>
      {sub && <div className="settings-group-sub">{sub}</div>}
      {children}
    </section>
  )
}

// One row of the settings row list: title + explanation on the left, its
// control on the right. `children` renders full-width beneath the row — the
// confirmation steps and result/error messages expand there in place.
export function SettingsRow({
  title,
  desc,
  action,
  hint,
  danger,
  children,
  ...rest
}: {
  title: string
  desc: ReactNode
  action?: ReactNode
  /** Small line under the control — a secondary way to use the row (e.g. that
   *  it also accepts a drop), kept out of `desc` so it sits with the control
   *  it describes rather than at the end of a paragraph. */
  hint?: ReactNode
  danger?: boolean
  children?: ReactNode
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div className="settings-row" data-danger={danger || undefined} {...rest}>
      <div className="settings-row-head">
        <div className="settings-row-main">
          <div className="settings-row-title">{title}</div>
          <div className="settings-row-desc">{desc}</div>
        </div>
        {action && (
          <div className="settings-row-action">
            {action}
            {hint && <div className="import-hint">{hint}</div>}
          </div>
        )}
      </div>
      {children}
    </div>
  )
}

// How a settings row reports the outcome of something it just did.
//
// This markup was written out eleven times across five files — every row that
// finishes a job ends with the same wrapper, the same pair of classes and the
// same two ARIA attributes. Those attributes are the reason this is a
// component rather than a convention: role="status" + aria-live="polite" is
// what makes the outcome reach a screen reader at all, and a hand-copied block
// that omits them looks perfectly correct on screen. There is now one place
// that cannot forget them.
//
// The classes used to be .import-result / .import-error, named for the first
// row that needed them and then borrowed by re-tag, erase, availability and
// model files — four features whose results are not imports. Renamed to
// .row-result / .row-error now that exactly one file refers to them.
export function RowStatus({ tone = 'ok', children }: { tone?: 'ok' | 'error'; children: ReactNode }) {
  return (
    <div className="settings-row-extra">
      <div className={tone === 'error' ? 'row-error' : 'row-result'} role="status" aria-live="polite">
        {children}
      </div>
    </div>
  )
}
