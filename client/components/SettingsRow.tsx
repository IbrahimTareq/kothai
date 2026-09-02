// The two primitives the settings surface is built from, lifted out of
// Settings.tsx so per-section components (see ImportSection.tsx) can use them
// without importing the view that renders them.
import type { HTMLAttributes, ReactNode } from 'react'

// Reusable settings block: a mono label + optional sub-line, hosting any content.
// Drop a new <SettingsGroup label="…">…</SettingsGroup> to add a section.
export function SettingsGroup({ label, sub, className, children }: {
  label: string; sub?: ReactNode; className?: string; children: ReactNode
}) {
  return (
    <section className={'settings-group' + (className ? ' ' + className : '')}>
      <div className="recent-h">{label}</div>
      {sub && <div className="settings-group-sub">{sub}</div>}
      {children}
    </section>
  )
}

// One row of the settings row list: title + explanation on the left, its
// control on the right. `children` renders full-width beneath the row — the
// confirmation steps and result/error messages expand there in place.
export function SettingsRow({ title, desc, action, danger, children, ...rest }: {
  title: string
  desc: ReactNode
  action?: ReactNode
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
        {action && <div className="settings-row-action">{action}</div>}
      </div>
      {children}
    </div>
  )
}
