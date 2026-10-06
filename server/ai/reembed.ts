// The library re-embed: the sweep that rebuilds every stored vector, and the
// two boot-time checks that decide whether one is owed. Split out of enrich.ts
// — it shares enrichment's job queue so a sweep never races an in-flight
// enrichment, but nothing in the per-note pipeline calls back into it.
import * as store from '../data/notes.ts'
import type { NoteRecord } from '../data/notes.ts'
import * as tagvocab from '../data/tagvocab.ts'
import * as inference from './index.ts'
import * as settings from '../data/settings.ts'
import { EMBED_RECIPE } from './prompts.ts'
import { queueJob } from './enrich.ts'
import { withTrigger } from './usage.ts'

// Re-embed every note in the library, in one batched write.
//
// Two things invalidate the whole vector set: swapping the embedding model
// (a different model is a different space) and changing the recipe — the task
// prefixes, or which fields feed the input (see prompts.ts's EMBED_RECIPE).
// Both used to be handled by a loop inlined in routes/settings.ts that only
// the model-swap path could reach; it lives here now so the boot-time recipe
// check runs exactly the same code.
//
// The input mirrors enrichNote's own toEmbed assembly rather than the shorter
// title/summary/content/tags list the inlined version used. That list predated
// link enrichment and quietly dropped siteTitle, siteDesc, the article body
// and the thumbnail description — so every re-embed silently downgraded the
// library's vectors to less than the original enrichment had produced.
//
// It mirrors it, though, rather than sharing it — the two read different
// shapes (an in-flight patch there, a persisted note here).
//
// Failures are per-note: one unembeddable note must not abandon the other
// 1,700. `{ persist: false }` batches the writes into a single transaction at
// the end, exactly as before.
export function embedBodyFor(
  note: Pick<
    NoteRecord,
    'title' | 'summary' | 'content' | 'siteTitle' | 'siteDesc' | 'article' | 'thumbDescription' | 'tags'
  >,
) {
  return [
    note.title,
    note.summary,
    note.content,
    note.siteTitle,
    note.siteDesc,
    note.article,
    note.thumbDescription,
    (note.tags || []).join(' '),
  ]
    .filter(Boolean)
    .join('\n')
}

// Labelled here, not at its callers: a settings change, an endpoint swap, a
// recipe bump and a restore all re-embed through this, and all of it is
// re-embedding as far as the usage panel is concerned.
export function reembedAll(reason = 'settings') {
  return withTrigger('reembed', () => reembedEach(reason))
}

async function reembedEach(reason: string) {
  const notes = store.allNotes()
  console.log(`[enrich] re-embedding ${notes.length} notes (${reason})…`)
  for (const n of notes) {
    try {
      const body = embedBodyFor(n)
      if (body) {
        await store.updateNote(n.id, { embedding: await inference.embedText(body) }, { persist: false })
      }
    } catch (e) {
      console.error('[enrich] re-embed failed for', n.id, '-', e instanceof Error ? e.message : e)
    }
  }
  await store.flush() // one write for the whole batch, not one per note
  await settings.save({ embedRecipe: EMBED_RECIPE })
  // Tag snapping compares each new tag's vector against the registry's, so the
  // registry has to move to the new model too: left on the old one, every
  // comparison scored 0 (different width) or noise (same width), and new tags
  // either never snapped or snapped to the wrong one. Reseeded from the notes,
  // the same way first boot builds it. A failure is logged rather than thrown
  // so the notes' markers above still stand; the emptied table is what makes
  // the next boot reseed it (see hadTagRegistry in server/index.ts).
  try {
    await tagvocab.clearAll()
    await tagvocab.rebuildFromNotes(notes)
  } catch (e) {
    console.error('[enrich] tag registry re-embed failed -', e instanceof Error ? e.message : e)
  }
  console.log('[enrich] re-embedding done')
  return notes.length
}

// Queue a full re-embed when the stored vectors were built under a different
// recipe than the one this build uses — called once at boot. Returns whether
// anything was queued, so index.ts can say so.
//
// Deliberately silent when the embed role is off: with no embedding model
// there is nothing to re-embed, and recording the new recipe anyway would
// mean the sweep never runs once the role IS switched on. Leaving the marker
// stale is the self-healing choice, the same call every AI marker in this
// file makes.
export function queueRecipeReembed() {
  if (settings.getResidency().embed === 'off') return false
  if (settings.getEmbedRecipe() === EMBED_RECIPE) return false
  if (!store.count()) {
    settings.save({ embedRecipe: EMBED_RECIPE }).catch(() => {})
    return false
  }
  queueJob(() => reembedAll(`recipe ${settings.getEmbedRecipe() || 'unset'} → ${EMBED_RECIPE}`))
  return true
}

// Did the embedding role change provider since the last boot? Pure so the
// inference for installs that predate the marker is testable on its own.
export function embedProviderChanged({
  stored,
  resolved,
  wasRemote,
}: {
  stored: string | null
  resolved: string
  wasRemote: boolean
}) {
  const previous = stored || (wasRemote ? 'remote' : 'local')
  return previous !== resolved
}

// Queue a full re-embed when the embedding role has changed hands — an
// on-device model and an endpoint's model produce vectors in different
// spaces, and a library holding both answers every query badly. Same guards
// as queueRecipeReembed, in the same order: the role being off comes first,
// and an empty library just records the new value.
export function queueEmbedProviderReembed({ resolved, wasRemote }: { resolved: string; wasRemote: boolean }) {
  // Nothing has been embedded with anything, so there is nothing to compare
  // and nothing to record — the same self-healing choice queueRecipeReembed
  // makes when the role is off.
  if (settings.getResidency().embed === 'off') return false

  const stored = settings.getEmbedProvider()
  if (!embedProviderChanged({ stored, resolved, wasRemote })) {
    // Record the inference the first time it is made. Without this, an install
    // whose marker is still null re-derives "what it was doing" from the
    // current environment on every boot, so a later wholesale KOTHAI_AI_PROVIDER
    // flip is measured against the new value and looks like no change at all —
    // and the library keeps serving vectors from a model it no longer runs.
    if (!stored) settings.save({ embedProvider: resolved }).catch(() => {})
    return false
  }

  if (!store.count()) {
    settings.save({ embedProvider: resolved }).catch(() => {})
    return false
  }
  queueJob(async () => {
    await reembedAll(`embed provider ${stored || (wasRemote ? 'remote' : 'local')} → ${resolved}`)
    await settings.save({ embedProvider: resolved })
  })
  return true
}
