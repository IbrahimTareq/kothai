// Notes as older versions of Kothai wrote them, brought up to the current
// shape each time notes.ts loads the library. In memory only: a row keeps its
// old shape on disk until something next rewrites the note, and every boot
// repeats the upgrade, so each step here must be idempotent.
import { deriveAiMarkers } from '../ai/backlog.ts'
import { heuristicType } from '../ai/normalise.ts'
import type { NoteRecord } from './notes.ts'

// Notes imported before `account` was a first-class field: the poster
// username only ever landed inside the title string (`@handle · Reel` /
// `@handle · Post`, see deriveNote in import/instagram.ts). Anchored to the
// exact shape deriveNote produces so it can't misfire on an unrelated title
// that merely starts with "@something".
const TITLE_ACCOUNT_RE = /^@(\S+) · (?:Reel|Post)$/
function deriveAccountFromTitle(title: unknown): string | null {
  const m = TITLE_ACCOUNT_RE.exec(String(title || ''))
  return m ? m[1] : null
}

export function upgradeLegacyNote(n: NoteRecord): void {
  // Migrate pre-residency notes: infer which AI steps already ran so the
  // enrichment backlog counts only genuinely missing work.
  n.ai = deriveAiMarkers(n)
  if (!n.account) n.account = deriveAccountFromTitle(n.title)
  // Migrate notes classified before Kothai saved links only (4c6d41f): the
  // old classifier answered "image" for Instagram reels and "text" for
  // articles, and no card renders either — each showed as an empty gap in
  // the board. They take the type a fresh save of the same URL gets. A
  // widened read, because the row predates the NoteType it is parsed as.
  const type: string = n.type
  if (type !== 'link' && type !== 'video') n.type = heuristicType(n.url || n.content)
}
