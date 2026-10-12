// Cards.tsx — the gallery card around an item, and the compact "cited" card
// used in Ask answers. The item's own body, by type, is CardBody.tsx.
import { Fragment } from 'react'
import { Icon, CAT } from './icons'
import { relTime } from '../util/format'
import { isMediaFirst, sourceGlyph, sourceLabel } from '../domain/source'
import { byPath, spaceLabel } from '../domain/spaceTree'
import type { Collection, UIItem } from '../types'
import { Menu } from '../ui/Menu'
import { useDemo } from './Demo'
import { CardInner } from './CardBody'
import { routeToPath } from '../app/router'

export function ItemCard({
  item,
  onDelete,
  onExpand,
  collections,
  onAddTo,
  onRemoveFrom,
  space,
}: {
  item: UIItem
  onDelete?: (item: UIItem) => void
  onExpand?: (item: UIItem) => void
  collections?: Collection[]
  onAddTo?: (cid: string, itemId: string) => void
  onRemoveFrom?: (cid: string, itemId: string) => void
  /** The space this card is shown in. Its corner action then takes the item
      out of that space; deleting from the archive stays in the expanded view. */
  space?: string
}) {
  // every card opens the expanded view on click (the corner actions stop
  // propagation); the source URL is reached from there, not from the tile
  const openable = !!onExpand
  const brand = sourceGlyph(item)
  // The headline tile draws its own source mark inline, so the floating corner
  // badge would be a second copy of the same glyph.
  const headline = item.type === 'link' && !isMediaFirst(item)
  // On the demo a visitor may delete only a link they saved, and put links only
  // in spaces they made (server/routes/demo.ts); see Expanded.tsx.
  const demo = !!useDemo()
  const spaces = demo ? collections?.filter(c => c.visitor) : collections
  const canCollect = !!(spaces && onAddTo && onRemoveFrom)
  // Inside a space the corner never deletes: trash there read as "take it out
  // of here" and took the item out of everything (test/client/space-card-action).
  const corner = space
    ? onRemoveFrom &&
      spaces?.some(c => c.id === space) && {
        label: 'Remove from space',
        icon: 'close' as const,
        run: () => onRemoveFrom(space, item.id),
      }
    : onDelete && (!demo || item.visitor) && { label: 'Delete', icon: 'trash' as const, run: () => onDelete(item) }
  const overlay = (
    <Fragment>
      {brand && !headline && (
        <span className="card-src" title={brand}>
          <Icon name={brand} size={13} />
        </span>
      )}
      <div className="card-actions">
        {canCollect && (
          <Menu
            title="Add to space"
            empty="No spaces yet"
            trigger={
              <button className="card-act add" title="Add to space" aria-label="Add to space">
                <Icon name="plus" size={14} />
              </button>
            }
            items={byPath(spaces!, spaces!).map(c => {
              const on = c.itemIds.includes(item.id)
              return {
                key: c.id,
                label: spaceLabel(spaces!, c.id),
                checked: on,
                trailing: c.tags.length > 0 && (
                  <span title="Smart space">
                    <Icon name="spark" size={11} />
                  </span>
                ),
                onSelect: () => (on ? onRemoveFrom!(c.id, item.id) : onAddTo!(c.id, item.id)),
              }
            })}
          />
        )}
        {corner && (
          <button className="card-act del" title={corner.label} aria-label={corner.label} onClick={corner.run}>
            <Icon name={corner.icon} size={13} />
          </button>
        )}
      </div>
    </Fragment>
  )
  return (
    <article className={`item-card type-${item.type}${headline ? ' linktile' : ''}${openable ? ' openable' : ''}`}>
      {/* The card opens through a link stretched under its corner actions, not
          by being a button itself: a button role holding real buttons nests
          controls, which assistive tech flattens, and the card was named by its
          raw URL. A link to the item's own address also opens in a new tab. */}
      {openable && (
        <a
          className="card-open"
          href={routeToPath('all', item.id)}
          onClick={e => {
            if (e.metaKey || e.ctrlKey || e.shiftKey) return
            e.preventDefault()
            onExpand!(item)
          }}
        >
          <span className="sr-only">{item.title || item.host || 'Open item'}</span>
        </a>
      )}
      <div className="card-content">
        <CardInner item={item} overlay={overlay} />
      </div>
    </article>
  )
}

