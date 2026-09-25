// SQLite-backed user settings — the model selection per role (llm / embed /
// vision), the residency map controlling whether each role is off / on-demand
// / always-loaded, and a `configured` flag marking that the first-run picker
// has been completed. Single row (id = 1) in the `settings` table.
import type { SQLOutputValue } from 'node:sqlite'
import { getDb } from './db.ts'
import type { SettingsRow } from './db.ts'
import { DEFAULTS } from '../ai/presets.ts'
import { ROLES, POLICIES, FRESH_RESIDENCY, resolveResidency } from '../ai/roles.ts'
import type { Policy, Residency, Role } from '../ai/roles.ts'

// What save() accepts. Model keys and residency values are plain strings, not
// the narrow unions: a patch arrives from an HTTP body and has proved nothing
// yet — see the note on save() for what happens to a value that fails.
export interface SettingsPatch {
  llm?: string
  embed?: string
  vision?: string
  configured?: boolean
  residency?: Partial<Record<Role, string>> | null
  remote?: Partial<Record<Role, string>> | null
  embedRecipe?: string | null
  embedProvider?: string | null
  backups?: boolean
}

// node:sqlite types every column as SQLOutputValue: the connection carries no
// knowledge of the CREATE TABLE, so the row read below proves nothing about
// what it holds. db.ts's SettingsRow is that knowledge written down, and this
// is the one place the two meet — get a column wrong there and this stops
// compiling.
//
// Coercion, not validation: save() at the bottom of this file is the only
// writer of any of these columns, so a value of another type cannot occur, and
// turning that impossibility into a throw would trade a readable install for a
// boot failure.
const text = (v: SQLOutputValue): string => String(v)
const nullableText = (v: SQLOutputValue): string | null => (typeof v === 'string' ? v : null)

function readRow(row: Record<string, SQLOutputValue>): SettingsRow {
  return {
    id: Number(row.id),
    llm: text(row.llm),
    embed: text(row.embed),
    vision: text(row.vision),
    residency_llm: text(row.residency_llm),
    residency_embed: text(row.residency_embed),
    residency_vision: text(row.residency_vision),
    configured: Number(row.configured),
    remote_llm: nullableText(row.remote_llm),
    remote_embed: nullableText(row.remote_embed),
    remote_vision: nullableText(row.remote_vision),
    embed_recipe: nullableText(row.embed_recipe),
    embed_provider: nullableText(row.embed_provider),
    backups: Number(row.backups),
  }
}

// The residency columns are NOT NULL TEXT that only save() below writes, and
// it only ever stores a POLICIES member — but the column's declared type is
// `string`, so the stored value still has to prove itself here. find(), not
// includes(): it hands back the Policy-typed member, so nothing is asserted
// afterwards (the same trick resolveResidency plays on the JSON side). The
// fallback is unreachable.
const policy = (role: Role, stored: string): Policy => POLICIES.find(p => p === stored) ?? FRESH_RESIDENCY[role]

let settings: Record<Role, string> = { ...DEFAULTS }
let residency: Residency = resolveResidency({})
let remote: Record<Role, string> = { llm: '', embed: '', vision: '' }
let configured = false
let embedRecipe: string | null = null
let embedProvider: string | null = null
let backups = true
let loaded = false
// Whether this install carried endpoint model names BEFORE the first-run gate
// existed. Captured once, at load, precisely because it must not be re-derived
// later: first run itself now writes those names (the wizard seeds them so the
// embedding role can resolve before the picker is drawn), and re-deriving would
// read that as "already configured" and refuse to let first run finish.
let preGate = false

export async function load(): Promise<void> {
  if (loaded) return
  const db = await getDb()
  const raw = db.prepare('SELECT * FROM settings WHERE id = 1').get()
  if (raw) {
    const row = readRow(raw)
    configured = !!row.configured
    residency = {
      llm: policy('llm', row.residency_llm),
      embed: policy('embed', row.residency_embed),
      vision: policy('vision', row.residency_vision),
    }
    settings = { llm: row.llm, embed: row.embed, vision: row.vision }
    remote = { llm: row.remote_llm || '', embed: row.remote_embed || '', vision: row.remote_vision || '' }
    embedRecipe = row.embed_recipe || null
    embedProvider = row.embed_provider || null
    backups = !!row.backups
    // Names but no `configured` flag means this install was set up before the
    // gate existed. Read once, here, and never again.
    preGate = !configured && ROLES.some(r => Boolean(remote[r]))
  } else {
    configured = false
    residency = resolveResidency({})
    settings = { ...DEFAULTS }
    remote = { llm: '', embed: '', vision: '' }
    embedRecipe = null
    embedProvider = null
    backups = true
    preGate = false
  }
  loaded = true
}

