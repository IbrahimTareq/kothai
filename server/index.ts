// Kothai backend entry — boots the local models and HTTP server.
import { mkdirSync, writeFileSync } from 'node:fs'
import { PORT, MODELS_DIR, CONFIG_PATH, PASSWORD, getAiConfig, setAiCredentials } from './config.ts'
import { readCredentials } from './data/credentials.ts'

mkdirSync(MODELS_DIR, { recursive: true })
writeFileSync(CONFIG_PATH, `${JSON.stringify({ cacheDirectory: MODELS_DIR }, null, 2)}\n`)
process.env.QVAC_CONFIG_PATH = CONFIG_PATH

// Imported AFTER the env var above so the local provider picks up the right cache config.
const { createServer } = await import('./router.ts')
const ai = await import('./ai/index.ts')
const store = await import('./data/notes.ts')
const chats = await import('./data/chats.ts')
const settings = await import('./data/settings.ts')
const enrich = await import('./ai/enrich.ts')
const collections = await import('./data/collections.ts')
const tagvocab = await import('./data/tagvocab.ts')
const telegram = await import('./telegram/index.ts')
const demo = await import('./routes/demo.ts')

const server = createServer()

await store.load()
await chats.load()
await settings.load()
await collections.load()
// At boot as well as daily: a restart must not hand yesterday's visitors'
// links to today's, and the daily timer starts over with every deploy.
if (demo.DEMO) {
  await demo.resetDemo()
  setInterval(() => demo.resetDemo().catch(e => console.error('[demo] reset failed:', e)), 24 * 60 * 60 * 1000).unref()
}
// After the stores are open: an update can arrive and be saved within
// milliseconds of the first poll returning.
const telegramActive = telegram.startTelegramCapture()
const hadTagRegistry = await tagvocab.load()
// Before any provider is resolved: a stored endpoint decides which provider
// kind initProvider picks, so loading it later would boot the wrong one.
setAiCredentials(readCredentials())
// Before the provider starts, which reads the model names once.
if (demo.DEMO) await demo.configureDemo()
// Both selections are passed; each provider reads only its own half.
await ai.initProvider(undefined, { local: settings.get(), remote: settings.getRemote() })
if (ai.capabilities().managesResidency) await ai.applyResidency(settings.getResidency())
enrich.queueMetaBackfill()
// Vectors built under an older embedding recipe (different task prefixes, or
// a different set of note fields) are not comparable with new ones, so a
// changed recipe re-embeds the library once, in the background, on the same
// job queue as everything else.
const reembedding = enrich.queueRecipeReembed()
// Vectors from an on-device model and vectors from an endpoint's model live
// in different spaces too, so the embed role changing provider invalidates
// the library just as thoroughly as a recipe change does.
const providerReembedding = enrich.queueEmbedProviderReembed({
  resolved: ai.capabilities().roles.embed,
  wasRemote: getAiConfig().provider === 'remote',
})
// On a fresh install we hold off on downloading any models until the user
// picks them in the first-run flow (POST /api/setup boots them then). A
// configured install boots its always-roles immediately; on-demand roles
// load lazily on first use.
if (settings.isConfigured()) {
  if (!hadTagRegistry && settings.getResidency().embed !== 'off') {
    enrich.queueJob(async () => {
      await tagvocab.rebuildFromNotes(store.allNotes())
    })
  }
}
// Last, after the re-embed checks above: they only mark an EMPTY library as
// current, and seeded notes arriving first would be queued to embed twice.
if (demo.DEMO) await demo.seedDemo()
// Daily backups into data/backups (server/backups.ts): checked hourly, the
// first time a minute after boot rather than during it, while models load. Not
// on the demo, whose library resets nightly and whose host keeps no volume.
if (!demo.DEMO) {
  const backups = await import('./backups.ts')
  setTimeout(() => backups.backupIfDue(), 60_000).unref()
  setInterval(() => backups.backupIfDue(), 60 * 60 * 1000).unref()
}
server.listen(PORT, () => {
  console.log(`\n  📒 Kothai running at  http://localhost:${PORT}\n`)
  // Stated on every boot, both ways round: "no password" is the historical
  // default and safe on a LAN, but it is exactly the thing you want to notice
  // before pointing a public hostname at this.
  if (demo.DEMO) console.log('  Demo: the library is read-only; visitors’ own links, chats and spaces reset daily\n')
  if (PASSWORD) console.log('  Auth: password required (KOTHAI_PASSWORD is set)\n')
  // A demo with no password is the point of it, and "full access" would be
  // false there: the demo gate refuses every write but to a visitor's own things.
  else if (!demo.DEMO)
    console.log(
      '  Auth: none — anyone who can reach this port has full access. Set KOTHAI_PASSWORD to require a password.\n',
    )
  if (telegramActive) console.log('  Telegram capture: on\n')
  if (reembedding || providerReembedding)
    console.log('  Re-embedding the library in the background after an embedding change…\n')
  if (!ai.capabilities().downloadsWeights) console.log(`  Inference: remote endpoint\n`)
  else if (settings.isConfigured())
    console.log('  Loading local QVAC models in the background (first run downloads them)…\n')
  else console.log('  Waiting for first-run model selection at the app before downloading models…\n')
})
if (settings.isConfigured()) ai.boot().catch(() => {})

process.on('SIGINT', async () => {
  console.log('\nShutting down…')
  await ai.shutdown()
  process.exit(0)
})
