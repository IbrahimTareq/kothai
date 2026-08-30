// Residency policies and the generic per-role model lifecycle manager.
// Pure module: the SDK loader and timers are injected, so this is fully
// unit-testable and providers/local.js stays the only place that touches
// @qvac/sdk.
//
// Policies: 'always'  — loaded at boot, never unloaded.
//           'ondemand'— loaded on first acquire, refcounted, unloaded after idle.
//           'off'     — never loaded; acquire throws FeatureDisabledError.

export const ROLES = ['llm', 'embed', 'vision']
export const POLICIES = ['off', 'ondemand', 'always']

// Fresh installs: search always instant, LLM/vision load on demand.
export const FRESH_RESIDENCY = { llm: 'ondemand', embed: 'always', vision: 'ondemand' }
// Installs that predate residency keep their old behavior exactly.
export const LEGACY_RESIDENCY = { llm: 'always', embed: 'always', vision: 'ondemand' }
// "Skip for now" — AI-free mode.
export const OFF_RESIDENCY = { llm: 'off', embed: 'off', vision: 'off' }

// Resolve a residency map from a saved settings shape. Handles the
// migration: a configured install without a residency key gets legacy
// (unchanged) behavior; anything else defaults fresh. Invalid per-role
// values fall back to the applicable default.
export function resolveResidency(saved = {}) {
  const base = !saved.residency && saved.configured === true ? LEGACY_RESIDENCY : FRESH_RESIDENCY
  const out = {}
  for (const role of ROLES) {
    const v = saved.residency?.[role]
    out[role] = POLICIES.includes(v) ? v : base[role]
  }
  return out
}

// Thrown when a role cannot serve a request. The `code` field ends up in API
// error payloads so the client can render a proper disabled state. The
// default cause is policy ('off'); the remote provider reuses this same class
// for causes config can fix (bad API key, unknown model name) by passing an
// override, so routes and client keep one error shape to handle.
export class FeatureDisabledError extends Error {
  constructor(role, { code, message } = {}) {
    super(message || `The ${role} model is turned off — enable it in Settings.`)
    this.role = role
    this.code = code || `${role}_off`
  }
}

export class RoleManager {
  // loader: { load({ modelSrc, modelConfig, onProgress(pct) }) → id, unload(id) }
  // timers: { set(fn, ms) → id, clear(id) } — injectable for tests.
  constructor(role, { loader, idleMs, timers = { set: setTimeout, clear: clearTimeout } }) {
    this.role = role
    this.loader = loader
    this.idleMs = idleMs
    this.timers = timers
    this.policy = 'ondemand'
    this.modelSrc = null
    this.modelConfig = null
    this.modelId = null
    this.busy = 0
    this.loadPromise = null
    this.unloadPromise = null
    this.idleTimer = null
    this.status = { state: 'idle', progress: 0, message: '', model: '' }
  }

  // Select the model this role runs. Swapping while resident unloads the old
  // model; the policy decides when the new one loads (boot/acquire). If a
  // load for the previous target is still in flight, wait for it to settle —
  // _ensureLoaded() itself detects the stale target and discards that load,
  // so by the time we get here there's usually nothing left to unload.
  async setModel(modelSrc, modelConfig = null) {
    const changed = this.modelSrc !== modelSrc
    this.modelSrc = modelSrc
    this.modelConfig = modelConfig
    this.status.model = modelSrc?.name || ''
    if (!changed) return
    if (this.loadPromise) await this.loadPromise.catch(() => {})
    if (this.modelId) await this.unload()
  }

  // Policy transitions only manage residency — they never start a load
  // themselves (that's boot()/warmRole() in providers/local.js), so applying
  // settings stays fast and non-blocking.
  async setPolicy(policy) {
    if (!POLICIES.includes(policy)) return
    this.policy = policy
    if (policy === 'off') {
      await this.unload()
      this.status.state = 'off'
      this.status.message = ''
      return
    }
    if (this.status.state === 'off') this.status.state = 'idle'
    if (policy === 'always') this.timers.clear(this.idleTimer)
    else if (this.modelId && this.busy === 0) this._scheduleIdle()
  }

