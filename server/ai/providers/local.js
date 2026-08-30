// QVAC model manager: loads a local LLM + embedding model and exposes
// classify / embed / answer helpers used by the notes app.
//
// Everything runs locally / on-device via @qvac/sdk — no data leaves the machine.
import { loadModel, completion, embed, unloadModel, close, cancel } from '@qvac/sdk'
import * as MODELS from '@qvac/sdk'
import { RoleManager, ROLES, FeatureDisabledError } from '../roles.js'
import { PRESETS, DEFAULTS } from '../presets.js'
import {
  CLASSIFY_SCHEMA,
  DESCRIBE_IMAGE_PROMPT,
  embedInput,
  clipToTokens,
  classifySystemPrompt,
  classifyUserPrompt,
  answerSystemPrompt,
  answerUserPrompt,
} from '../prompts.js'
import { normaliseClassification, isJunkTag, heuristicType, deriveTitle, isLikelyUrl, extractUrl, stripThinking } from '../normalise.js'
export { FeatureDisabledError, PRESETS, DEFAULTS }
export { normaliseClassification, isJunkTag, heuristicType, deriveTitle, isLikelyUrl, extractUrl }

// ---- model selection ---------------------------------------------------
function presetFor(role, key) {
  return PRESETS[role].find((p) => p.key === key) || PRESETS[role].find((p) => p.key === DEFAULTS[role])
}

// Preset list with sizes resolved from the SDK registry, for the settings UI.
export function presetInfo() {
  const withSize = (p) => ({
    ...p,
    sizeBytes: (MODELS[p.key]?.expectedSize || 0) + (p.proj ? MODELS[p.proj]?.expectedSize || 0 : 0),
  })
  return { llm: PRESETS.llm.map(withSize), embed: PRESETS.embed.map(withSize), vision: PRESETS.vision.map(withSize) }
}

// ---- role lifecycle ----------------------------------------------------
// Each role is a RoleManager; residency policy (off/ondemand/always) decides
// when its model occupies RAM. This module adapts the managers to @qvac/sdk.
const IDLE_MS = { llm: 10 * 60 * 1000, embed: 5 * 60 * 1000, vision: 3 * 60 * 1000 }

function makeLoader(modelType) {
  return {
    load: ({ modelSrc, modelConfig, onProgress }) => {
      const opts = { modelSrc, modelType, onProgress: (p) => onProgress(p.percentage ?? 0) }
      if (modelConfig) opts.modelConfig = modelConfig
      return loadModel(opts)
    },
    unload: (id) => unloadModel({ modelId: id }),
  }
}

// Preset key of the currently configured embedding model — see configureModels.
let embedModelKey = DEFAULTS.embed

const managers = {
  llm: new RoleManager('llm', { loader: makeLoader('llm'), idleMs: IDLE_MS.llm }),
  embed: new RoleManager('embed', { loader: makeLoader('llamacpp-embedding'), idleMs: IDLE_MS.embed }),
  vision: new RoleManager('vision', { loader: makeLoader('llm'), idleMs: IDLE_MS.vision }),
}

function visionConfig(key) {
  return { ctx_size: 4096, projectionModelSrc: MODELS[presetFor('vision', key).proj] }
}

// Apply a saved model selection to the managers (no loading happens here).
export async function configureModels({ llm, embed: emb, vision } = {}) {
  if (llm && MODELS[llm]) await managers.llm.setModel(MODELS[llm], { ctx_size: 8192 })
  if (emb && MODELS[emb]) {
    // Remembered because embedText has to know WHICH embedding model is
    // loaded: EmbeddingGemma wants task prefixes and GTE-Large does not (see
    // prompts.js's embedInput). The RoleManager holds the resolved model
    // source, not the preset key, so this is the only place the key is known.
    embedModelKey = emb
    await managers.embed.setModel(MODELS[emb])
  }
  if (vision && MODELS[vision]) await managers.vision.setModel(MODELS[vision], visionConfig(vision))
}

