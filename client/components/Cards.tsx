// Cards.tsx — per-type item rendering for gallery (card) + list (row) views,
// plus the compact "cited" card used in Ask answers.
import { Fragment } from 'react'
import type { ReactElement } from 'react'
import { Icon, CAT } from './icons'
import { relTime, imgGradient } from '../util/format'
import { isMediaFirst, isAwaitingContent, sourceGlyph, sourceLabel } from '../domain/source'
import type { Collection, UIItem } from '../types'
import { Menu } from '../ui/Menu'
import { useDemo } from './Demo'

// Deterministic placeholder height so gradient tiles stagger like real media.
function phHeight(seed: number) {
  return 150 + (Math.abs(seed) % 4) * 40
}

// UIItem.seed is declared in types.ts but NOTHING populates it — not the API,
// not the client mapper — so every `seed ?? 1` fell back to the same 1, giving
// every placeholder tile in a grid the identical hue and the identical height.
// The note id is stable, unique and always present, so it is what the
// placeholder varies on; a real `seed` still wins if one ever starts arriving.
function tileSeed(it: UIItem): number {
  if (typeof it.seed === 'number') return it.seed
  let h = 0
  for (let i = 0; i < it.id.length; i++) h = (h * 31 + it.id.charCodeAt(i)) | 0
  return Math.abs(h)
}

// A tile whose content hasn't landed yet. An imported note EXISTS the moment
// the import returns, but its caption and thumbnail are fetched afterwards —
// so without this each one renders as a FINISHED tile whose content happens to
// be a coloured rectangle and the importer's placeholder title. At import
// scale that reads as a wall of broken tiles rather than as work in progress.
//
// Reuses .card-skeleton — the sheen the windowed board already uses for slots
// it hasn't fetched. Same idea, one step along: this slot's row exists, its
// content doesn't. One loading language rather than two.
function LoadingCard({ item, overlay }: { item: UIItem; overlay?: ReactElement }): ReactElement {
  return (
    <Fragment>
      {/* Height comes from the same phHeight the gradient placeholders use, so
          a tile does not resize when its picture arrives. */}
      <div className="card-skeleton tile-load-media" style={{ height: phHeight(tileSeed(item)) }}>
        {overlay}
      </div>
      <div className="card-cap">
        <div className="card-skeleton tile-load-bar" aria-hidden="true"></div>
        <div className="card-skeleton tile-load-bar short" aria-hidden="true"></div>
      </div>
    </Fragment>
  )
}

// A thumbnail's stored width / height (server/links/fetch.ts's saveThumb) as
// its box's aspect ratio. Without it the image is zero-high until the file
// arrives, so every card was measured short, then grew as its picture loaded
// and repacked the board around it. Absent on thumbnails saved before shapes
// were recorded, which keep the old behaviour.
const shape = (it: UIItem) => (it.thumbRatio ? { aspectRatio: it.thumbRatio } : undefined)

// The picture-led card, kept for links whose content IS the picture (Instagram
// posts, TikTok). Unchanged from the card every link used to get.
function MediaLinkCard({ item, overlay }: { item: UIItem; overlay?: ReactElement }): ReactElement {
  if (isAwaitingContent(item)) return <LoadingCard item={item} overlay={overlay} />
  return (
    <Fragment>
      {item.thumb ? (
        <div className="link-thumb">
          <img src={item.thumb} alt="" loading="lazy" style={shape(item)} />
          <div className="img-scan"></div>
          {overlay}
        </div>
      ) : (
        <>
          <div className="card-favi">
            <span>{(item.host || '?')[0].toUpperCase()}</span>
          </div>
          {overlay}
        </>
      )}
      <div className="card-cap">
        <div className="card-title">{item.title}</div>
        <div className="card-host">
          <Icon name="external" size={11} /> {item.siteName || item.host}
        </div>
      </div>
    </Fragment>
  )
}

