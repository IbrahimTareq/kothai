// SQLite-backed user settings — the endpoint model name per role (llm / embed /
// vision) and a `configured` flag marking that first run has been completed.
// Single row (id = 1) in the `settings` table.
import type { SQLOutputValue } from 'node:sqlite'
import { getDb } from './db.ts'
import type { SettingsRow } from './db.ts'
import { DEFAULTS } from '../ai/presets.ts'
import { ROLES } from '../ai/roles.ts'
import type { Role } from '../ai/roles.ts'

// What save() accepts. Model names are plain strings: a patch arrives from an
// HTTP body and has proved nothing yet.
export interface SettingsPatch {
  llm?: string
  embed?: string
  vision?: string
  configured?: boolean
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
    configured: Number(row.configured),
    remote_llm: nullableText(row.remote_llm),
    remote_embed: nullableText(row.remote_embed),
    remote_vision: nullableText(row.remote_vision),
    embed_recipe: nullableText(row.embed_recipe),
    embed_provider: nullableText(row.embed_provider),
    backups: Number(row.backups),
  }
}

// One-time, for installs from before the on-device provider was removed. A
// role stored 'off' (first-run Skip stored it for all three) was kept off by
// its residency, and residency is no longer read: without clearing that role's
// endpoint model name, an install with an endpoint would start classify, embed
// and vision calls after the upgrade that it never made before. The residency
// column is blanked as the role is cleared, which is what makes this run once:
// a model picked after the upgrade survives every later boot.
function clearRolesStoredOff(db: Awaited<ReturnType<typeof getDb>>): void {
  for (const role of ROLES) {
    db.prepare(
      `UPDATE settings SET remote_${role} = '', residency_${role} = '' WHERE id = 1 AND residency_${role} = 'off'`,
    ).run()
  }
}

let settings: Record<Role, string> = { ...DEFAULTS }
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
  clearRolesStoredOff(db)
  const raw = db.prepare('SELECT * FROM settings WHERE id = 1').get()
  if (raw) {
    const row = readRow(raw)
    configured = !!row.configured
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

// True only for installs that had endpoint model names before the first-run
// gate existed — see the note on `preGate`. Never becomes true because first
// run wrote names.
export function isPreGate(): boolean {
  return preGate
}

// Endpoint model names, kept in their own columns: the local ones held QVAC
// registry constants for the removed on-device provider.
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

// Which provider produced the stored vectors ('local' | 'remote'). 'local'
// marks vectors from the removed on-device provider, kept so a library still
// holding them boots and is re-embedded; null is an install that predates the
// marker. See reembed.vectorsCurrent.
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

// Patch model keys and/or the flags beside them.
export async function save(patch: SettingsPatch): Promise<Record<Role, string>> {
  const {
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
  if (remotePatch) {
    // undefined means "not in this patch"; '' means "clear this role".
    for (const role of ROLES) if (remotePatch[role] !== undefined) remote[role] = String(remotePatch[role])
  }
  const db = await getDb()
  db.prepare(`
    INSERT INTO settings (id, llm, embed, vision, residency_llm, residency_embed, residency_vision, configured, remote_llm, remote_embed, remote_vision, embed_recipe, embed_provider, backups)
    VALUES (1, ?, ?, ?, '', '', '', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      llm = excluded.llm, embed = excluded.embed, vision = excluded.vision,
      configured = excluded.configured,
      remote_llm = excluded.remote_llm, remote_embed = excluded.remote_embed, remote_vision = excluded.remote_vision,
      embed_recipe = excluded.embed_recipe,
      embed_provider = excluded.embed_provider,
      backups = excluded.backups
  `).run(
    settings.llm,
    settings.embed,
    settings.vision,
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