// Hot-swap models at runtime (settings tab). A resident model is unloaded by
// setModel; boot()/acquire() bring the new one in per the role's policy.
export async function applyModels(patch = {}) {
  await configureModels(patch)
  // An always-role whose model changed must come back immediately. Each
  // role is caught independently — one role's load failure (network, OOM)
  // must not abort the rest of this job, including the caller's subsequent
  // re-embed sweep in handleSaveSettings.
  for (const role of ROLES) {
    if (managers[role].policy === 'always' && !managers[role].isLoaded()) {
      try {
        await warmRole(role)
      } catch (e) {
        console.error(`[qvac] ${role} reload after model change failed:`, e.message)
      }
    }
  }
}

// Apply the residency map. Policy changes only manage unloading/timers —
// loading always-roles is boot()'s job so this stays fast.
export async function applyResidency(residency) {
  for (const role of ROLES) await managers[role].setPolicy(residency[role])
}

// Load one role now (used by boot for always-roles and by cache warming).
export async function warmRole(role) {
  await managers[role].acquire()
  managers[role].release()
}

// Load every always-role. Safe to call repeatedly; errors land in role status.
let bootPromise = null
export function boot() {
  if (!bootPromise) {
    // Captured locally and compared before clearing — with zero always-roles
    // the loop below never awaits, so the IIFE body (including any reset of
    // the module-level bootPromise) would otherwise run synchronously INSIDE
    // this same statement, before the `bootPromise = ...` assignment below
    // it even happens — clearing a variable that hasn't been set yet, so the
    // assignment then permanently overwrites it with a resolved promise and
    // every later boot() short-circuits forever. p.finally() always runs as
    // a separate microtask, after the assignment below has definitely landed.
    const p = (async () => {
      for (const role of ['embed', 'llm', 'vision']) {
        if (managers[role].policy !== 'always') continue
        try {
          await warmRole(role)
        } catch (e) {
          console.error(`[qvac] ${role} load failed:`, e.message)
        }
      }
    })()
    bootPromise = p
    p.finally(() => {
      if (bootPromise === p) bootPromise = null // allow re-boot after residency changes
    })
  }
  return bootPromise
}

// Pre-download weights for enabled on-demand roles so their first use is a
// fast local load, never a surprise download. Unloads right after.
export async function warmCache(residency) {
  for (const role of ['embed', 'llm', 'vision']) {
    if (residency[role] !== 'ondemand') continue
    try {
      await warmRole(role)
      await managers[role].unload()
    } catch (e) {
      console.error(`[qvac] ${role} warm failed:`, e.message)
    }
  }
}

// Pure: derive the aggregate boot/status signal from role snapshots and their
// policies. Exported so this logic is unit-testable without touching
// @qvac/sdk. Progress averages only over roles CURRENTLY loading (not diluted
// by idle/ready roles reading as a static 100). An error only dominates the
// aggregate when it's on an `always` role — an `ondemand` role's failure is
// scoped to its own next use (it retries on the next acquire()) and
// shouldn't paint the whole status vault as broken, mirroring how the
// pre-residency code always tracked vision's state separately from the main
// boot status.
export function computeAggregate(roles, policies) {
  const active = Object.entries(roles).filter(([, r]) => r.state !== 'off')
  const loading = active.filter(([, r]) => r.state === 'loading').map(([, r]) => r)
  const err = active.find(([role, r]) => r.state === 'error' && policies[role] === 'always')
  if (err) return { state: 'error', progress: err[1].progress, message: err[1].message }
  if (loading.length) {
    const progress = Math.round(loading.reduce((s, r) => s + r.progress, 0) / loading.length)
    return { state: 'loading', progress, message: loading[0].message }
  }
  return { state: 'ready', progress: 100, message: 'Ready' }
}

