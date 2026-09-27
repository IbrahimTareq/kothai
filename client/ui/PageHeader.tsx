import { Fragment, type ReactNode } from 'react'

// The top of every page, in two tiers. Each screen used to build its own: a
// search box and no title on Everything, an h1 at one size on Spaces, an h2 at
// another inside an icon tile on Settings, and a space's name with its rename
// and delete tucked against it over a hairline nobody else drew. Four pages,
// four answers to "where am I and what can I do here".
//
//   trail     — an optional line above: the pages this one sits inside, each
//               a way back up (a space inside another)
//   identity  — an optional lead mark, the title, a count beside it,
//               page actions on the right
//   summary   — an optional line under the identity: what the page is for
//   toolbar   — filters on the left (what is shown), display on the right
//               (how it is shown); omitted when a page has neither
//
// lead sits outside the <h1> on purpose: a smart space's spark carries its own
// tooltip, which the title's overflow clip would cut off and which would
// otherwise be read out as part of the page's name.
//
// The Ask landing is not a page header: its headline is the prompt itself.
export function PageHeader({
  trail,
  lead,
  title,
  meta,
  actions,
  summary,
  filters,
  display,
}: {
  trail?: { key: string; label: string; onClick: () => void }[]
  lead?: ReactNode
  title: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  summary?: ReactNode
  filters?: ReactNode
  display?: ReactNode
}) {
  return (
    <header className="page-head">
      {trail && (
        <nav className="page-trail" aria-label="Breadcrumb">
          {trail.map(c => (
            <Fragment key={c.key}>
              <button type="button" onClick={c.onClick}>
                {c.label}
              </button>
              <span aria-hidden="true">›</span>
            </Fragment>
          ))}
        </nav>
      )}
      <div className="page-id">
        {lead}
        <h1 className="page-title">{title}</h1>
        {meta != null && <span className="page-meta">{meta}</span>}
        {actions && <div className="page-actions">{actions}</div>}
      </div>
      {summary}
      {(filters || display) && (
        <div className="page-toolbar">
          <div className="page-filters">{filters}</div>
          {display && <div className="page-display">{display}</div>}
        </div>
      )}
    </header>
  )
}
