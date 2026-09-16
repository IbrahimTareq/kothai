// GET /api/export — a full backup of your data as one downloadable JSON file:
// notes, spaces, chats, and model settings. The mirror image of import.js,
// minus the format-detection/ZIP-reading machinery (there's only one shape
// to write here: our own).
//
// Note embeddings and the tag-vocab registry are both derived/regenerable
// (from content and from tags, respectively — see tagvocab.js), so they're
// left out to keep the file small and human-readable; a restore just re-runs
// enrichment.
import * as store from '../data/notes.ts'
import * as collections from '../data/collections.ts'
import * as chats from '../data/chats.ts'
import * as settings from '../data/settings.ts'
import { downloadJson } from '../lib/http.ts'
import type { ServerResponse } from 'node:http'

export function handleExport(res: ServerResponse) {
  const bundle = {
    version: 1,
    exportedAt: new Date().toISOString(),
    notes: store.allNotes(),
    collections: collections.all(),
    chats: chats.all(),
    settings: { current: settings.get(), residency: settings.getResidency() },
  }
  const stamp = bundle.exportedAt.slice(0, 10)
  downloadJson(res, `kothai-export-${stamp}.json`, bundle)
}
