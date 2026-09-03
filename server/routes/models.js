// GET /api/models/files, DELETE /api/models/files/:name — reclaim disk space
// from the model download cache.
//
// QVAC downloads weights into MODELS_DIR and never prunes them: change the LLM
// preset once and the old file sits there for the life of the install, and a
// preset later dropped from the catalogue leaves a file nothing in the app can
// even name. /api/wipe deliberately does not touch any of this (it erases
// content and leaves the install configured), so without these routes the only
// way to get the space back is `rm` on the server — which on a phone-facing
// deployment means nobody gets it back.
//
// Deleting weights is undoable — anything removed here re-downloads the next
// time it is selected — so the one thing this must never do is delete a file
// the current selection depends on. That check lives here rather than in the
// client: the UI's "in use" badge is a hint, this is the enforcement.
import * as ai from '../ai/index.js'
import * as settings from '../data/settings.js'
import { scanWeights, removeWeight, isSafeEntryName } from '../lib/weights.js'
import { json } from '../lib/http.js'
import { MODELS_DIR } from '../config.js'

// A remote-inference deployment (the lite image) has no download cache at all,
// and neither does any future provider that reports downloadsWeights: false.
// 404 rather than 501: for that install these paths simply do not exist.
function noLocalModels(res) {
  return json(res, 404, {
    error: 'This install runs inference remotely and downloads no model files.',
    code: 'no_local_models',
  })
}

// One scan serves both routes: the listing IS the in-use check, so a delete
// can never disagree with what the user was shown.
async function scan() {
  return await scanWeights(MODELS_DIR, ai.weightsInUse(settings.get()))
}

export async function handleModelFiles(res) {
  if (!ai.capabilities().downloadsWeights) return noLocalModels(res)
  json(res, 200, { dir: MODELS_DIR, ...(await scan()) })
}

export async function handleDeleteModelFile(res, name) {
  if (!ai.capabilities().downloadsWeights) return noLocalModels(res)
  // Before anything touches the filesystem: the name came off the URL.
  if (!isSafeEntryName(name)) {
    return json(res, 400, { error: 'Not a model file.', code: 'invalid_name' })
  }

  const { entries } = await scan()
  const entry = entries.find((e) => e.name === name)
  if (!entry) return json(res, 404, { error: `No such model file: ${name}`, code: 'not_found' })
  if (entry.inUse) {
    return json(res, 409, {
      error: `That file is the model currently selected for ${entry.usedBy}. Choose a different ${entry.usedBy} model first.`,
      code: 'in_use',
      usedBy: entry.usedBy,
    })
  }

  try {
    const { freedBytes } = await removeWeight(MODELS_DIR, name)
    json(res, 200, { deleted: name, freedBytes })
  } catch (e) {
    // Lost a race with something else touching the cache directory — the file
    // was listed a moment ago and is gone now.
    if (e.code === 'not_found') return json(res, 404, { error: e.message, code: 'not_found' })
    throw e
  }
}
