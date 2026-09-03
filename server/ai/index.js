// Inference facade — the single module the rest of the app imports.
//
// Exactly one provider is resolved at boot via dynamic import(). That
// dynamic import is load-bearing, not stylistic: it is what keeps
// @qvac/sdk off the code path in the lite image, where the package is not
// installed at all. A static `import ... from './providers/local.js'` here
// would make the lite build crash at startup.
//
// Sync accessors (capabilities, statusSnapshot, roleEnabled) delegate to the
// resolved provider and throw if called before initProvider(). That is safe
// because server/index.js awaits initProvider() before the HTTP server
// listens, so no request can arrive first.
import { AI_PROVIDER } from '../config.js'

export { FeatureDisabledError } from './roles.js'
export { PRESETS, DEFAULTS } from './presets.js'
export { normaliseClassification, isJunkTag, heuristicType, deriveTitle, isLikelyUrl, extractUrl } from './normalise.js'

let impl = null

function P() {
  if (!impl) throw new Error('AI provider not initialised — initProvider() must run before this call')
  return impl
}

export async function _selectProvider(kind, load = null) {
  if (kind === 'remote') return await (load ? load() : import('./providers/remote.js'))
  try {
    return await (load ? load() : import('./providers/local.js'))
  } catch (e) {
    if (e?.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error(
        'STASH_AI_PROVIDER=local but @qvac/sdk is not installed. This is the lite image — ' +
          'set STASH_AI_PROVIDER=remote and STASH_AI_BASE_URL to point at an OpenAI-compatible endpoint.',
      )
    }
    throw e
  }
}

export function _reset() {
  impl = null
}

export async function initProvider(kind = AI_PROVIDER, current = {}) {
  if (impl) return impl
  impl = await _selectProvider(kind)
  await impl.init(current)
  return impl
}

export function capabilities() { return P().capabilities() }
export function statusSnapshot() { return P().statusSnapshot() }
export function roleEnabled(role) { return P().roleEnabled(role) }
export function available() { return P().available() }
export function validateModel(role, key) { return P().validateModel(role, key) }

export const classify = (...a) => P().classify(...a)
export const embedText = (...a) => P().embedText(...a)
export const describeImage = (...a) => P().describeImage(...a)
export const answer = (...a) => P().answer(...a)
// Streaming answers, with a fallback for any provider that doesn't implement
// them: the whole answer arrives as one delta, so callers never branch on
// whether the provider can stream.
export const answerStream = async (args) => {
  const p = P()
  if (p.answerStream) return p.answerStream(args)
  const text = await p.answer(args)
  if (text) args?.onToken?.(text)
  return text
}
export const listModels = (...a) => P().listModels(...a)
export const applySettings = (...a) => P().applySettings(...a)
export const shutdown = async () => { if (impl) await impl.shutdown() }

export const boot = (...a) => P().boot?.(...a) ?? Promise.resolve()
export const warmRole = (...a) => P().warmRole?.(...a) ?? Promise.resolve()
export const warmCache = (...a) => P().warmCache?.(...a) ?? Promise.resolve()
export const applyResidency = (...a) => P().applyResidency?.(...a) ?? Promise.resolve()
export const configureModels = (...a) => P().configureModels?.(...a) ?? Promise.resolve()
// Model files on disk, for the cache-management routes. A provider that
// downloads nothing claims no files, so the routes' capability gate is the
// only thing that has to know about the difference.
export const weightsInUse = (...a) => P().weightsInUse?.(...a) ?? {}
