// The remote provider as the facade resolves it: one process-wide instance of
// remote.ts's factory, booted from config. Split from the factory so that
// file stays the provider itself — tests drive independent instances of it
// and never touch this one.
import { getAiConfig } from '../../config.ts'
import { findEndpoint } from '../endpoints.ts'
import type { RoleEndpoint } from '../endpoint-config.ts'
import type { Role } from '../roles.ts'
import { createRemoteProvider } from './remote.ts'
import type { ModelSelection, Provider } from './types.ts'

let singleton: Provider | null = null
// Held here rather than handed to one instance: boot() replaces the instance
// every time the endpoint is re-pointed, and the handler must survive that.
let recover = () => {}
const current = (): Provider => singleton || boot({})

// One object rather than a module of forwarders: what this file announces is a
// single provider. Every member defers to whichever instance boot() installed
// last, which is what lets init() re-point the endpoint while the facade keeps
// holding this same object.
export const remoteProvider = {
  roleEnabled: (role: Role) => current().roleEnabled(role),
  available: () => current().available(),
  validateModel: (role: Role, key: string) => current().validateModel(role, key),
  statusSnapshot: () => current().statusSnapshot(),
  listModels: (...a: Parameters<Provider['listModels']>) => current().listModels(...a),
  applySettings: (patch: ModelSelection) => current().applySettings(withEnvModels(patch)),
  classify: (...a: Parameters<Provider['classify']>) => current().classify(...a),
  embedText: (...a: Parameters<Provider['embedText']>) => current().embedText(...a),
  describeImage: (...a: Parameters<Provider['describeImage']>) => current().describeImage(...a),
  answer: (...a: Parameters<Provider['answer']>) => current().answer(...a),
  onRecover: (fn: () => void) => {
    recover = fn
  },
  shutdown: async () => {
    if (singleton) await singleton.shutdown()
  },
  init: async (models: ModelSelection = {}) => {
    await boot(models).init()
  },
} satisfies Provider

function boot(models: ModelSelection): Provider {
  // Read at boot, not at import: this is what makes re-pointing the endpoint a
  // matter of calling init() again rather than restarting the container.
  const { roles } = getAiConfig()
  // '' is this provider's spelling of "no endpoint configured" — see
  // RemoteEndpoint. Per-provider quirks live in the catalogue, not in this
  // transport.
  const endpoint = ({ baseUrl, apiKey, providerId }: RoleEndpoint) => ({
    baseUrl: baseUrl || '',
    apiKey,
    embeddingsPath: findEndpoint(providerId)?.embeddingsPath || '',
  })
  const pinned = withEnvModels(models)
  const model = (role: Role) => pinned[role] || ''
  singleton = createRemoteProvider({
    endpoints: { llm: endpoint(roles.llm), embed: endpoint(roles.embed), vision: endpoint(roles.vision) },
    models: { llm: model('llm'), embed: model('embed'), vision: model('vision') },
    onRecover: () => recover(),
  })
  return singleton
}

// A model named by env wins over the one saved in settings, at boot and on
// every settings save alike. Applied only at boot, the settings route's
// applySettings(whole stored selection) put the stored embed model back over
// KOTHAI_AI_EMBED_MODEL when the user changed only llm: library vectors stayed
// on the env model while queries used the stored one, and nothing re-embedded.
function withEnvModels(models: ModelSelection): ModelSelection {
  return { ...models, ...getAiConfig().envModels }
}
