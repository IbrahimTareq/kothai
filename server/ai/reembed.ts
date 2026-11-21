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
import { RemoteError } from './providers/remote-http.ts'
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
// A note the endpoint refuses must not abandon the other 1,700; an endpoint
// that is down ends the sweep (see reembedEach). `{ persist: false }` batches
// the writes into a single transaction at the end, exactly as before.
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
  // A note the endpoint refuses (400) is that note's failure; anything else
  // (down, rate-limited, bad key, the circuit open) is the endpoint's, and
  // stops the sweep rather than send the rest of the library at it.
  let embedded = 0
  let stopped = false
  const refused: string[] = []
  for (const n of notes) {
    const body = embedBodyFor(n)
    if (!body) continue
    try {
      await store.updateNote(n.id, { embedding: await inference.embedText(body) }, { persist: false })
      embedded++
    } catch (e) {
      console.error('[enrich] re-embed failed for', n.id, '-', e instanceof Error ? e.message : e)
      if (e instanceof RemoteError && e.code === 'bad_request') refused.push(n.id)
      else {
        stopped = true
        break
      }
    }
  }
  // Every note refused is the model, not the notes (a chat model named for
  // embeddings 400s on everything), and is handled as the endpoint's failure.
  // Otherwise a refused note loses its old vector: left on it, an on-device
  // vector was ranked against the endpoint's query vectors. Keyword search
  // still finds it.
  const finished = !stopped && (embedded > 0 || !refused.length)
  if (finished) for (const id of refused) await store.updateNote(id, { embedding: null }, { persist: false })
  await store.flush() // one write for the whole batch, not one per note
  // An unfinished sweep leaves the provider marker, so an upgrading library
  // is retried at the next boot or reconnect; marking it anyway labelled its
  // on-device vectors 'remote'. The recipe marker is cleared rather than left,
  // because a library already 'remote' whose model changed has no other marker
  // saying it still owes a sweep, and boot's recipe check is what retries it.
  if (!finished) {
    console.error('[enrich] re-embed stopped; the library is marked as still owing one')
    await settings.save({ embedRecipe: null })
    return notes.length
  }
  // The provider marker moves here, once the vectors exist, and on every path
  // that rebuilds them: recorded only by the boot check, a Settings-triggered
  // re-embed of a QVAC library left the marker on 'local', and the next boot
  // re-embedded the whole library again through a possibly paid endpoint.
  // After the flush, so an interrupted sweep is retried on the next boot.
  await settings.save({ embedRecipe: EMBED_RECIPE, embedProvider: 'remote' })
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
  if (!inference.roleEnabled('embed')) return false
  if (settings.getEmbedRecipe() === EMBED_RECIPE) return false
  if (!store.count()) {
    settings.save({ embedRecipe: EMBED_RECIPE }).catch(() => {})
    return false
  }
  queueSweep(`recipe ${settings.getEmbedRecipe() || 'unset'} → ${EMBED_RECIPE}`)
  return true
}

// The sweep a stale marker asks for, queued at most once until it has run.
// Boot, the end of first run and every recovery of the endpoint ask, and a
// circuit that flaps recovers several times while the first sweep still waits
// its turn: each would have queued the whole library again behind it.
let owed: Promise<unknown> | null = null
function queueSweep(reason: string) {
  if (owed) return
  owed = queueJob(() => reembedAll(reason)).finally(() => {
    owed = null
  })
}

// Does the library owe a sweep? Asked at boot, at the end of first run (where
// an empty library is simply marked), and when the endpoint recovers: a sweep
// an outage stopped keeps its markers stale, and before the recovery asked,
// only a reboot or a reconnect retried it. The provider check runs only when
// the recipe one queued nothing: the recipe sweep records both markers, and an
// unfinished one leaves both stale, which queued the whole library twice.
export function queueOwedReembed(): boolean {
  return queueRecipeReembed() || queueEmbedProviderReembed()
}

// Were the stored vectors made anywhere but an endpoint? 'local' marks
// vectors from the removed on-device provider, and null an install that
// predates the marker; either way they sit in another space than the
// endpoint's model, and a library holding both answers every query badly.
export function embedProviderChanged(stored: string | null): boolean {
  return stored !== 'remote'
}

// Queue a full re-embed when the stored vectors did not come from an endpoint.
// Same guards as queueRecipeReembed, in the same order: the role being off
// comes first, and an empty library just records the new value.
export function queueEmbedProviderReembed() {
  // Nothing has been embedded with anything, so there is nothing to compare
  // and nothing to record — the same self-healing choice queueRecipeReembed
  // makes when the role is off.
  if (!inference.roleEnabled('embed')) return false

  const stored = settings.getEmbedProvider()
  if (!embedProviderChanged(stored)) return false

  if (!store.count()) {
    settings.save({ embedProvider: 'remote' }).catch(() => {})
    return false
  }
  // reembedAll records the marker itself, once the sweep is done.
  queueSweep(`embed provider ${stored || 'unset'} → remote`)
  return true
}