// Per-role status + a derived aggregate for the client's single progress bar.
export function statusSnapshot() {
  const roles = {
    llm: managers.llm.snapshot(),
    embed: managers.embed.snapshot(),
    vision: managers.vision.snapshot(),
  }
  const policies = { llm: managers.llm.policy, embed: managers.embed.policy, vision: managers.vision.policy }
  return { roles, aggregate: computeAggregate(roles, policies) }
}

export function roleState(role) {
  return managers[role].snapshot().state
}

export function rolePolicy(role) {
  return managers[role].policy
}

// Describe an image file (absolute path) using the vision model. Used both to
// caption images on save (so they become searchable) and to answer questions
// about an attached image directly.
export async function describeImage({ absPath, prompt }) {
  const modelId = await managers.vision.acquire()
  return serialise('vision', async () => {
    try {
      const run = completion({
        modelId,
        history: [
          {
            role: 'user',
            content: prompt || DESCRIBE_IMAGE_PROMPT,
            attachments: [{ path: absPath }],
          },
        ],
        stream: false,
      })
      const final = await run.final
      // Reasoning models prefix a <think> block; it must not become the note's
      // description, its embedding input, or what the user reads.
      return stripThinking(final.contentText)
    } finally {
      managers.vision.release()
    }
  })
}

// ---- embeddings --------------------------------------------------------
// `mode` is 'document' (a note being indexed) or 'query' (a question being
// asked). It selects the task prefix for prompt-instructed models; see
// prompts.js's embedInput for why the two are not the same text.
//
// The content is clipped to 4000 chars BEFORE the prefix is applied, so the
// prefix never eats into the text budget and can never itself be truncated.
export async function embedText(text, { mode = 'document' } = {}) {
  const modelId = await managers.embed.acquire()
  try {
    const clean = embedInput(clipToTokens(text), { mode, model: embedModelKey })
    const { embedding } = await embed({ modelId, text: clean || ' ' })
    return embedding
  } finally {
    managers.embed.release()
  }
}

// ---- classification ----------------------------------------------------
// Ask the LLM to categorise a pasted item into a structured record. Output
// is grammar-constrained to JSON via responseFormat, so parsing is reliable.

export async function classify({ text, hasImage, isUrl, now, knownTags = [], candidateTags = [] }) {
  const modelId = await managers.llm.acquire()
  return serialise('llm', async () => {
    try {
      const run = completion({
        modelId,
        history: [
          { role: 'system', content: classifySystemPrompt({ now, knownTags, candidateTags }) },
          { role: 'user', content: classifyUserPrompt({ text, hasImage, isUrl }) },
        ],
        stream: false,
        responseFormat: { type: 'json_schema', json_schema: { name: 'classification', schema: CLASSIFY_SCHEMA } },
      })
      const final = await run.final
      let parsed
      try {
        parsed = JSON.parse(final.contentText.trim())
      } catch {
        parsed = {}
      }
      return normaliseClassification(parsed, { hasImage, isUrl, text })
    } finally {
      managers.llm.release()
    }
  })
}

// ---- answering (RAG) ---------------------------------------------------
// Given the user's question and the retrieved notes, produce an answer that
// is grounded in the saved items and cites them by number.
export async function answer({ question, contextNotes, history = [] }) {
  const modelId = await managers.llm.acquire()
  return serialise('llm', async () => {
    try {
      const run = completion({
        modelId,
        history: [
          { role: 'system', content: answerSystemPrompt() },
          { role: 'user', content: answerUserPrompt({ question, contextNotes, history }) },
        ],
        stream: false,
        captureThinking: true,
      })
      const final = await run.final
      return final.contentText.trim()
    } finally {
      managers.llm.release()
    }
  })
}

// How long to wait for a cancelled run to actually release the model before
// giving up and freeing the role lock anyway. Overridable so the test for the
// give-up path doesn't have to sit through the real grace period.
const TEARDOWN_GRACE_MS = Number(process.env.STASH_TEARDOWN_GRACE_MS) || 5000

