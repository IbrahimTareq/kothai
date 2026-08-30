// SQLite-backed user settings — the model selection per role (llm / embed /
// vision), the residency map controlling whether each role is off / on-demand
// / always-loaded, and a `configured` flag marking that the first-run picker
// has been completed. Single row (id = 1) in the `settings` table.
import { getDb } from './db.js'
import { DEFAULTS } from '../ai/presets.js'
import { ROLES, POLICIES, resolveResidency } from '../ai/roles.js'

let settings = { ...DEFAULTS }
let residency = resolveResidency({})
let remote = { llm: '', embed: '', vision: '' }
let configured = false
let embedRecipe = null
let loaded = false

export async function load() {
  if (loaded) return
  const db = await getDb()
  const row = db.prepare('SELECT * FROM settings WHERE id = 1').get()
  if (row) {
    configured = !!row.configured
    residency = { llm: row.residency_llm, embed: row.residency_embed, vision: row.residency_vision }
    settings = { llm: row.llm, embed: row.embed, vision: row.vision }
    remote = { llm: row.remote_llm || '', embed: row.remote_embed || '', vision: row.remote_vision || '' }
    embedRecipe = row.embed_recipe || null
  } else {
    configured = false
    residency = resolveResidency({})
    settings = { ...DEFAULTS }
    remote = { llm: '', embed: '', vision: '' }
    embedRecipe = null
  }
  loaded = true
}

export function get() {
  return { ...settings }
}

export function getResidency() {
  return { ...residency }
}

// Remote model names, kept separate from the local selection: local keys are
// QVAC registry constants, remote ones are endpoint-defined ids.
export function getRemote() {
  return { ...remote }
}

// test-only: drop cached module state so a fresh load() re-reads the database.
export function _reset() {
  loaded = false
}

// Which embedding recipe the stored vectors were built under (see prompts.js's
// EMBED_RECIPE). null on an install that predates the marker — indistinguishable
// from a stale recipe, and treated the same way: re-embed once.
export function getEmbedRecipe() {
  return embedRecipe
}

// Has the user completed the first-run model picker? Gates the initial download.
export function isConfigured() {
  return configured
}

// Patch model keys and/or the residency map. `patch.residency` may be partial.
// Callers are expected to validate residency values before calling save()
// (routes/settings.js does), but an invalid value here is ignored — kept at
// its current value — rather than silently reset to a fresh-install default,
// which resolveResidency's migration semantics would otherwise produce.
export async function save(patch) {
  const { residency: rPatch, remote: remotePatch, embedRecipe: recipePatch, ...rest } = patch
  for (const role of ROLES) if (rest[role]) settings[role] = rest[role]
  if (rest.configured) configured = true
  if (recipePatch !== undefined) embedRecipe = recipePatch
  if (rPatch) {
    const merged = { ...residency }
    for (const role of ROLES) if (POLICIES.includes(rPatch[role])) merged[role] = rPatch[role]
    residency = merged
  }
  if (remotePatch) {
    // undefined means "not in this patch"; '' means "clear this role".
    for (const role of ROLES) if (remotePatch[role] !== undefined) remote[role] = String(remotePatch[role])
  }
  const db = await getDb()
  db.prepare(`
    INSERT INTO settings (id, llm, embed, vision, residency_llm, residency_embed, residency_vision, configured, remote_llm, remote_embed, remote_vision, embed_recipe)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      llm = excluded.llm, embed = excluded.embed, vision = excluded.vision,
      residency_llm = excluded.residency_llm, residency_embed = excluded.residency_embed, residency_vision = excluded.residency_vision,
      configured = excluded.configured,
      remote_llm = excluded.remote_llm, remote_embed = excluded.remote_embed, remote_vision = excluded.remote_vision,
      embed_recipe = excluded.embed_recipe
  `).run(settings.llm, settings.embed, settings.vision, residency.llm, residency.embed, residency.vision, configured ? 1 : 0, remote.llm, remote.embed, remote.vision, embedRecipe)
  return get()
}
