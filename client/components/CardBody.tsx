// CardBody.tsx — what a saved item looks like inside its card, by type: the
// media, link tile or loading shell. The gallery card (Cards.tsx) and a
// canvas card (Canvas.tsx) both wrap it in their own chrome.
import { Fragment } from 'react'
import type { ReactElement } from 'react'
import { Icon } from './icons'
import { imgGradient } from '../util/format'
import { isMediaFirst, isAwaitingContent, sourceGlyph, sourceLabel } from '../domain/source'
import type { UIItem } from '../types'

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