// @qvac/sdk allows one completion per model and rejects the rest outright
// ("rejected by registry concurrency policy"). The refcount in roles.js does
// not order callers — it only keeps the weights resident — so completions on a
// role queue here instead. Without this, a stopped answer whose run is still
// being torn down poisoned the very next question, and a background classify
// landing mid-answer failed the same way.
const completionQueue = {}
function serialise(role, fn) {
  const prev = completionQueue[role] || Promise.resolve()
  let done
  completionQueue[role] = new Promise((r) => { done = r })
  // A failed turn must not break the chain for the ones behind it.
  return prev.catch(() => {}).then(fn).finally(done)
}

// Streaming form of the above. Emits each content delta as it arrives and
// still resolves to the whole answer, so callers that only want the text can
// ignore onToken. `signal` cancels the generation itself — the SDK targets a
// single run by requestId, so a stopped question stops costing tokens rather
// than merely being ignored on arrival.
export async function answerStream({ question, contextNotes, history = [], onToken, signal }) {
  const modelId = await managers.llm.acquire()
  return serialise('llm', async () => {
    try {
      const run = completion({
        modelId,
        history: [
          { role: 'system', content: answerSystemPrompt() },
          { role: 'user', content: answerUserPrompt({ question, contextNotes, history }) },
        ],
        stream: true,
        captureThinking: true,   // keeps <think> out of contentDelta, as the non-streaming path does
      })
      let teardown = null
      const abort = () => { teardown = Promise.resolve(cancel({ requestId: run.requestId })).catch(() => {}) }
      if (signal?.aborted) abort()
      else signal?.addEventListener('abort', abort, { once: true })
      let acc = ''
      try {
        for await (const ev of run.events) {
          if (ev.type === 'contentDelta' && ev.text) { acc += ev.text; onToken?.(ev.text) }
        }
        // Cancelling ends the event stream, but `final` belongs to a run that is
        // no longer going to produce one — awaiting it here held the role lock
        // indefinitely, past any grace period. The tokens already in hand are
        // the whole answer now.
        if (signal?.aborted) return acc.trim()
        const final = await run.final
        return (final.contentText || acc).trim()
      } catch (e) {
        // A cancelled run rejects; the tokens it did produce are still good.
        if (signal?.aborted) return acc.trim()
        throw e
      } finally {
        signal?.removeEventListener('abort', abort)
        // A cancelled run is not free the instant cancel() returns. Releasing the
        // role lock before the SDK has torn it down let the next question through
        // while the model still considered the old one live, and it came back
        // "rejected by registry concurrency policy". Bounded, because a teardown
        // that never settles must not wedge the model for the whole session.
        if (teardown) await Promise.race([
          teardown.then(() => run.final).catch(() => {}),
          new Promise((r) => setTimeout(r, TEARDOWN_GRACE_MS)),
        ])
      }
    } finally {
      managers.llm.release()
    }
  })
}

export async function shutdown() {
  for (const role of ROLES) {
    try {
      await managers[role].unload()
    } catch {
      /* ignore */
    }
  }
  try {
    await close()
  } catch {
    /* ignore */
  }
}

// ---- provider contract --------------------------------------------------
// The methods below are what server/ai/index.js's facade calls. Everything
// above is this provider's own machinery (RoleManagers, residency, the QVAC
// registry) and is not part of the contract.

export function capabilities() {
  return { kind: 'local', managesResidency: true, downloadsWeights: true }
}

export function roleEnabled(role) {
  return managers[role].policy !== 'off'
}

export function available() {
  return true
}

export function validateModel(role, key) {
  if (PRESETS[role].some((p) => p.key === key)) return { ok: true }
  return { ok: false, error: `unknown ${role} model: ${key}` }
}

export async function listModels() {
  return presetInfo()
}

export async function init({ local = {} } = {}) {
  await configureModels(local)
}

export async function applySettings(patch) {
  await applyModels(patch)
}
