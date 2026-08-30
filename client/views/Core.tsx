// Core.tsx — the Ask (core) view: headline, composer, live thread, chat
// history, and the AI answer body with citation linkification.
import { Fragment, useState, useRef, useEffect, useLayoutEffect } from 'react'
import type { ReactNode } from 'react'
import { Icon } from '../components/icons'
import { clockTime } from '../util/format'
import { ChatRow } from '../components/Chats'
import { CitedCard, PreviewCard } from '../components/Cards'
import { parseMarkdown } from '../util/markdown'
import type { Inline } from '../util/markdown'
import type { ChatSummary, ThreadMsg, UIItem } from '../types'

interface CoreViewProps {
  focus: boolean
  onFocus: () => void
  onBlur: () => void
  onKey: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  text: string
  setText: (s: string) => void
  submit: () => void
  taRef: React.RefObject<HTMLTextAreaElement | null>
  coreRef: React.RefObject<HTMLDivElement | null>
  thread: ThreadMsg[]
  jumpTo: (item: UIItem) => void
  pendingImg: string | null
  onImageFile: (file: File | null | undefined) => void
  clearImg: () => void
  chatList: ChatSummary[]
  openChat: (c: ChatSummary) => void
  newChat: () => void
  deleteChat: (id: string) => void
  renameChat: (id: string, title: string) => void
  chatId: string | null
  chatTotal: number
  loadMoreChats: () => void
  llmOff: boolean
  busy: boolean
  stop: () => void
  warming: string
}


