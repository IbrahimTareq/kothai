// Importer registry. Each importer exports { name, sniff(files), parse(files),
// deriveNote(item) } over a Map<entryName, Buffer> of uploaded files. One
// entry today; TikTok / Twitter / Pocket importers slot in here without
// touching the route, and the client's per-source Import sections address
// them by `name`.
import * as instagram from './instagram.js'

const IMPORTERS = [instagram]

// Exact-name lookup, used when the upload names its source (each Import
// sub-section in Settings knows which platform it is). Selecting by name
// rather than by sniffing lets the route say "that isn't an Instagram
// export" instead of the generic "not a recognized export" — which is the
// difference between a useful error and a dead end once several platforms'
// exports are all just "some JSON files".
export function getImporter(name) {
  return IMPORTERS.find((i) => i.name === name) || null
}

// The source names the UI may send, so the route can reject an unknown one
// without leaking module internals.
export function importerNames() {
  return IMPORTERS.map((i) => i.name)
}

export function findImporter(files) {
  for (const importer of IMPORTERS) {
    // files comes straight from an untrusted upload (see server/lib/zip.js);
    // a future importer's sniff() poking at attacker-controlled names/content
    // could throw on a shape it didn't expect. One misbehaving importer must
    // not take down detection for the whole route — skip it and keep looking,
    // same posture as parse()'s per-file try/catch in instagram.js.
    try {
      if (importer.sniff(files)) return importer
    } catch {
      continue
    }
  }
  return null
}