// The headline-led tile every other saved link gets — an article, a Reddit post, a repo.
//
// The old link card led with the picture and put the title under it at caption
// size, which is backwards for this kind of save: a link is read by its
// headline, and half of them (Reddit posts especially) have no picture at all,
// so the tile spent its surface on a favicon initial instead. Here the headline
// leads. The source mark sits top-left — the platform glyph where there is one,
// the article glyph otherwise — the title is set large and bottom-anchored so
// tiles of different title lengths line up along the same edge, the source is
// named under it in the label the badges use, and the thumbnail (if
// any) closes the tile, bled to its edges.
function LinkTile({ item, overlay }: { item: UIItem; overlay?: ReactElement }): ReactElement {
  const brand = sourceGlyph(item)
  // Reddit is the one source whose items are posts rather than pages, and the
  // subreddit is already in the title — so it names the kind, not the host.
  const label = brand === 'reddit' ? 'Reddit Post' : item.siteName || item.host || sourceLabel(item)
  return (
    <Fragment>
      {overlay}
      <div className="lt-body">
        <span className="lt-mark">
          <Icon name={brand || 'article'} size={20} />
        </span>
        <div className="lt-cap">
          <div className="lt-title">{item.title || item.host}</div>
          <div className="lt-label eyebrow">{label}</div>
        </div>
      </div>
      {item.thumb && (
        <div className="lt-shot">
          <img src={item.thumb} alt="" loading="lazy" style={shape(item)} />
        </div>
      )}
    </Fragment>
  )
}

// `overlay` (brand badge + action buttons) is placed INSIDE the thumbnail when
// there is one, so it sits over the image (like the top-left brand badge); for
// a media-less card (a faviconless link) it falls back to card level.
export function CardInner({ item, overlay }: { item: UIItem; overlay?: ReactElement }): ReactElement {
  const it = item
  switch (it.type) {
    case 'link':
      // A saved reel or short is media-first even though it is stored as a
      // link — it keeps the picture-led card (see isMediaFirst).
      if (isMediaFirst(it)) return <MediaLinkCard item={it} overlay={overlay} />
      return <LinkTile item={it} overlay={overlay} />
    case 'video':
      if (isAwaitingContent(it)) return <LoadingCard item={it} overlay={overlay} />
      return (
        <Fragment>
          {/* Seeded from the note's own seed, not its title's LENGTH. Every
              un-enriched TikTok note carries the identical placeholder title
              ("TikTok video"), so a length seed gave a whole import the same
              hue at the same height — the clone wall this loading state
              exists to prevent, which would otherwise return the moment a
              note finishes enriching without a thumbnail. See tileSeed. */}
          <div
            className={`img-thumb vid${it.thumb ? ' real' : ''}`}
            style={it.thumb ? undefined : { background: imgGradient(tileSeed(it)), height: phHeight(tileSeed(it)) }}
          >
            {it.thumb && <img className="vid-thumb-img" src={it.thumb} alt="" loading="lazy" style={shape(it)} />}
            <div className="img-scan"></div>
            <div className="play-btn">
              <Icon name="play" size={20} />
            </div>
            {overlay}
          </div>
          <div className="card-cap">
            <div className="card-title sm">{it.title}</div>
            <div className="card-host">
              <Icon name="video" size={11} /> {it.siteName || it.host}
            </div>
          </div>
        </Fragment>
      )
  }
}

export function ItemCard({
  item,
  onDelete,
  onExpand,
  collections,
  onAddTo,
  onRemoveFrom,
}: {
  item: UIItem
  onDelete: (id: string) => void
  onExpand?: (item: UIItem) => void
  collections?: Collection[]
  onAddTo?: (cid: string, itemId: string) => void
  onRemoveFrom?: (cid: string, itemId: string) => void
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
              // The card's own click and Enter open the expanded view, and
              // Radix opens this menu on Enter too, so both must stop here or
              // the keyboard would open the menu and the item at once.
              <button
                className="card-act add"
                title="Add to space"
                onClick={e => e.stopPropagation()}
                onKeyDown={e => e.stopPropagation()}
              >
                <Icon name="plus" size={14} />
              </button>
            }
            items={spaces!.map(c => {
              const on = c.itemIds.includes(item.id)
              return {
                key: c.id,
                label: c.name,
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
        {(!demo || item.visitor) && (
          <button
            className="card-act del"
            title="Release"
            onClick={e => {
              e.stopPropagation()
              onDelete(item.id)
            }}
          >
            <Icon name="trash" size={13} />
          </button>
        )}
      </div>
    </Fragment>
  )
  return (
    <article
      className={`item-card type-${item.type}${headline ? ' linktile' : ''}${openable ? ' openable' : ''}`}
      tabIndex={0}
      role={openable ? 'button' : undefined}
      title={item.url ?? undefined}
      onClick={openable ? () => onExpand!(item) : undefined}
      onKeyDown={
        openable
          ? e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onExpand!(item)
              }
            }
          : undefined
      }
    >
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
