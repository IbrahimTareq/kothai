// Filing an import's collections into Spaces. Split out of the import route so
// every importer's collections go through one block and the smart-Space mirror
// is named after the platform that sent them.
import * as collections from '../data/collections.ts'
import type { ParsedExport } from './index.ts'
import { canonicalUrl } from '../links/canonical.ts'

// What collections.all()/create() hand back. Named so the name index below
// and its fallback lookup can both spell it without repeating the derivation.
type Space = Awaited<ReturnType<typeof collections.create>>

// Mirror imported collections → Spaces: match by name (case-insensitive),
// create what's missing, file members in. Members resolve through `urlIndex`,
// NOT from the notes added this run — a re-import where the post already
// exists (skipped as a duplicate) but now carries a collection it didn't
// before (the user added it to a collection since the last export) must still
// file the EXISTING note into that Space; filtering to only newly-added notes
// would mean collections can never sync after the very first import.
export async function fileIntoSpaces(
  parsedCollections: ParsedExport['collections'],
  urlIndex: Map<string, string>,
  label: string,
): Promise<{ touched: number; unresolved: number }> {
  // Hoisted out of the loop: collections.all() is O(collections), and
  // calling it (plus an O(collections) .find()) once per collection
  // name is the same O(names × spaces) shape server/import/instagram.ts's
  // own parse() was rewritten to avoid for hrefs — do the same here with a
  // lowercase-name index, kept up to date as new Spaces get created below.
  //
  // On a name COLLISION, prefer a PLAIN Space over a smart one. all() is
  // newest-first (collections.create() unshifts), so a naive "last one
  // wins" build of this index hands back whichever of the two is OLDER —
  // and since the smart branch below refuses to touch a smart Space and
  // creates a fresh "<name> (<label>)" mirror instead, an index that
  // keeps re-resolving back to the smart Space would mint a BRAND NEW
  // mirror on every single re-import, forever. Explicitly preferring the
  // plain one breaks that: once a mirror exists, it's plain, so it wins
  // the tie on every subsequent run.
  const spaceByLowerName = new Map<string, Space>()
  for (const c of collections.all()) {
    const key = c.name.toLowerCase()
    const prev = spaceByLowerName.get(key)
    if (!prev || (prev.tags?.length && !c.tags?.length)) spaceByLowerName.set(key, c)
  }
  // Creating a Space and indexing it under its own name are one step, never
  // one without the other — both branches below used to write the pair out
  // by hand, which is one place for the index to silently go stale.
  const ensureSpace = async (n: string) => {
    const created = await collections.create({ name: n })
    spaceByLowerName.set(created.name.toLowerCase(), created)
    return created
  }
  // Members are resolved from each collection's OWN urls, through the same
  // canonical-url index the route uses for dedup — which is seeded from every
  // note already in the database, then extended with the ones added by
  // this run. That is what makes the three orders equivalent: both files
  // dropped together, posts first and collections next week, or a
  // collections file whose posts were already saved by hand. Resolving
  // from `items` instead (what this did before) quietly worked only in
  // the first case, creating empty Spaces — or none — in the others.
  const membersByName = new Map<string, Set<string>>() // collection name -> Set<noteId>
  const unresolved = new Set<string>() // canonical urls naming a post we don't have — reported, not silently dropped
  for (const entry of parsedCollections) {
    // A future importer mis-shaping an entry must not throw into the
    // generic 500, same guard as items/parsedCollections above.
    const name = entry && typeof entry.name === 'string' ? entry.name : null
    if (!name) continue
    const urls = Array.isArray(entry?.urls) ? entry.urls : []
    let set = membersByName.get(name)
    if (!set) {
      set = new Set()
      membersByName.set(name, set)
    }
    for (const url of urls) {
      const c = canonicalUrl(url)
      if (!c) continue
      const noteId = urlIndex.get(c)
      if (noteId) set.add(noteId)
      else unresolved.add(c) // not imported and not already saved — counted once per post, however many collections it sits in
    }
  }
  const touchedSpaceIds = new Set<string>() // dedups by Space, not by collection name — two names CAN resolve to the same Space
  for (const [name, members] of membersByName) {
    if (!members.size) continue
    let space: Space | null = spaceByLowerName.get(name.toLowerCase()) || null
    // A matched Space with a tag rule is a SMART collection: reusing it
    // here would (a) file unrelated posts into a Space the user built
    // around a rule, not an imported grouping, and (b) collections.addItem's
    // attach() clears removedIds — silently resurrecting items the user
    // deliberately hand-removed from it. Route imported collections into a
    // distinct, clearly-labeled Space instead of ever touching a smart one.
    if (space?.tags?.length) {
      const altName = `${name} (${label})`
      let altSpace: Space | null = spaceByLowerName.get(altName.toLowerCase()) || null
      // The fallback name itself could ALSO collide with a user's own
      // smart Space (e.g. one literally named "Recipes (Instagram)") —
      // re-check rather than trusting a name match alone, same reasoning
      // as above. In that (rare) case, create a fresh Space anyway rather
      // than touching either smart one.
      if (altSpace?.tags?.length) altSpace = null
      space = altSpace
      if (!space) space = await ensureSpace(altName)
    } else if (!space) {
      space = await ensureSpace(name)
    }
    // Skip ids already filed (a no-op re-import would otherwise cost one
    // addItem — one collections-table row write — per membership, EVERY
    // time) and ids the user deliberately hand-removed from a PLAIN
    // Space (addItem's attach() clears removedIds unconditionally, which
    // would silently resurrect them on every re-import — the manual-
    // removal analog of the smart-Space guard above). `space.itemIds`/
    // `removedIds` are the SAME array instances the real store mutates in
    // place (collections.all()'s withCount() only shallow-copies the
    // record, not its arrays), so if two collection names happen to
    // resolve to the very same existing Space within one run, the second
    // one still sees whatever the first one just added — no double-write.
    const known = new Set(space.itemIds || [])
    const removedHere = new Set(space.removedIds || [])
    const toAdd = []
    for (const id of members) {
      if (known.has(id) || removedHere.has(id)) continue
      toAdd.push(id)
      known.add(id) // keep the local view current: two names can resolve to the same Space within one run
    }
    // One row write for the whole Space instead of one per membership —
    // see collections.addItems for what that was costing.
    if (toAdd.length) {
      await collections.addItems(space.id, toAdd)
      touchedSpaceIds.add(space.id)
    }
  }
  return { touched: touchedSpaceIds.size, unresolved: unresolved.size }
}