export function CoreView({ focus, onFocus, onBlur, onKey, text, setText, submit, taRef, coreRef, thread, jumpTo, pendingImg, onImageFile, clearImg, chatList, openChat, newChat, deleteChat, renameChat, chatId, chatTotal, loadMoreChats, llmOff, busy, stop, warming }: CoreViewProps) {
  const fileRef = useRef<HTMLInputElement>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  const hasThread = thread.length > 0

  // Autoscroll, chat-style: follow the newest message, but stop following the
  // moment the user scrolls up to re-read something. `stick` resets whenever
  // the thread empties (New chat), so opening a saved chat lands on its latest
  // exchange instead of its first — which is where the old one-shot
  // requestAnimationFrame left it, having scrolled on a frame where the thread
  // node was still zero-height.
  const stick = useRef(true)
  // Mirrored into state purely so the "jump to latest" pill can appear; the ref
  // stays the source of truth because the pinning below runs in layout effects
  // and observer callbacks, where a state read would be stale.
  const [pinned, setPinned] = useState(true)
  const setStick = (v: boolean) => { stick.current = v; setPinned(v) }
  // "Scrolled up" has to mean a real gesture rather than any scroll event: a
  // cited preview's image lands after the answer commits and the composer
  // grows as it fills, and either makes the browser clamp scrollTop and fire a
  // scroll of its own. Reading `stick` from those would strand the view
  // mid-thread — the same symptom, one layer down.
  const gesture = useRef(0)
  const noteGesture = () => { gesture.current = Date.now() }
  const onThreadScroll = () => {
    const el = threadRef.current
    if (!el || Date.now() - gesture.current > 700) return
    setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
  }
  useLayoutEffect(() => { if (!hasThread) setStick(true) }, [hasThread])
  // Streaming rewrites the last message many times a second. This pin is
  // synchronous and cheap, and runs on every one of those commits; the
  // heavier machinery below only rebuilds when a message is added or removed.
  useLayoutEffect(() => {
    const el = threadRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [thread])

  useLayoutEffect(() => {
    const el = threadRef.current
    if (!el) return
    const pin = () => { if (stick.current) el.scrollTop = el.scrollHeight }
    pin()

    // One pin is never enough: the thread keeps growing after this commit,
    // because the images inside cited previews decode late. Each signal below
    // covers a case the others miss, and none of them can be the only one —
    // a ResizeObserver alone looked right until it turned out its callbacks
    // never fire in some engines, leaving the view stranded mid-thread.

    // 1. A short frame loop, for layout that settles within a few frames.
    let raf = 0
    let until = Date.now() + 400
    const tick = () => { pin(); if (Date.now() < until) raf = requestAnimationFrame(tick) }
    raf = requestAnimationFrame(tick)

    // 2. Each preview image as it lands. `load` doesn't bubble, hence capture.
    const onLoad = () => { until = Date.now() + 300; if (!raf) raf = requestAnimationFrame(tick); pin() }
    el.addEventListener('load', onLoad, true)

    // 3. The window changing shape — a rotation or a resize long after the
    //    settling window has closed.
    window.addEventListener('resize', pin)

    // 4. And the observer too, where it works: it is the only signal that
    //    catches the composer growing under the thread as the user types.
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(pin) : null
    ro?.observe(el)

    return () => {
      cancelAnimationFrame(raf)
      el.removeEventListener('load', onLoad, true)
      window.removeEventListener('resize', pin)
      ro?.disconnect()
    }
  }, [thread.length])

  // Sending always pulls the view back to the bottom, however far up the user
  // had scrolled — their own message is the one thing they always want to see.
  const send = () => { setStick(true); submit() }
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) setStick(true)
    onKey(e)
  }
  // Assign scrollTop rather than scrollTo({behavior:'smooth'}): the smooth
  // variant is a silent no-op in some engines, which left the pill hiding
  // itself without ever reaching the bottom. This is also the same motion the
  // pin above uses, so the two paths can't disagree.
  const jumpToLatest = () => {
    setStick(true)
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }
  return (
    <div className={'core' + (hasThread ? ' has-thread' : '')} ref={coreRef}>
      {!hasThread && (
        <div className="core-prompt">
          <h1>What do you want to find?</h1>
          <p>Ask a question. Answers are pulled from what you've saved.</p>
        </div>
      )}

      <div className="console">
        {hasThread && (
          <div className="mode-toggle">
            <button className="newchat" onClick={newChat} title="Start a new chat">✚ New chat</button>
          </div>
        )}

        {hasThread && (
          <div className="thread-wrap">
          <div className="thread" ref={threadRef} onScroll={onThreadScroll}
            onWheel={noteGesture} onTouchMove={noteGesture} onPointerDown={noteGesture}
            role="log" aria-live="polite" aria-relevant="additions text" aria-label="Conversation">
            {thread.map((m, i) => m.role === 'user'
              ? <div key={i} className="msg-user-row">
                  <div className="msg-user">{m.img && <img className="msg-img" src={m.img} alt="attachment" />}{m.text}</div>
                  {m.ts ? <div className="msg-time mono">{clockTime(m.ts)}</div> : null}
                </div>
              : <div key={i} className="msg-ai">
                  <div className="ai-body">
                    {m.pending
                      ? <div className="thinking"><span></span><span></span><span></span>
                          {warming && <span className="warming mono">{warming}</span>}
                        </div>
                      : m.stopped && !m.lead
                      // Stopped before it said anything: a state, not a reply,
                      // so none of the answer furniture applies.
                      ? <div className="msg-stopped">
                          <span>Stopped.</span>
                          {m.ts ? <span className="msg-time mono">{clockTime(m.ts)}</span> : null}
                        </div>
                      : <AiAnswer m={m} jumpTo={jumpTo} />}
                  </div>
                </div>,
            )}
          </div>
          {!pinned && (
            <button className="jump-latest" onClick={jumpToLatest} aria-label="Jump to the latest message">
              <Icon name="chevron" size={14} /> Latest
            </button>
          )}
          </div>
        )}

        {llmOff && (
          <div className="ask-off">
            <span className="mono">ASK IS OFF</span>
            <span>The language model is disabled, so questions can't be answered. Turn it on under Settings → Model Cores.</span>
          </div>
        )}

        <div className={'input-shell' + (focus ? ' focus' : '')}>
          {pendingImg && (
            <span className="attach-preview">
              <img src={pendingImg} alt="attachment" />
              <button className="attach-x" aria-label="Remove attached image" title="Remove attached image" onClick={clearImg}>✕</button>
            </span>
          )}
          <textarea ref={taRef} rows={1} value={text} disabled={llmOff}
            aria-label="Ask a question about your vault"
            placeholder={'Ask anything...'}
            onChange={(e) => setText(e.target.value)} onFocus={onFocus} onBlur={onBlur} onKeyDown={onKeyDown}
            onPaste={(e) => { const it = Array.from(e.clipboardData?.items || []).find((x) => x.type.startsWith('image/')); if (it) { e.preventDefault(); onImageFile(it.getAsFile()) } }} />
          <input type="file" accept="image/*" ref={fileRef} style={{ display: 'none' }} onChange={(e) => { onImageFile(e.target.files?.[0]); e.target.value = '' }} />
          <button className="attach-btn" aria-label="Attach an image" title="Attach an image" onClick={() => fileRef.current && fileRef.current.click()}>
            <Icon name="image" size={17} />
          </button>
          {/* One control in one place: while an answer is in flight the send
              button becomes the way to abandon it, rather than a second button
              appearing next to a dead one. */}
          {busy
            ? <button className="send-btn stop" aria-label="Stop generating" title="Stop generating" onClick={stop}>
                <Icon name="stop" size={18} />
              </button>
            : <button className="send-btn" aria-label="Send question" disabled={llmOff || (!text.trim() && !pendingImg)} onClick={send}>
                <Icon name="ask" size={18} />
              </button>}
        </div>
      </div>

      {!hasThread && chatList.length > 0 && (
        <div className="recent">
          <div className="recent-h">CHAT HISTORY</div>
          <div className="chat-list">
            {chatList.map((c) => (
              <ChatRow key={c.id} chat={c} active={c.id === chatId}
                open={openChat} rename={renameChat} remove={deleteChat} />
            ))}
          </div>
          {chatList.length < chatTotal && (
            <button className="chat-more" onClick={loadMoreChats}>
              Load more <span className="mono dim">{chatList.length} / {chatTotal}</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// AI answer body: the lead text (with [n] citations turned into jump buttons),
// then rich previews of the notes the answer cites, then the rest as "also
// considered".
function AiAnswer({ m, jumpTo }: { m: ThreadMsg; jumpTo: (item: UIItem) => void }) {
  const [showOthers, setShowOthers] = useState(false)
  const cited = m.cited || []
  const seen = new Set<number>()
  const nums: number[] = []
  for (const match of (m.lead || '').matchAll(/\[(\d+)\]/g)) {
    const n = parseInt(match[1], 10)
    if (n >= 1 && n <= cited.length && !seen.has(n)) { seen.add(n); nums.push(n) }
  }
  const featured = nums.map((n) => ({ n, item: cited[n - 1] }))
  const featIds = new Set(featured.map((f) => f.item.id))
  const others = cited.filter((c) => !featIds.has(c.id))
  return (
    <>
      <div className={'ai-lead' + (m.streaming ? ' streaming' : '')}>{renderLead(m, jumpTo)}</div>
      {featured.length > 0 && (
        <div className="preview-list">{featured.map((f) => <PreviewCard key={f.item.id} n={f.n} item={f.item} onJump={jumpTo} />)}</div>
      )}
      {others.length > 0 && (
        <div className="also">
          <button className="also-toggle mono" onClick={() => setShowOthers((v) => !v)} aria-expanded={showOthers}>
            <span className={'also-caret' + (showOthers ? ' open' : '')}></span>
            {featured.length > 0 ? 'ALSO CONSIDERED' : 'SOURCES SEARCHED'} <span className="also-count">{others.length}</span>
          </button>
          {showOthers && (
            <div className="cited-list">{others.map((c) => <CitedCard key={c.id} item={c} onJump={jumpTo} />)}</div>
          )}
        </div>
      )}
      {/* Nothing to stamp or copy until the answer has stopped moving. */}
      {!m.streaming && (
        <div className="msg-foot">
          {m.ts ? <span className="msg-time mono">{clockTime(m.ts)}</span> : null}
          {m.stopped && <span className="msg-stopped-tag mono">STOPPED</span>}
          <CopyAnswer text={m.lead || ''} />
        </div>
      )}
    </>
  )
}

// The async clipboard needs a secure origin and an ungranted permission that
// some contexts simply refuse. Falling back to the old selection-based copy is
// the difference between a button that works and one that silently does
// nothing, which is how this first shipped.
async function writeClipboard(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true } catch { /* try the fallback */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch { return false }
}

// Copy the answer as the model wrote it — the Markdown source, not the
// rendered text, so a list pasted elsewhere is still a list.
function CopyAnswer({ text }: { text: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle')
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = async () => {
    const ok = await writeClipboard(text)
    setState(ok ? 'done' : 'failed')
    clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setState('idle'), ok ? 1600 : 2400)
  }
  const label = state === 'done' ? 'Copied' : state === 'failed' ? "Couldn't copy" : 'Copy'
  return (
    <button className={'msg-copy' + (state === 'idle' ? '' : ' ' + state)} onClick={copy}
      aria-label={state === 'idle' ? 'Copy answer' : label} title={label}>
      <Icon name={state === 'done' ? 'check' : 'copy'} size={13} />
      <span>{label}</span>
    </button>
  )
}

// Turn [n] citation markers in a text fragment into clickable jump buttons.
function linkifyCites(text: string, m: ThreadMsg, jumpTo: (item: UIItem) => void, keyBase: string): ReactNode[] {
  const cited = m.cited || []
  const out: ReactNode[] = []
  let last = 0
  for (const match of text.matchAll(/\[(\d+)\]/g)) {
    const n = parseInt(match[1], 10)
    const item = n >= 1 && n <= cited.length ? cited[n - 1] : null
    out.push(text.slice(last, match.index))
    out.push(item
      ? <button key={keyBase + match.index} className="cite-ref mono" title="Show note" onClick={() => jumpTo(item)}>{n}</button>
      : match[0])
    last = match.index + match[0].length
  }
  out.push(text.slice(last))
  return out
}

// The answer body. Models reply in light Markdown — bullet lists, a bold lead
// phrase, the odd fenced snippet — so the lead is parsed into blocks rather
// than dropped in as one raw string, which used to render the syntax itself
// and collapse every paragraph break. Citation linkification then runs over
// the text of each span, so an [n] keeps working wherever it lands.
function renderLead(m: ThreadMsg, jumpTo: (item: UIItem) => void): ReactNode {
  return parseMarkdown(m.lead || '').map((b, i) => {
    switch (b.kind) {
      case 'pre':
        return <pre key={i} className="ai-pre"><code>{b.text}</code></pre>
      case 'h':
        return <p key={i} className="ai-h">{renderSpans(b.spans, m, jumpTo, String(i))}</p>
      case 'ul':
        return <ul key={i} className="ai-list">{b.items.map((it, j) =>
          <li key={j}>{renderSpans(it, m, jumpTo, i + '.' + j)}</li>)}</ul>
      case 'ol':
        return <ol key={i} className="ai-list" start={b.start}>{b.items.map((it, j) =>
          <li key={j}>{renderSpans(it, m, jumpTo, i + '.' + j)}</li>)}</ol>
      default:
        return <p key={i}>{renderSpans(b.spans, m, jumpTo, String(i))}</p>
    }
  })
}

function renderSpans(spans: Inline[], m: ThreadMsg, jumpTo: (item: UIItem) => void, keyBase: string): ReactNode[] {
  return spans.map((s, i) => {
    const k = keyBase + ':' + i
    if (s.kind === 'br') return <br key={k} />
    // A code span is verbatim by definition — no citations, no question echo.
    if (s.kind === 'code') return <code key={k} className="ai-code">{s.text}</code>
    const inner = decorate(s.text, m, jumpTo, k)
    if (s.kind === 'strong') return <strong key={k}>{inner}</strong>
    if (s.kind === 'em') return <em key={k}>{inner}</em>
    return <Fragment key={k}>{inner}</Fragment>
  })
}

// One run of plain text: highlight the question where the model quotes it back,
// and turn every [n] into a jump button.
function decorate(text: string, m: ThreadMsg, jumpTo: (item: UIItem) => void, keyBase: string): ReactNode[] {
  const q = m.q?.trim()
  if (q) {
    const parts = text.split('“' + q + '”')
    if (parts.length === 2) return [
      ...linkifyCites(parts[0], m, jumpTo, keyBase + 'a'),
      <Fragment key={keyBase + 'q'}>“<span className="q">{q}</span>”</Fragment>,
      ...linkifyCites(parts[1], m, jumpTo, keyBase + 'b'),
    ]
  }
  return linkifyCites(text, m, jumpTo, keyBase)
}
