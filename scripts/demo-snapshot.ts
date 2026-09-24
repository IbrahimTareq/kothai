// Builds server/demo-seed/: the public demo's shared library, finished, for
// seedDemo (server/routes/demo.ts) to restore at boot instead of building it.
//
// Without a volume, as on Railway, every deploy seeded the demo from nothing:
// every link fetched, and a classify, a vision call and an embed per note, on
// the operator's key, over a minute before the grid had its pictures. This
// runs that seed once, here, and keeps the result.
//
// It boots a real demo against the endpoint the deployed demo uses, so run it
// with the same base URL and a key for it:
//
//   KOTHAI_AI_BASE_URL=https://openrouter.ai/api/v1 KOTHAI_AI_API_KEY=… node scripts/demo-snapshot.ts
//
// Rerun it whenever server/demo-library.txt, the preset's embedding model or
// the embedding recipe changes. Until then seedDemo notices the mismatch, says
// so in the log, and seeds live.
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { EMBED_RECIPE } from '../server/ai/prompts.ts'

const ROOT = path.join(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'server', 'demo-seed')
const PORT = 5199
const BASE = `http://127.0.0.1:${PORT}`
const TIMEOUT_MS = 15 * 60_000

if (!process.env.KOTHAI_AI_BASE_URL || !process.env.KOTHAI_AI_API_KEY) {
  console.error('Set KOTHAI_AI_BASE_URL and KOTHAI_AI_API_KEY to the endpoint the demo uses.')
  process.exit(1)
}

const library = readFileSync(path.join(ROOT, 'server', 'demo-library.txt'), 'utf8')
const expected = library.split('\n').filter(l => l.trim() && !l.trim().startsWith('#')).length
const data = mkdtempSync(path.join(os.tmpdir(), 'kothai-demo-snapshot-'))

const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.ts')], {
  env: { ...process.env, KOTHAI_DEMO: '1', KOTHAI_AI_PROVIDER: 'remote', KOTHAI_DATA_DIR: data, PORT: String(PORT) },
  stdio: 'inherit',
})

// The server's own routes, so the two shapes read here are the ones it sends.
async function get<T>(p: string): Promise<T> {
  const res = await fetch(BASE + p)
  return res.json() as Promise<T>
}

// Done when every seeded note has left `pending`, which enrichNote clears only
// after its classify and embed have run.
const deadline = Date.now() + TIMEOUT_MS
let embed = ''
for (;;) {
  if (Date.now() > deadline) throw new Error('the seed did not finish enriching in 15 minutes')
  await new Promise(r => setTimeout(r, 2000))
  try {
    const { notes, pendingTotal } = await get<{ notes: unknown[]; pendingTotal: number }>('/api/notes?limit=500')
    console.log(`  ${notes.length}/${expected} saved, ${pendingTotal} still enriching`)
    if (notes.length === expected && pendingTotal === 0) {
      embed = (await get<{ remote: { embed: string } }>('/api/settings')).remote.embed
      break
    }
  } catch {
    /* not listening yet */
  }
}
server.kill('SIGINT')
await once(server, 'exit')

const db = new DatabaseSync(path.join(data, 'kothai.db'))
const b64 = (blob: unknown) => (blob instanceof Uint8Array ? Buffer.from(blob).toString('base64') : null)
const notes = db
  .prepare('SELECT data, embedding FROM notes ORDER BY seq')
  .all()
  .map(r => ({ ...JSON.parse(String(r.data)), embedding: b64(r.embedding) }))
const tags = Object.fromEntries(
  db
    .prepare('SELECT tag, embedding FROM tag_vocab')
    .all()
    .map(r => [r.tag, b64(r.embedding)]),
)

// A library built while the endpoint was failing would restore as unsearchable
// cards on every deploy, so it is refused rather than written.
const unembedded = notes.filter(n => !n.embedding || !n.ai?.classify)
if (unembedded.length) {
  console.error(`\n${unembedded.length} notes were not classified and embedded; not writing a snapshot:`)
  for (const n of unembedded) console.error(`  ${n.url}`)
  process.exit(1)
}

rmSync(OUT, { recursive: true, force: true })
mkdirSync(path.join(OUT, 'uploads'), { recursive: true })
for (const file of notes.flatMap(n => [n.thumb, ...(n.slides || [])]).filter(Boolean))
  copyFileSync(path.join(data, 'uploads', path.basename(file)), path.join(OUT, 'uploads', path.basename(file)))
writeFileSync(
  path.join(OUT, 'library.json'),
  `${JSON.stringify({ library, embed, recipe: EMBED_RECIPE, notes, tags })}\n`,
)
rmSync(data, { recursive: true, force: true })

const bare = notes.filter(n => !n.thumb)
console.log(
  `\nWrote ${notes.length} notes and ${Object.keys(tags).length} tags to server/demo-seed/, embedded with ${embed}.`,
)
if (bare.length) console.log(`No thumbnail for: ${bare.map(n => n.url).join(', ')}`)
