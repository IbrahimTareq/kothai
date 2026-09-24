// Pure helpers deciding which AI enrichment steps a note still needs under the
// current residency map. Used to gate enrichment, count the settings backlog,
// and migrate pre-residency notes to `ai` markers. No I/O, no SDK.

import type { Residency } from './roles.ts'

// The markers a note carries once a step has run against it. `thumbVision` is
// written but deliberately not trusted — see the note on stepsFor below.
export interface AiMarkers {
  classify?: boolean
  embed?: boolean
  thumbVision?: boolean
  // Written and read by ai/enrich.ts and routes/notes.ts; nothing in this file
  // gates on them. Declared here regardless because `ai` is a single object on
  // disk — omitting them would not make them go away, it would only make every
  // honest write of one a type error at its call site and leave this interface
  // quietly describing less than the field actually holds.
  captions?: boolean
  igReclassified?: boolean
  tagsEdited?: boolean
  embedRecipe?: string
}

// Only the fields these helpers actually read. Narrower than ServerNote on
// purpose: every caller passes a full note, but nothing here should be able to
// reach for a field it has no business gating on.
export interface BacklogNote {
  ai?: AiMarkers
  thumb?: string | null
  thumbDescription?: string | null
  embedding?: Float32Array | number[] | null
}

export type Step = 'thumbVision' | 'classify' | 'embed'

// Steps a note needs: the role must be enabled (not off) and the note must not
// already carry that step's marker.
//
// `thumbVision` is the odd one out: it is keyed on the ARTIFACT (a thumbnail
// with no description) rather than on a marker. It has to be, because the
// population that needs it most is precisely the one whose marker lies — notes
// described back when the description was thrown away instead of stored. Those
// carry ai.thumbVision: true with nothing to show for it, and no
// marker-based check can tell them apart from a note that is genuinely done.
//
// This belongs in the BACKLOG rather than in a boot sweep. It is a vision
// inference per note and a real library has thousands of them; queued
// automatically at startup it would occupy the single enrichment FIFO for
// hours, starving every note the user saved in the meantime. Routing it here
// instead means it is counted in the Settings backlog and runs when the user
// asks for it — which is exactly what that button is for.
export function stepsFor(note: BacklogNote, residency: Residency): Step[] {
  const done = note.ai || {}
  const steps: Step[] = []
  if (residency.vision !== 'off' && note.thumb && !note.thumbDescription) steps.push('thumbVision')
  if (residency.llm !== 'off' && !done.classify) steps.push('classify')
  if (residency.embed !== 'off' && !done.embed) steps.push('embed')
  return steps
}

export function backlogCount(notes: BacklogNote[], residency: Residency): number {
  return notes.filter(n => stepsFor(n, residency).length > 0).length
}

// One-time migration for notes saved before `ai` markers existed: infer each
// marker from the artifact its step leaves behind. Runs in notes.load().
//
// classify is deliberately NEVER inferred here: no field in the data model
// reliably signals "classify succeeded" in isolation. category defaults to
// 'General' at note creation, summary was also set by the vision step on an
// attached image (before capture went links-only), tags can be set by manual
// edits, and embedding is written by three independent
// paths — the classify+embed pipeline, a manual tag-edit re-embed, and a
// settings embedding-model-switch re-embed — only the first of which is
// classify-gated. A false positive here permanently hides a note from
// re-classification; a false negative just costs one redundant (self-healing)
// classify pass on the next enrichment run — so every pre-migration note is
// classified once rather than risk silently losing some forever.
export function deriveAiMarkers(note: BacklogNote): AiMarkers {
  if (note.ai) return note.ai
  const ai: AiMarkers = {}
  // Length, not Array.isArray: embeddings load from SQLite as a Float32Array
  // (see data/notes.ts). An isArray check would read every stored vector as
  // absent and re-embed the entire library on every boot, forever.
  if (note.embedding?.length) ai.embed = true
  return ai
}