// ── Ask citation tiles ──────────────────────────────────────────────────────
// A tile under an answer is evidence, read inside a column of 13px prose — not
// an item on a wall of media. So it deliberately does NOT reuse the gallery
// card: that one branches five ways by type, which is why a row of them used to
// arrive as five different shapes at five different heights, each carrying a
// bordered type pill, a bracketed number and a timestamp stacked above the
// content. Here every type renders one shape — fixed media box, title, one meta
// line — so a grid lines up along the same edges however unlike the items are.

// The one line of small print under a tile: what it is, where it came from,
// when it was saved. Replaces the badge/number/timestamp header row.
//
// Only a real origin is named. sourceLabel falls back to "Web", which on an
// item with no host is a fact about nothing — and at this width a word of
// filler is what pushes the date off the end of the line.
function tileMeta(it: UIItem): string {
  const kind = CAT[it.type].label.replace(/s$/, '')
  const from = it.siteName || (it.host ? sourceLabel(it) : null)
  return [kind, from, relTime(it.ts)].filter(Boolean).join(' · ')
}

function tileTitle(it: UIItem): string {
  return it.title || it.host || CAT[it.type].label.replace(/s$/, '')
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

export function PreviewCard({ item, n, onJump }: { item: UIItem; n: number; onJump: (item: UIItem) => void }) {
  const it = item
  const media = it.thumb
  // A link with no picture has its description in the slot the media would
  // occupy — the tile keeps its footprint instead of collapsing.
  const excerpt = !media ? (it.note || it.summary || '').trim() : ''
  const title = tileTitle(it)
  // An excerpt that opens with the title would print the same sentence on the
  // tile twice. The excerpt is the fuller of the two, so it is the one that
  // stays.
  const titled = !(excerpt && norm(excerpt).startsWith(norm(title)))
  const jump = () => onJump(it)
  return (
    <article
      className={`tile ask-tile type-${it.type}`}
      tabIndex={0}
      role="button"
      title="Open in vault"
      onClick={jump}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          jump()
        }
      }}
    >
      <div className={`tile-media${media || !excerpt ? '' : ' quote'}`}>
        {media ? (
          // The glyph sits under the picture, which covers it — so a thumbnail
          // whose file has gone missing falls back to the same flat field a
          // tile without one gets, instead of a broken-image box.
          <>
            <Icon name={CAT[it.type].glyph} size={20} />
            <img
              src={media}
              alt=""
              loading="lazy"
              onError={e => {
                e.currentTarget.style.display = 'none'
              }}
            />
            {it.type === 'video' && (
              <span className="tile-play">
                <Icon name="play" size={12} />
              </span>
            )}
          </>
        ) : excerpt ? (
          <p className="tile-excerpt">{excerpt}</p>
        ) : (
          <Icon name={CAT[it.type].glyph} size={20} />
        )}
        {/* Pinned to the picture's top-left, the way a plate number sits on a
            figure. In the caption it competed with the title for the first
            line; up here it is the first thing read on the tile and the
            caption is left to the words. */}
        <span className="tile-plate">{n}</span>
      </div>
      <div className="tile-cap">
        {titled && <span className="tile-title">{title}</span>}
        <span className="tile-meta">{tileMeta(it)}</span>
      </div>
    </article>
  )
}

// The compact row for sources the answer searched but did not quote. Same
// information as the tile, one line high — and no longer led by the item's raw
// UUID, which was the widest thing on the row and the least readable.
export function CitedCard({ item, onJump }: { item: UIItem; onJump: (item: UIItem) => void }) {
  const it = item
  return (
    <button className="cited" onClick={() => onJump(it)}>
      <span className="cited-icon" data-type={it.type}>
        <Icon name={CAT[it.type].glyph} size={14} />
      </span>
      <span className="cited-main">
        <span className="cited-summary">{it.title}</span>
        <span className="cited-meta">{tileMeta(it)}</span>
      </span>
      <span className="cited-go">
        <Icon name="external" size={13} />
      </span>
    </button>
  )
}
