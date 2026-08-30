// Expanded.tsx — full-screen overlay for a single saved item. A type/brand-
// specific main panel on the left (GitHub repo card, Reddit post, media reel,
// article stage, or a plain note/image/code) and an editable metadata sidebar
// (title, source, tags, mind note, actions) on the right.
import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Icon } from '../components/icons'
import { Carousel } from '../components/Carousel'
import { relTime, imgGradient } from '../util/format'
import { isMediaFirst, sourceGlyph, sourceLabel, githubParts } from '../domain/source'
import type { Collection, UIItem } from '../types'

function openUrl(url?: string | null) {
  if (url) window.open(url, '_blank')
}

// ---- per-brand / per-type main panels ---------------------------------------

function GithubPanel({ item }: { item: UIItem }): ReactElement {
  const { owner, repo } = githubParts(item.url)
  const desc = item.note || item.summary
  return (
    <div className="exp-card gh">
      <div className="exp-card-logo"><Icon name="github" size={44} /></div>
      <Field label="Project name" value={repo || item.title || ''} big />
      {desc && <Field label="Description" value={desc} />}
      {(owner || item.siteName) && <Field label="Owner" value={owner || item.siteName || ''} />}
      <a className="exp-card-cta" href={item.url ?? undefined} target="_blank" rel="noreferrer">
        <Icon name="github" size={14} /> View on GitHub
      </a>
    </div>
  )
}

function RedditPanel({ item }: { item: UIItem }): ReactElement {
  return (
    <div className="exp-card reddit">
      <div className="exp-reddit-head"><Icon name="reddit" size={56} /></div>
      <div className="exp-reddit-body">
        <div className="exp-reddit-tag">reddit</div>
        <div className="exp-reddit-text">{item.title || item.note || item.summary}</div>
        {item.url && (
          <a className="exp-card-cta ghost" href={item.url} target="_blank" rel="noreferrer">
            <Icon name="reddit" size={14} /> View on Reddit
          </a>
        )}
      </div>
    </div>
  )
}

function MediaPanel({ item }: { item: UIItem }): ReactElement {
  const brand = sourceGlyph(item)
  const media = item.thumb || item.img
  // A multi-photo post is a deck to swipe through, not one cropped still. The
  // play glyph is deliberately dropped here: every slide is a photo, so the
  // only thing left to signal is which slide you're on, which the dots do.
  if (item.slides && item.slides.length > 1) {
    return (
      <Carousel
        slides={item.slides}
        alt={item.title || ''}
        onOpen={() => openUrl(item.url)}
        badge={brand ? <span className="exp-media-badge"><Icon name={brand} size={15} /></span> : null}
      />
    )
  }
  return (
    <div className="exp-media" onClick={() => openUrl(item.url)}>
      <div className="exp-media-frame" style={media ? undefined : { background: imgGradient((item.title || 'v').length * 7) }}>
        {media && <img src={media} alt={item.title || ''} loading="lazy" />}
        <div className="exp-media-scan" />
        {item.type === 'video' && <div className="exp-play"><Icon name="play" size={30} /></div>}
        {brand && <span className="exp-media-badge"><Icon name={brand} size={15} /></span>}
      </div>
    </div>
  )
}

// The stage for a saved article — anything linked that is not a repo, a Reddit
// post or a piece of platform media.
//
// What it replaces: a bare screenshot of the page with a host pill over it, which
// showed the reader the one thing they had already seen (the page) and none of
// what they saved it for. An article reads top-down — image, masthead, headline,
// standfirst, way in — so this is laid out as the article itself is: the hero
// above, the publisher named under it, the headline set large and centred, the
// description as a standfirst, and the way back to the original as the one
// filled control on the stage.
function ArticlePanel({ item }: { item: UIItem }): ReactElement {
  const brand = sourceGlyph(item)
  const lede = item.note || item.summary
  return (
    <div className="exp-article">
      {item.thumb && (
        <img className="exp-article-hero" src={item.thumb} alt={item.title || ''} loading="lazy"
          onClick={() => openUrl(item.url)} />
      )}
      <div className="exp-article-src mono">
        <Icon name={brand || 'article'} size={15} />
        {item.siteName || item.host || sourceLabel(item)}
      </div>
      <h1 className="exp-article-title">{item.title || item.host || 'Untitled'}</h1>
      {lede && <p className="exp-article-lede">{lede}</p>}
      {item.url && (
        <a className="exp-article-cta" href={item.url} target="_blank" rel="noreferrer">
          <Icon name="article" size={14} /> Read the article
        </a>
      )}
    </div>
  )
}

