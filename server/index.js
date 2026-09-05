// Kothai backend entry — boots the local models and HTTP server.
import { mkdirSync, writeFileSync } from 'node:fs'
import { PORT, MODELS_DIR, CONFIG_PATH, PASSWORD, AI_PROVIDER } from './config.js'

mkdirSync(MODELS_DIR, { recursive: true })
writeFileSync(CONFIG_PATH, JSON.stringify({ cacheDirectory: MODELS_DIR }, null, 2) + '\n')
process.env.QVAC_CONFIG_PATH = CONFIG_PATH

// Imported AFTER the env var above so the local provider picks up the right cache config.
const { createServer } = await import('./router.js')
const ai = await import('./ai/index.js')
const store = await import('./data/notes.js')
const chats = await import('./data/chats.js')
const settings = await import('./data/settings.js')
const enrich = await import('./ai/enrich.js')
const collections = await import('./data/collections.js')
const tagvocab = await import('./data/tagvocab.js')

const server = createServer()

await store.load()
await chats.load()
await settings.load()
await collections.load()
const hadTagRegistry = await tagvocab.load()
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
  wasRemote: AI_PROVIDER === 'remote',
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
server.listen(PORT, () => {
  console.log(`\n  📒 Kothai running at  http://localhost:${PORT}\n`)
  // Stated on every boot, both ways round: "no password" is the historical
  // default and safe on a LAN, but it is exactly the thing you want to notice
  // before pointing a public hostname at this.
  if (PASSWORD) console.log('  Auth: password required (STASH_PASSWORD is set)\n')
  else console.log('  Auth: none — anyone who can reach this port has full access. Set STASH_PASSWORD to require a password.\n')
  if (reembedding || providerReembedding) console.log('  Re-embedding the library in the background after an embedding change…\n')
  if (!ai.capabilities().downloadsWeights) console.log(`  Inference: remote endpoint\n`)
  else if (settings.isConfigured()) console.log('  Loading local QVAC models in the background (first run downloads them)…\n')
  else console.log('  Waiting for first-run model selection at the app before downloading models…\n')
})
if (settings.isConfigured()) ai.boot().catch(() => {})

process.on('SIGINT', async () => {
  console.log('\nShutting down…')
  await ai.shutdown()
  process.exit(0)
})
