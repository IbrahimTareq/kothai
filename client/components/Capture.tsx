// Capture.tsx — Kothai's global quick-capture modal. Owns its own input state so
// it's fully decoupled from the Ask composer; calls onSave to persist, and closes
// on success, Esc, or backdrop click. Success is confirmed by the capture button
// underneath (App.tsx's `captured`), so the only thing this reports is failure —
// inline, over the input the user still has to retry from.
import { useEffect, useRef, useState } from 'react'
import { Icon, CAT } from './icons'
import { detectType } from '../domain/detect'
import type { Detection } from '../types'

interface CaptureModalProps {
  onClose: () => void
  // Resolves to null on success, or the failure message to show inline.
  onSave: (text: string, image: string | null) => Promise<string | null>
}

export function CaptureModal({ onClose, onSave }: CaptureModalProps) {
  const [text, setText] = useState('')
  const [pendingImg, setPendingImg] = useState<string | null>(null)
  const [closing, setClosing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const detected: Detection | null = text.trim() ? detectType(text) : null
  const chip: Detection | null = detected || (pendingImg ? { type: 'image' } : null)

  // Play the exit animation, then unmount. Matches the .16s cap-out CSS duration.
  const close = () => { setClosing(true); window.setTimeout(onClose, 160) }

  // autofocus the textarea when the modal opens
  useEffect(() => { taRef.current?.focus() }, [])
  // Esc closes the overlay
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const onImageFile = (file: File | null | undefined) => {
    if (!file) return
    const r = new FileReader(); r.onload = () => setPendingImg(r.result as string); r.readAsDataURL(file)
  }

  const save = async () => {
    const raw = text.trim()
    if ((!raw && !pendingImg) || saving) return
    setSaving(true); setError(null)
    const err = await onSave(raw, pendingImg)
    setSaving(false)
    if (err) setError(err)   // on failure, keep the modal + input so nothing is lost
    else close()
  }

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save() }
  }

  return (
    <div className={'cap-overlay' + (closing ? ' closing' : '')} onClick={close}>
      <div className="cap-modal" onClick={(e) => e.stopPropagation()}>
        <div className={'input-shell' + (text || pendingImg ? ' focus' : '')}>
          {pendingImg && (
            <span className="attach-preview">
              <img src={pendingImg} alt="attachment" />
              <button className="attach-x" title="remove" onClick={() => setPendingImg(null)}>✕</button>
            </span>
          )}
          <textarea ref={taRef} rows={1} value={text} placeholder="Drop a link, note, or code…"
            onChange={(e) => { setText(e.target.value); if (error) setError(null) }} onKeyDown={onKey}
            onPaste={(e) => { const it = Array.from(e.clipboardData?.items || []).find((x) => x.type.startsWith('image/')); if (it) { e.preventDefault(); onImageFile(it.getAsFile()) } }} />
          {chip && (
            <span className="detect-chip"><Icon name={CAT[chip.type].glyph} size={12} /> {CAT[chip.type].label.replace(/s$/, '').toUpperCase()}{chip.lang ? ' · ' + chip.lang.toUpperCase() : ''}</span>
          )}
          <input type="file" accept="image/*" ref={fileRef} style={{ display: 'none' }} onChange={(e) => { onImageFile(e.target.files?.[0]); e.target.value = '' }} />
          <button className="attach-btn" title="attach image" onClick={() => fileRef.current && fileRef.current.click()}>
            <Icon name="image" size={17} />
          </button>
          <button className="send-btn" disabled={(!text.trim() && !pendingImg) || saving} onClick={save}>
            <Icon name="send" size={18} />
          </button>
        </div>
        {error && <div className="cap-error mono" role="alert">{error}</div>}
      </div>
    </div>
  )
}