function ImagePanel({ item }: { item: UIItem }): ReactElement {
  return (
    <div className="exp-img">
      {item.img
        ? <img src={item.img} alt={item.name || 'image'} />
        : <div className="exp-img-ph" style={{ background: imgGradient(item.seed ?? 1) }}><Icon name="image" size={40} /></div>}
    </div>
  )
}

function CodePanel({ item }: { item: UIItem }): ReactElement {
  return (
    <div className="exp-code">
      <div className="code-head mono"><span className="code-dot" /><span className="code-dot" /><span className="code-dot" /><span className="code-lang">{item.lang}</span></div>
      <pre className="code-block mono">{item.text}</pre>
    </div>
  )
}

function NotePanel({ item }: { item: UIItem }): ReactElement {
  return <div className="exp-note-panel">{item.text || item.title}</div>
}

function Field({ label, value, big }: { label: string; value: string; big?: boolean }): ReactElement {
  return (
    <div className="exp-field">
      <div className="exp-field-label">{label}</div>
      <div className={'exp-field-val' + (big ? ' big' : '')}>{value}</div>
    </div>
  )
}

function MainPanel({ item }: { item: UIItem }): ReactElement {
  const brand = sourceGlyph(item)
  if (item.type === 'link' || item.type === 'video') {
    if (brand === 'github') return <GithubPanel item={item} />
    if (brand === 'reddit') return <RedditPanel item={item} />
    if (isMediaFirst(item)) return <MediaPanel item={item} />
    return <ArticlePanel item={item} />
  }
  if (item.type === 'image') return <ImagePanel item={item} />
  if (item.type === 'code') return <CodePanel item={item} />
  return <NotePanel item={item} />
}

// ---- overlay + editable sidebar ---------------------------------------------

interface ExpandedProps {
  item: UIItem
  onClose: () => void
  onDelete: (id: string) => void
  onUpdate: (id: string, patch: { tags?: string[]; mindNote?: string }) => void
  onRetag: (id: string) => void
  collections: Collection[]
  onAddTo: (cid: string, itemId: string) => void
  onRemoveFrom: (cid: string, itemId: string) => void
}

