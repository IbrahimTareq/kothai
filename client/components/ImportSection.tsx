// The Import section of Settings: one row per platform Kothai can import
// from. Sources are separate rows rather than a single "drop your export"
// box because the platforms genuinely differ — Instagram exports JSON, a
// Twitter/X archive is .js files, TikTok is one big user_data.json — so each
// needs its own accepted file types, its own "here's where the export button
// lives" instructions, and its own parser on the server. A shared target
// would have to accept the union of all of them and then guess.
//
// Each row owns its own import state, so a failed Instagram import doesn't
// blank out a result sitting under another source. Adding a platform is an
// entry in IMPORT_SOURCES (client/domain/importFile.ts), a block of
// instructions below, and a parser in server/import/.
import { useState, useRef } from 'react'
import type { ChangeEvent, DragEvent, ReactNode } from 'react'
import { SettingsGroup, SettingsRow } from './SettingsRow'
import { API } from '../data/api'
import { IMPORT_SOURCES, validateImportFiles, type ImportSource } from '../domain/importFile'

type ImportResult = Awaited<ReturnType<typeof API.importFile>>

// Keyed by source id. Kept here rather than in the pure descriptor module so
// that stays free of JSX and unit-testable without a DOM.
const INSTRUCTIONS: Record<string, ReactNode> = {
  instagram: (
    <>
      Accounts Center → Your information and permissions → Export your information → format <b>JSON</b>.
      Drop <code>saved_posts.json</code> and <code>saved_collections.json</code> together — your collections
      become spaces — or the whole ZIP. Posts and collections can also be imported separately, in either order.
    </>
  ),
}

export function ImportSection() {
  return (
    <SettingsGroup label="IMPORT" sub={<>Bring across what you've already saved elsewhere. Every platform exports differently, so each has its own steps.</>}>
      <div className="settings-rows">
        {IMPORT_SOURCES.map((source) => <ImportSourceRow key={source.id} source={source} />)}
      </div>
    </SettingsGroup>
  )
}

function ImportSourceRow({ source }: { source: ImportSource }) {
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  // dragenter/dragleave fire for every child element the pointer crosses, so
  // a plain boolean flickers off as soon as the cursor moves over the row's
  // text. Counting enters against leaves is what keeps the state stable.
  const dragDepth = useRef(0)

  // Only clear a prior error/result once we have a new one to show, so a
  // failed import doesn't quietly vanish and the file input can be re-picked
  // without losing what happened last time.
  const importPost = async (files: File[]) => {
    setImporting(true)
    setError(null)
    try {
      const payload = await Promise.all(files.map(async (file) => ({
        name: file.name,
        data: await readAsDataUrl(file),
      })))
      setResult(await API.importFile({ source: source.id, files: payload }))
    } catch (e) {
      const err = e instanceof Error ? (e as Error & { code?: string }) : null
      setError(
        err?.code === 'import_in_progress' ? 'Another import is already running — wait for it to finish.'
        : err?.code === 'import_rolled_back' ? 'Nothing was saved — the disk write failed. Try again.'
        : err?.message || 'Import failed — check the server and try again.',
      )
      setResult(null)
    }
    setImporting(false)
  }

  // One gate for both entry points (picker and drop) — see domain/importFile.ts.
  // A dropped file has been through no `accept` filter at all, so the checks
  // have to run in code, not just on the input.
  const acceptFiles = (files: File[]) => {
    const reason = validateImportFiles(files, source)
    if (reason) {
      setError(reason)
      setResult(null)
      return
    }
    importPost(files)
  }

  const onFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files || [])]
    e.target.value = '' // allow re-picking the same file
    if (files.length) acceptFiles(files)
  }

  // Drag-and-drop onto the same target as the picker. preventDefault on
  // dragover is what actually makes an element a drop target; without it the
  // browser navigates away to the dropped file, losing the whole page.
  const endDrag = () => { dragDepth.current = 0; setDragging(false) }
  const onDragEnter = (e: DragEvent) => {
    if (importing) return
    e.preventDefault()
    dragDepth.current++
    setDragging(true)
  }
  const onDragOver = (e: DragEvent) => {
    if (importing) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy' // show a copy cursor, not the default "move"
  }
  const onDragLeave = () => {
    if (--dragDepth.current <= 0) endDrag()
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    endDrag()
    if (importing) return
    // Every dropped file goes in one request — an export's posts and
    // collections files belong together, and taking only the first is how
    // collections used to get silently dropped.
    const files = [...(e.dataTransfer.files || [])]
    if (files.length) acceptFiles(files)
  }

  return (
    <SettingsRow title={source.label}
      desc={INSTRUCTIONS[source.id] || <>Drop this platform's export files here, or choose them.</>}
      data-drag={dragging || undefined}
      onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
      action={
        <label className="row-btn import-pick" aria-disabled={importing}>
          <input type="file" multiple accept={source.accept} disabled={importing} onChange={onFileChange} />
          <span aria-live="polite">
            {importing ? 'Importing…' : dragging ? 'Drop to import' : 'Choose files'}
          </span>
        </label>
      }>
      {result && (
        <div className="settings-row-extra">
          <div className="import-result" role="status" aria-live="polite">
            <div>{summarizeImport(result)}</div>
            {result.warnings.length > 0 && (
              <ul className="import-warnings">
                {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            )}
          </div>
        </div>
      )}
      {error && (
        <div className="settings-row-extra">
          <div className="import-error" role="status" aria-live="polite">{error}</div>
        </div>
      )}
    </SettingsRow>
  )
}

// Reading a huge file this way holds 2-3 live copies (raw file + base64
// string + the JSON.stringify copy) in memory, which is why
// validateImportFiles runs on size BEFORE anything gets here.
function readAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('Could not read that file.'))
    }
    reader.onerror = () => reject(reader.error || new Error('Could not read that file.'))
    reader.readAsDataURL(file)
  })
}

// One honest sentence from all four counters — never a copy branch whose
// truth depends on the server also having sent a warning. imported === 0 is
// only "nothing new" when skipped/failed are also 0 (a genuinely empty
// export); otherwise it must still say what happened (skips, failures).
// A collections-only import legitimately imports nothing while still
// updating spaces, so that case gets its own sentence rather than claiming
// the export was empty.
function summarizeImport(r: ImportResult) {
  if (r.imported === 0 && r.skipped === 0 && r.failed === 0) {
    return r.collections > 0
      ? `No new posts, ${r.collections} space${r.collections === 1 ? '' : 's'} updated.`
      : 'That export had no saved posts to import.'
  }
  const parts: string[] = [`Imported ${r.imported} post${r.imported === 1 ? '' : 's'}`]
  if (r.skipped > 0) parts.push(`skipped ${r.skipped} already saved`)
  if (r.collections > 0) parts.push(`${r.collections} space${r.collections === 1 ? '' : 's'} updated`)
  let s = parts.join(', ')
  if (r.failed > 0) s += `, ${r.failed} failed`
  return s + '.'
}