export function get(): Record<Role, string> {
  return { ...settings }
}

export function getResidency(): Residency {
  return { ...residency }
}

// Remote model names, kept separate from the local selection: local keys are
// QVAC registry constants, remote ones are endpoint-defined ids.
// True only for installs that had endpoint model names before the first-run
// gate existed — see the note on `preGate`. Never becomes true because first
// run wrote names.
export function isPreGate(): boolean {
  return preGate
}

export function getRemote(): Record<Role, string> {
  return { ...remote }
}

// test-only: drop cached module state so a fresh load() re-reads the database.
export function _reset(): void {
  loaded = false
}

// Which embedding recipe the stored vectors were built under (see prompts.ts's
// EMBED_RECIPE). null on an install that predates the marker — indistinguishable
// from a stale recipe, and treated the same way: re-embed once.
export function getEmbedRecipe(): string | null {
  return embedRecipe
}

// Which provider produced the stored vectors ('local' | 'remote'). null on an
// install that predates the marker — see enrich.embedProviderChanged, which
// infers the answer from how that install was configured.
export function getEmbedProvider(): string | null {
  return embedProvider
}

// Whether server/backups.ts writes its daily backup.
export function backupsOn(): boolean {
  return backups
}

// Has the user completed the first-run model picker? Gates the initial download.
export function isConfigured(): boolean {
  return configured
}

// Patch model keys and/or the residency map. `patch.residency` may be partial.
// Callers are expected to validate residency values before calling save()
// (routes/settings.ts does), but an invalid value here is ignored — kept at
// its current value — rather than silently reset to a fresh-install default,
// which resolveResidency's migration semantics would otherwise produce.
export async function save(patch: SettingsPatch): Promise<Record<Role, string>> {
  const {
    residency: rPatch,
    remote: remotePatch,
    embedRecipe: recipePatch,
    embedProvider: providerPatch,
    backups: backupsPatch,
    ...rest
  } = patch
  for (const role of ROLES) if (rest[role]) settings[role] = rest[role]
  if (rest.configured) configured = true
  if (recipePatch !== undefined) embedRecipe = recipePatch
  if (providerPatch !== undefined) embedProvider = providerPatch
  if (backupsPatch !== undefined) backups = backupsPatch
  if (rPatch) {
    const merged = { ...residency }
    // find(), not includes(): a patch value is an unproved string, and find
    // both rejects a bad one and hands back the Policy-typed member.
    for (const role of ROLES) {
      const p = POLICIES.find(candidate => candidate === rPatch[role])
      if (p) merged[role] = p
    }
    residency = merged
  }
  if (remotePatch) {
    // undefined means "not in this patch"; '' means "clear this role".
    for (const role of ROLES) if (remotePatch[role] !== undefined) remote[role] = String(remotePatch[role])
  }
  const db = await getDb()
  db.prepare(`
    INSERT INTO settings (id, llm, embed, vision, residency_llm, residency_embed, residency_vision, configured, remote_llm, remote_embed, remote_vision, embed_recipe, embed_provider, backups)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      llm = excluded.llm, embed = excluded.embed, vision = excluded.vision,
      residency_llm = excluded.residency_llm, residency_embed = excluded.residency_embed, residency_vision = excluded.residency_vision,
      configured = excluded.configured,
      remote_llm = excluded.remote_llm, remote_embed = excluded.remote_embed, remote_vision = excluded.remote_vision,
      embed_recipe = excluded.embed_recipe,
      embed_provider = excluded.embed_provider,
      backups = excluded.backups
  `).run(
    settings.llm,
    settings.embed,
    settings.vision,
    residency.llm,
    residency.embed,
    residency.vision,
    configured ? 1 : 0,
    remote.llm,
    remote.embed,
    remote.vision,
    embedRecipe,
    embedProvider,
    backups ? 1 : 0,
  )
  return get()
}