export function ExpandedView({ item, onClose, onDelete, onUpdate, onRetag, collections, onAddTo, onRemoveFrom }: ExpandedProps) {
  const [tags, setTags] = useState<string[]>(item.tags || [])
  const [note, setNote] = useState<string>(item.mindNote || '')
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [picking, setPicking] = useState(false)
  const pickRef = useRef<HTMLDivElement>(null)
  const brand = sourceGlyph(item)

  const inSpaces = collections.filter((c) => c.itemIds.includes(item.id))
  const openSpaces = collections.filter((c) => !c.itemIds.includes(item.id))

  // reset local editing state when a different item is opened
  useEffect(() => { setTags(item.tags || []); setNote(item.mindNote || ''); setAdding(false); setDraft(''); setPicking(false) }, [item.id, item.tags, item.mindNote])

  // Esc closes the space picker first, then the overlay
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (picking) setPicking(false); else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, picking])

  // a click anywhere outside the picker dismisses it
  useEffect(() => {
    if (!picking) return
    const onDown = (e: MouseEvent) => {
      if (!pickRef.current?.contains(e.target as Node)) setPicking(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [picking])

  const commitTags = (next: string[]) => { setTags(next); onUpdate(item.id, { tags: next }) }
  const addTag = () => {
    const t = draft.trim()
    if (t && !tags.includes(t)) commitTags([...tags, t])
    setDraft(''); setAdding(false)
  }
  const removeTag = (t: string) => commitTags(tags.filter((x) => x !== t))
  const commitNote = () => { if (note !== (item.mindNote || '')) onUpdate(item.id, { mindNote: note }) }

  // brand glyph + label, shared by the linked and unlinked forms below
  const srcInner = <>{brand ? <Icon name={brand} size={12} /> : <Icon name="external" size={12} />}{sourceLabel(item)}</>

  return (
    <div className="exp-overlay" onClick={onClose}>
      <div className="exp-shell" onClick={(e) => e.stopPropagation()}>
        <button className="exp-close-m" aria-label="Close" onClick={onClose}><Icon name="close" size={16} /></button>
        <div className="exp-main"><MainPanel item={item} /></div>

        <aside className="exp-side">
          <div className="exp-side-scroll">
            <h2 className="exp-title">{item.title || item.name || (item.text || '').slice(0, 60) || 'Untitled'}</h2>
            <div className="exp-meta">
              {relTime(item.ts)}
              {item.url
                ? <a className="exp-src" href={item.url} target="_blank" rel="noreferrer">{srcInner}</a>
                : <span className="exp-src">{srcInner}</span>}
            </div>

            <section className="exp-sec">
              <div className="exp-sec-h">Tags <span className="exp-sec-n">{tags.length}</span></div>
              <div className="exp-tags">
                <button className="exp-addtag" onClick={() => setAdding(true)}>+ Add tag</button>
                {tags.map((t) => (
                  <button key={t} className="exp-tag" title="Remove tag" onClick={() => removeTag(t)}>
                    {t}<span className="exp-tag-x">×</span>
                  </button>
                ))}
                {adding && (
                  <input className="exp-tag-input mono" autoFocus value={draft} placeholder="tag…"
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') addTag(); if (e.key === 'Escape') { setAdding(false); setDraft('') } }}
                    onBlur={addTag} />
                )}
              </div>
            </section>

            <section className="exp-sec">
              <div className="exp-sec-h">Notes</div>
              <textarea className="exp-note" placeholder="Type here to add a note…"
                value={note} onChange={(e) => setNote(e.target.value)} onBlur={commitNote} />
            </section>

            <section className="exp-sec">
              <div className="exp-sec-h">Spaces <span className="exp-sec-n">{inSpaces.length}</span></div>
              <div className="exp-colls">
                {inSpaces.map((c) => (
                  <div key={c.id} className="exp-coll">
                    {c.tags.length > 0 && <Icon name="spark" size={11} />}
                    <span className="exp-coll-name">{c.name}</span>
                    <button className="exp-coll-x" aria-label={'Remove from ' + c.name}
                      onClick={() => onRemoveFrom(c.id, item.id)}><Icon name="close" size={11} /></button>
                  </div>
                ))}
                <div className="exp-coll-add" ref={pickRef}>
                  <button className={'exp-coll-plus' + (picking ? ' open' : '')} aria-expanded={picking}
                    onClick={() => setPicking(!picking)}>
                    <Icon name="plus" size={12} /> Add to space
                  </button>
                  {picking && (
                    <div className="exp-coll-menu">
                      {openSpaces.length === 0
                        ? <span className="exp-coll-menu-empty mono dim">{collections.length === 0 ? 'No spaces yet' : 'In every space'}</span>
                        : openSpaces.map((c) => (
                          <button key={c.id} className="exp-coll-opt"
                            onClick={() => { onAddTo(c.id, item.id); setPicking(false) }}>
                            {c.tags.length > 0 && <Icon name="spark" size={11} />}
                            <span className="exp-coll-name">{c.name}</span>
                          </button>
                        ))}
                    </div>
                  )}
                </div>
              </div>
            </section>
          </div>

          <div className="exp-side-actions">
            <button aria-label="Copy link" onClick={() => item.url && navigator.clipboard?.writeText(item.url)}>
              <Icon name="copy" size={16} /><span className="exp-tip">Copy link</span>
            </button>
            <button aria-label="Open original" onClick={() => openUrl(item.url)}>
              <Icon name="external" size={16} /><span className="exp-tip">Open original</span>
            </button>
            <button aria-label={item.pending ? 'Retagging…' : 'Re-tag'} disabled={item.pending} onClick={() => onRetag(item.id)}>
              <Icon name="retag" size={16} /><span className="exp-tip">{item.pending ? 'Retagging…' : 'Re-tag'}</span>
            </button>
            <button className="del" aria-label="Delete" onClick={() => { onDelete(item.id); onClose() }}>
              <Icon name="trash" size={16} /><span className="exp-tip">Delete</span>
            </button>
          </div>
        </aside>
      </div>
    </div>
  )
}
