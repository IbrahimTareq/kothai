// Importer registry. Each importer exports { name, sniff(files), parse(files),
// deriveNote(item) } over a Map<entryName, Buffer> of uploaded files. Instagram
// and TikTok today; another importer slots in here without touching the
// route, and the client's per-source Import sections address
// them by `name`.
import type { ServerNote } from '../types.ts'
import * as instagram from './instagram.ts'
import * as tiktok from './tiktok.ts'

// The contract the header above describes in prose, written down — because
// `[instagram, tiktok]` on its own types the registry as a UNION of the two
// module namespaces, and a union of call signatures is only callable with the
// INTERSECTION of its parameter types. deriveNote's per-importer item type
// makes that intersection uninhabitable (`savedAt` is `number` in one and
// `number | string` in the other), so the route could not call deriveNote at
// all. Naming the contract once collapses the union back to one type, and a
// third importer now has something to conform to rather than something to
// guess at.
//
// Each importer keeps its OWN, narrower item/result types for its internals;
// these are the widened shapes the registry hands across the boundary.
interface ImportItem {
  url: string
  poster: string
  savedAt: number | string
}
export interface ParsedExport {
  items: ImportItem[]
  collections: { name: string; urls: string[] }[]
  warnings: string[]
}
export interface Importer {
  name: string
  // Shown by the route when an upload doesn't match — see instagram.ts.
  label: string
  expects: string
  sniff(files: Map<string, Buffer>): boolean
  parse(files: Map<string, Buffer>): ParsedExport
  deriveNote(item: ImportItem): Partial<ServerNote>
}

const IMPORTERS: Importer[] = [instagram, tiktok]

// Exact-name lookup, used when the upload names its source (each Import
// sub-section in Settings knows which platform it is). Selecting by name
// rather than by sniffing lets the route say "that isn't an Instagram
// export" instead of the generic "not a recognized export" — which is the
// difference between a useful error and a dead end once several platforms'
// exports are all just "some JSON files".
export function getImporter(name: string) {
  return IMPORTERS.find(i => i.name === name) || null
}

// The source names the UI may send, so the route can reject an unknown one
// without leaking module internals.
export function importerNames(): string[] {
  return IMPORTERS.map(i => i.name)
}

export function findImporter(files: Map<string, Buffer>) {
  for (const importer of IMPORTERS) {
    // files comes straight from an untrusted upload (see server/lib/zip.ts);
    // a future importer's sniff() poking at attacker-controlled names/content
    // could throw on a shape it didn't expect. One misbehaving importer must
    // not take down detection for the whole route — skip it and keep looking,
    // same posture as parse()'s per-file try/catch in instagram.ts.
    try {
      if (importer.sniff(files)) return importer
    } catch {}
  }
  return null
}
