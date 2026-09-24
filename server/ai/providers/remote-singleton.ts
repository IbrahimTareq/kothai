// The remote provider as the facade resolves it: one process-wide instance of
// remote.ts's factory, booted from config. Split from the factory so that
// file stays the provider itself — tests drive independent instances of it
// and never touch this one.
import { getAiConfig } from '../../config.ts'
import { findEndpoint } from '../endpoints.ts'
import type { Role } from '../roles.ts'
import { createRemoteProvider } from './remote.ts'
import type { ModelSelection, Provider, ProviderConfig } from './types.ts'

let singleton: Provider | null = null
const current = (): Provider => singleton || boot({})

// One object rather than a module of forwarders: what this file announces is a
// single provider. Every member defers to whichever instance boot() installed
// last, which is what lets init() re-point the endpoint while the facade keeps
// holding this same object.
export const remoteProvider = {
  capabilities: () => current().capabilities(),
  roleEnabled: (role: Role) => current().roleEnabled(role),
  available: () => current().available(),
  validateModel: (role: Role, key: string) => current().validateModel(role, key),
  statusSnapshot: () => current().statusSnapshot(),
  listModels: (...a: Parameters<Provider['listModels']>) => current().listModels(...a),
  applySettings: (...a: Parameters<Provider['applySettings']>) => current().applySettings(...a),
  classify: (...a: Parameters<Provider['classify']>) => current().classify(...a),
  embedText: (...a: Parameters<Provider['embedText']>) => current().embedText(...a),
  describeImage: (...a: Parameters<Provider['describeImage']>) => current().describeImage(...a),
  answer: (...a: Parameters<Provider['answer']>) => current().answer(...a),
  shutdown: async () => {
    if (singleton) await singleton.shutdown()
  },
  // Config arrives as { local, remote } — both selections, since the caller
  // resolves settings before it knows which provider was chosen. This provider
  // reads only the remote half.
  init: async ({ remote = {} }: ProviderConfig = {}) => {
    await boot(remote).init()
  },
} satisfies Provider

function boot(models: ModelSelection): Provider {
  // Read at boot, not at import: this is what makes re-pointing the endpoint a
  // matter of calling init() again rather than restarting the container.
  const { baseUrl, apiKey, providerId } = getAiConfig()
  singleton = createRemoteProvider({
    // '' is this provider's spelling of "no endpoint configured" — see
    // RemoteProviderOptions.
    baseUrl: baseUrl || '',
    apiKey,
    // Per-provider quirks live in the catalogue, not in this transport.
    embeddingsPath: findEndpoint(providerId)?.embeddingsPath || '',
    models: { llm: models.llm || '', embed: models.embed || '', vision: models.vision || '' },
  })
  return singleton
}
