// Kothai backend entry — boots the inference provider and HTTP server.
import { PORT, PASSWORD, setAiCredentials } from './config.ts'
import { readCredentials } from './data/credentials.ts'

const { createServer } = await import('./router.ts')
const ai = await import('./ai/index.ts')
const store = await import('./data/notes.ts')
const chats = await import('./data/chats.ts')
const settings = await import('./data/settings.ts')
const enrich = await import('./ai/enrich.ts')
const reembed = await import('./ai/reembed.ts')
// For its side effect: re-queues what an endpoint outage cost once it is back.
await import('./ai/recovery.ts')
const collections = await import('./data/collections.ts')
const tagvocab = await import('./data/tagvocab.ts')
const telegram = await import('./telegram/index.ts')
const demo = await import('./routes/demo.ts')
const { startUsageLog, withTrigger } = await import('./ai/usage.ts')
const { shrinkStoredThumbs } = await import('./links/fetch.ts')

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
// Before the provider starts: it reads each role's endpoint from config at
// init, so loading the credential later would boot every role with none.
setAiCredentials(readCredentials())
// Before the provider starts, which reads the model names once.
if (demo.DEMO) await demo.configureDemo()
await ai.initProvider(settings.getRemote())
// Before the first model call: the boot sweeps below are the first thing to
// make one. Off until here, so tests and scripts never write usage rows.
await startUsageLog()
withTrigger('boot', () => enrich.queueMetaBackfill())
// In the background, one file at a time: a first run on a big library takes a while.
shrinkStoredThumbs().catch(e => console.error('[thumb] stored-thumbnail sweep failed:', e))
// Vectors built under an older embedding recipe (different task prefixes, or
// a different set of note fields) are not comparable with new ones, so a
// changed recipe re-embeds the library once, in the background, on the same
// job queue as everything else.
const reembedding = reembed.queueRecipeReembed()
// Vectors from the removed on-device model and vectors from an endpoint's
// model live in different spaces too, so a library still holding the former
// is invalidated just as thoroughly as by a recipe change. Not when the recipe
// sweep is already queued: it records both markers, and an unfinished sweep
// leaves both stale, which queued the whole library twice.
const providerReembedding = !reembedding && reembed.queueEmbedProviderReembed()
if (settings.isConfigured()) {
  if (!hadTagRegistry && ai.roleEnabled('embed')) {
    withTrigger('boot', () =>
      enrich.queueJob(async () => {
        await tagvocab.rebuildFromNotes(store.allNotes())
      }),
    )
  }
}
// Last, after the re-embed checks above: they only mark an EMPTY library as
// current, and seeded notes arriving first would be queued to embed twice.
if (demo.DEMO) await demo.seedDemo()
// Daily backups into data/backups (server/backups.ts), then the newest copied
// to Google Drive when it is connected (server/drive.ts): checked hourly, the
// first time a minute after boot rather than during the boot sweeps. Not
// on the demo, whose library resets nightly and whose host keeps no volume.
if (!demo.DEMO) {
  const backups = await import('./backups.ts')
  const drive = await import('./drive.ts')
  const tick = async () => {
    await backups.backupIfDue()
    await drive.syncToDrive()
  }
  setTimeout(tick, 60_000).unref()
  setInterval(tick, 60 * 60 * 1000).unref()
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
})

process.on('SIGINT', async () => {
  console.log('\nShutting down…')
  await ai.shutdown()
  process.exit(0)
})