  // Get a loaded model id, loading if needed. Callers MUST pair with release().
  async acquire() {
    if (this.policy === 'off') throw new FeatureDisabledError(this.role)
    this.timers.clear(this.idleTimer)
    this.busy++
    try {
      await this._ensureLoaded()
    } catch (err) {
      this.release()
      throw err
    }
    return this.modelId
  }

  release() {
    this.busy = Math.max(0, this.busy - 1)
    if (this.busy === 0 && this.policy === 'ondemand' && this.modelId) this._scheduleIdle()
  }

  isLoaded() {
    return this.modelId !== null
  }

  snapshot() {
    return { ...this.status }
  }

  // Unload if resident and not busy (policy change, model swap, cache warm).
  async unload() {
    this.timers.clear(this.idleTimer)
    if (!this.modelId || this.busy > 0) return
    const id = this.modelId
    this.modelId = null
    this.loadPromise = null
    if (this.status.state !== 'off') {
      this.status.state = 'idle'
      this.status.progress = 0
      this.status.message = ''
    }
    return this._trackUnload(id)
  }

  // Run loader.unload(id) and publish it as this.unloadPromise so ANY
  // concurrent caller — a normal acquire(), or _ensureLoaded()'s own
  // stale-load discard below — waits for the physical unload to finish
  // instead of racing a fresh load against it. Used by unload() for a
  // resident model and by _ensureLoaded() for a discarded stale load; both
  // paths must go through here, or the tracking is incomplete.
  _trackUnload(id) {
    this.unloadPromise = (async () => {
      try {
        await this.loader.unload(id)
      } catch {
        /* best-effort */
      } finally {
        this.unloadPromise = null
      }
    })()
    return this.unloadPromise
  }

  _scheduleIdle() {
    this.timers.clear(this.idleTimer)
    this.idleTimer = this.timers.set(() => { this.unload() }, this.idleMs)
  }

  async _ensureLoaded() {
    if (this.unloadPromise) await this.unloadPromise
    if (this.modelId) return
    if (!this.modelSrc) throw new Error(`${this.role}: no model configured`)
    if (!this.loadPromise) {
      // Capture the target now — if setModel() moves this.modelSrc while the
      // load is in flight, we must not adopt whatever this load returns as
      // resident (it would be the wrong model reported under the new name).
      const targetSrc = this.modelSrc
      const targetConfig = this.modelConfig
      const name = targetSrc.name || ''
      this.loadPromise = (async () => {
        this.status.state = 'loading'
        this.status.progress = 0
        this.status.message = `Loading ${name}…`
        const modelId = await this.loader.load({
          modelSrc: targetSrc,
          modelConfig: targetConfig,
          onProgress: (pct) => {
            this.status.progress = Math.round(pct)
            this.status.message = `${name}: ${Math.round(pct)}%`
          },
        })
        this.loadPromise = null
        if (this.modelSrc !== targetSrc) {
          // Stale: the target moved while this load was in flight. Discard
          // it rather than adopting it as resident — routed through
          // _trackUnload so a concurrent acquire() waits for this teardown
          // instead of overlapping a fresh load with it.
          await this._trackUnload(modelId)
          return
        }
        this.modelId = modelId
        this.status.state = 'ready'
        this.status.progress = 100
        this.status.message = 'Ready'
      })().catch((err) => {
        this.status.state = 'error'
        this.status.message = err?.message || String(err)
        this.loadPromise = null
        throw err
      })
    }
    await this.loadPromise
    if (this.modelId) return
    // The load we awaited was discarded as stale (setModel moved the target
    // while it was in flight) — retry against whatever is current now. If
    // there's nothing valid to retry against (policy flipped to off, or the
    // target was cleared, while the discard was in flight), fail loudly
    // rather than silently resolving with no model — acquire()'s contract is
    // "throw or return a valid modelId," never a quiet null.
    if (this.policy === 'off') throw new FeatureDisabledError(this.role)
    if (!this.modelSrc) throw new Error(`${this.role}: no model configured`)
    return this._ensureLoaded()
  }
}
