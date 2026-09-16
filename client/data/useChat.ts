// The Ask feature end to end: the composer, the streaming answer, and the
// saved-conversation list.
//
// These three look separable and are not. The composer's text is cleared by
// the send, the send is gated on the thread ("one question at a time"), a
// successful answer is what creates the chat the list then shows, and deleting
// the open chat has to reset the composer. Lifted out of App.tsx as one unit
// for that reason — splitting it further would mean handing the pieces each
// other's setters.
//
// This owns the /ask/<id> URL. A conversation's address is chat state: the
// send is what first gives a question an address worth keeping, and starting a
// fresh chat is what drops it. Navigation calls in (showChat, clearChat,
// newChat) rather than reaching for the URL itself.
import { useEffect, useRef, useState } from 'react'
import { API } from './api'
import { chatPath } from '../app/router'
import type { ChatSummary, ThreadMsg } from '../types'

// One screenful to start; "Load more" walks the rest.
const CHAT_PAGE = 8
// Tokens arrive far faster than anyone reads, so they accumulate and land on a
// timer — one setState per token re-renders the whole thread hundreds of times
// for a single answer. This is deliberately NOT requestAnimationFrame: a
// backgrounded tab stops painting frames, and a slow local answer is exactly
// when someone switches away, so an rAF flush showed nothing at all until the
// whole answer had arrived.
const FLUSH_MS = 60
// Long enough that the caret lands after the view has settled.
const FOCUS_DELAY_MS = 60
const MAX_COMPOSER_H = 200

