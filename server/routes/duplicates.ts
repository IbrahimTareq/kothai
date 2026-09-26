// GET /api/duplicates — notes that point at the same link, for Settings to
// flag. Only the importer refuses a link that is already saved; /api/save and
// Telegram store whatever arrives, so a link pasted twice is two notes.
//
// Read-only on purpose: which copy to keep is the user's call (one may carry
// the tags, mind note or spaces), so removal goes through the ordinary
// per-note delete.
import type { ServerResponse } from 'node:http'
import * as store from '../data/notes.ts'
import { canonicalUrl } from '../links/canonical.ts'
import { json } from '../lib/http.ts'

export function handleDuplicates(res: ServerResponse) {
  const byKey = new Map<string, { id: string; title: string; url: string; createdAt: string }[]>()
  for (const n of store.allNotes()) {
    if (!n.url) continue
    const key = canonicalUrl(n.url)
    const group = byKey.get(key) ?? []
    group.push({ id: n.id, title: n.title, url: n.url, createdAt: n.createdAt })
    byKey.set(key, group)
  }
  const groups = [...byKey.values()]
    .filter(g => g.length > 1)
    .map(g => g.sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
  json(res, 200, { groups })
}
