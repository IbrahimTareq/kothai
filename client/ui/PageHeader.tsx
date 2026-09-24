import type { ReactNode } from 'react'

// The top of every page, in two tiers. Each screen used to build its own: a
// search box and no title on Everything, an h1 at one size on Spaces, an h2 at
// another inside an icon tile on Settings, and a space's name with its rename
// and delete tucked against it over a hairline nobody else drew. Four pages,
// four answers to "where am I and what can I do here".
//
//   identity  — an optional lead mark, the title, a mono count beside it,
//               page actions on the right
//   toolbar   — filters on the left (what is shown), display on the right
//               (how it is shown); omitted when a page has neither
//
// lead sits outside the <h1> on purpose: a smart space's spark carries its own
// tooltip, which the title's overflow clip would cut off and which would
// otherwise be read out as part of the page's name.
//
// The Ask landing is not a page header: its headline is the prompt itself.
export function PageHeader({
  lead,
  title,
  meta,
  actions,
  filters,
  display,
}: {
  lead?: ReactNode
  title: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  filters?: ReactNode
  display?: ReactNode
}) {
  return (
    <header className="page-head">
      <div className="page-id">
        {lead}
        <h1 className="page-title">{title}</h1>
        {meta != null && <span className="page-meta mono">{meta}</span>}
        {actions && <div className="page-actions">{actions}</div>}
      </div>
      {(filters || display) && (
        <div className="page-toolbar">
          <div className="page-filters">{filters}</div>
          {display && <div className="page-display">{display}</div>}
        </div>
      )}
    </header>
  )
}