export function useChat(nav: string) {
  const [thread, setThread] = useState<ThreadMsg[]>([])
  const [chatId, setChatId] = useState<string | null>(null) // active server-side chat
  const [chatList, setChatList] = useState<ChatSummary[]>([]) // saved chat history (paged)
  const [chatTotal, setChatTotal] = useState(0) // how many exist server-side
  const [text, setText] = useState('')
  const [pendingImg, setPendingImg] = useState<string | null>(null)
  const [focus, setFocus] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const msgSeq = useRef(0) // ids for pending answer slots (see sendQuestion)
  const askAbort = useRef<AbortController | null>(null) // backs the composer's stop button
  const chatIdRef = useRef<string | null>(null) // live chatId for App's mount-time popstate handler

  useEffect(() => {
    chatIdRef.current = chatId
  }, [chatId])

  const autosize = () => {
    const ta = taRef.current
    if (ta) {
      ta.style.height = 'auto'
      ta.style.height = `${Math.min(ta.scrollHeight, MAX_COMPOSER_H)}px`
    }
  }
  useEffect(autosize, [text])

  // Hand the caret back so the next question is one keystroke away.
  const focusComposer = () => {
    setTimeout(() => taRef.current?.focus(), FOCUS_DELAY_MS)
  }

  // One question at a time: the composer's send button and Enter are both gated
  // on this, so a second ask can't be started while one is still in flight.
  const asking = thread.some(m => m.pending)

  // Refreshes reload however much is already on screen, so answering a question
  // doesn't collapse a list the reader had expanded.
  const loadChats = (limit = CHAT_PAGE) =>
    API.chats(limit, 0).then(({ chats, total }) => {
      setChatList(chats)
      setChatTotal(total)
    })
  const refreshChats = () => loadChats(Math.max(CHAT_PAGE, chatList.length)).catch(() => {})
  const loadMoreChats = () =>
    API.chats(CHAT_PAGE, chatList.length)
      .then(({ chats, total }) => {
        setChatTotal(total)
        // Filter by id: a chat answered since the first page shifts everything
        // down by one, which would otherwise duplicate a row across pages.
        setChatList(prev => {
          const seen = new Set(prev.map(c => c.id))
          return [...prev, ...chats.filter(c => !seen.has(c.id))]
        })
      })
      .catch(() => {})
  useEffect(() => {
    if (nav === 'core') loadChats().catch(() => {})
  }, [nav])

  // Ask: query the vault; used by the Ask (core) view composer.
  const sendQuestion = async () => {
    const raw = text.trim()
    const img = pendingImg
    if (asking || (!raw && !img)) return
    // The pending bubble is claimed by id, not by position: a reply used to be
    // written to whatever sat last in the thread, so with two asks in flight
    // the first answer back landed under the second question.
    const slot = `m${msgSeq.current++}`
    const at = Date.now()
    setThread(prev => [
      ...prev,
      { role: 'user', text: raw || '▣ image', img, ts: at },
      { role: 'ai', pending: true, id: slot, ts: at },
    ])
    setText('')
    setPendingImg(null)
    const settle = (msg: ThreadMsg) => setThread(prev => prev.map(m => (m.id === slot ? msg : m)))
    const ctl = new AbortController()
    askAbort.current = ctl
    let acc = ''
    let timer: number | undefined
    let lastFlush = 0
    const patch = (p: Partial<ThreadMsg>) => setThread(prev => prev.map(m => (m.id === slot ? { ...m, ...p } : m)))
    const flush = () => {
      timer = undefined
      lastFlush = Date.now()
      patch({ pending: false, streaming: true, lead: acc, q: raw })
    }
    // Any pending flush has to be dropped before the final patch, or it lands
    // afterwards and puts the message back into its streaming state.
    const stopFlushing = () => {
      clearTimeout(timer)
      timer = undefined
    }
    try {
      const { chatId: cid } = await API.askStream(
        { question: raw, image: img, chatId },
        {
          onSources: cited => patch({ cited }),
          onDelta: t => {
            acc += t
            if (timer !== undefined) return
            timer = window.setTimeout(flush, Math.max(0, FLUSH_MS - (Date.now() - lastFlush)))
          },
        },
        ctl.signal,
      )
      stopFlushing()
      if (cid) {
        setChatId(cid)
        // The chat only exists once the server has recorded it, so this is the
        // first moment the question has an address worth keeping.
        if (location.pathname !== chatPath(cid)) history.replaceState(null, '', chatPath(cid))
      }
      patch({ pending: false, streaming: false, lead: acc, q: raw, ts: Date.now() })
      refreshChats()
    } catch (e) {
      // A stopped answer keeps whatever it managed to say — the tokens were
      // real, and throwing them away to show "Stopped." loses information the
      // user was already reading.
      stopFlushing()
      if (ctl.signal.aborted)
        patch({ pending: false, streaming: false, lead: acc, q: raw, ts: Date.now(), stopped: true })
      else settle({ role: 'ai', id: slot, lead: `⚠ ${(e as Error).message}`, cited: [], q: raw, ts: Date.now() })
    } finally {
      if (askAbort.current === ctl) askAbort.current = null
    }
    taRef.current?.focus()
  }

  // Stop waiting on the answer in flight. The server is already generating it
  // and will still record it to the chat — this releases the composer, it does
  // not cancel the model.
  const stopAsk = () => askAbort.current?.abort()

  // Empty the composer's conversation without touching history — for the
  // caller that has already changed the URL, or is reacting to it having
  // changed (popstate).
  const clearChat = () => {
    setThread([])
    setChatId(null)
  }

  // Load a conversation into the thread without touching history — the URL is
  // either already right (popstate, deep link) or the caller has just set it.
  const showChat = async (id: string) => {
    try {
      const chat = await API.chat(id)
      let lastQ = ''
      setThread(
        chat.messages.map((m): ThreadMsg => {
          const ts = m.ts ? Date.parse(m.ts) : undefined
          if (m.role === 'user') {
            lastQ = m.text || ''
            return { role: 'user', text: m.text || '▣ image', img: m.image || null, ts }
          }
          return { role: 'ai', lead: m.text, cited: m.cited || [], q: lastQ, ts }
        }),
      )
      setChatId(chat.id)
      // Resuming a conversation puts you back at the composer, ready to continue.
      focusComposer()
    } catch {
      // Deleted or unknown id: drop back to a blank Ask rather than stranding
      // the reader on a URL that resolves to nothing.
      clearChat()
      if (location.pathname !== '/ask') history.replaceState(null, '', '/ask')
    }
  }

  const openChat = (c: ChatSummary) => {
    if (location.pathname !== chatPath(c.id)) history.pushState(null, '', chatPath(c.id))
    return showChat(c.id)
  }

  const newChat = () => {
    clearChat()
    if (location.pathname !== '/ask') history.pushState(null, '', '/ask')
    focusComposer()
  }

  // The list carries the title, so it updates locally; the server is the
  // authority on the trim/length rules and reconciles on the next fetch.
  const renameChat = (id: string, title: string) => {
    setChatList(prev => prev.map(c => (c.id === id ? { ...c, title } : c)))
    API.renameChat(id, title).then(refreshChats).catch(refreshChats)
  }

  const deleteChat = (id: string) => {
    setChatList(prev => prev.filter(c => c.id !== id))
    setChatTotal(n => Math.max(0, n - 1))
    if (id === chatId) newChat() // also drops /ask/<id> from the URL
    API.delChat(id).catch(() => {})
  }

  return {
    // composer
    text,
    setText,
    pendingImg,
    focus,
    taRef,
    asking,
    onKey: (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        sendQuestion()
      }
    },
    onFocus: () => setFocus(true),
    onBlur: () => setFocus(false),
    onImageFile: (file: File | null | undefined) => {
      if (!file) return
      const r = new FileReader()
      r.onload = () => setPendingImg(r.result as string)
      r.readAsDataURL(file)
    },
    clearImg: () => setPendingImg(null),
    focusComposer,
    // conversation
    thread,
    chatId,
    chatIdRef,
    sendQuestion,
    stopAsk,
    showChat,
    newChat,
    clearChat,
    // saved list
    chatList,
    chatTotal,
    openChat,
    loadMoreChats,
    renameChat,
    deleteChat,
  }
}
