// Capture.tsx — Kothai's global quick-capture modal. Owns its own input state so
// it's fully decoupled from the Ask composer; calls onSave to persist, and closes
// on success, Esc, or backdrop click. Success is confirmed by the capture button
// underneath (App.tsx's `captured`), so the only thing this reports is failure —
// inline, over the input the user still has to retry from.
import { useRef, useState } from 'react'
import { Icon, CAT } from './icons'
import { detectType } from '../domain/detect'
import type { Detection } from '../types'
import { Dialog } from '../ui/Dialog'
import { useDemo } from './Demo'

interface CaptureModalProps {
  onClose: () => void
  // Resolves to null on success, or the failure message to show inline.
  onSave: (text: string) => Promise<string | null>
}

export function CaptureModal({ onClose, onSave }: CaptureModalProps) {
  const [text, setText] = useState('')
  const [closing, setClosing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  // detectType applies the server's own link test, so a chip here is exactly
  // what /api/save will accept — Save is never offered for input it refuses.
  const chip: Detection | null = detectType(text)

  const demo = useDemo()
  const hint =
    demo?.savesLeft === 0
      ? 'That’s all the demo saves today.'
      : text.trim() && !chip
        ? 'Kothai saves links: paste one starting with https://'
        : null
  const canSave = !!chip && !hint

  // Play the exit animation, then unmount. Matches the .16s cap-out CSS duration.
  const close = () => {
    setClosing(true)
    window.setTimeout(onClose, 160)
  }

  const save = async () => {
    const raw = text.trim()
    if (!canSave || saving) return
    setSaving(true)
    setError(null)
    const err = await onSave(raw)
    setSaving(false)
    if (err)
      setError(err) // on failure, keep the modal + input so nothing is lost
    else close()
  }

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      save()
    }
  }

  return (
    // Escape and an outside press ask <Dialog> to close; close() plays the exit
    // animation first and unmounts after it.
    <Dialog
      title="Capture"
      initialFocus={taRef}
      onClose={close}
      overlayClassName={`cap-overlay${closing ? ' closing' : ''}`}
      className="cap-modal"
    >
      <div className={`input-shell${text ? ' focus' : ''}`}>
        <textarea
          ref={taRef}
          rows={1}
          value={text}
          placeholder="Paste a link…"
          onChange={e => {
            setText(e.target.value)
            if (error) setError(null)
          }}
          onKeyDown={onKey}
        />
        {chip && (
          <span className="detect-chip">
            <Icon name={CAT[chip.type].glyph} size={12} /> {CAT[chip.type].label.replace(/s$/, '').toUpperCase()}
          </span>
        )}
        {/* Named as Ask's is: it is icon-only, and had no name at all, so a
              screen reader announced a bare "button". */}
        <button className="send-btn" aria-label="Save" title="Save" disabled={!canSave || saving} onClick={save}>
          <Icon name="send" size={18} />
        </button>
      </div>
      {error && (
        <div className="cap-error mono" role="alert">
          {error}
        </div>
      )}
      {!error && hint && <div className="cap-hint mono">{hint}</div>}
    </Dialog>
  )
}
