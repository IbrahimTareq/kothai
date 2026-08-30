// Unit tests for server/ai/roles.js — residency resolution and the generic
// RoleManager lifecycle. The SDK loader and timers are injected fakes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RoleManager, FeatureDisabledError, resolveResidency,
  FRESH_RESIDENCY, LEGACY_RESIDENCY, POLICIES,
} from '../../../server/ai/roles.js'

// ---- resolveResidency ---------------------------------------------------
test('resolveResidency: fresh install (unconfigured, no residency) → fresh defaults', () => {
  assert.deepEqual(resolveResidency({}), FRESH_RESIDENCY)
})

test('resolveResidency: legacy configured install without residency → old behavior', () => {
  assert.deepEqual(resolveResidency({ configured: true, llm: 'X' }), LEGACY_RESIDENCY)
})

test('resolveResidency: explicit residency wins; invalid values fall back per-role', () => {
  const saved = { configured: true, residency: { llm: 'off', embed: 'bogus', vision: 'always' } }
  assert.deepEqual(resolveResidency(saved), { llm: 'off', embed: FRESH_RESIDENCY.embed, vision: 'always' })
})

// ---- fakes --------------------------------------------------------------
function fakeTimers() {
  let next = 1
  const pending = new Map()
  return {
    set: (fn, ms) => { const id = next++; pending.set(id, { fn, ms }); return id },
    clear: (id) => pending.delete(id),
    fire: () => { for (const [id, { fn }] of [...pending]) { pending.delete(id); fn() } },
    count: () => pending.size,
  }
}

function fakeLoader(log) {
  let n = 0
  return {
    load: async ({ modelSrc, onProgress }) => { onProgress?.(100); log.push(['load', modelSrc.name]); return ++n },
    unload: async (id) => { log.push(['unload', id]) },
  }
}

// A loader whose load/unload only resolve when explicitly told to — lets us
// construct races deterministically (e.g. acquire() firing while an unload
// or a load for a different model is still in flight).
function deferredLoader() {
  const log = []
  const pending = { load: null, unload: null }
  let n = 0
  const loader = {
    load: ({ modelSrc }) => {
      log.push(['load-start', modelSrc.name])
      return new Promise((resolve) => {
        pending.load = () => { log.push(['load-end', modelSrc.name]); resolve(++n) }
      })
    },
    unload: (id) => {
      log.push(['unload-start', id])
      return new Promise((resolve) => {
        pending.unload = () => { log.push(['unload-end', id]); resolve() }
      })
    },
  }
  return { loader, log, resolveLoad: () => pending.load(), resolveUnload: () => pending.unload() }
}

const SRC = { name: 'test-model' }
const SRC2 = { name: 'other-model' }

function makeMgr(log = []) {
  const timers = fakeTimers()
  const mgr = new RoleManager('llm', { loader: fakeLoader(log), idleMs: 1000, timers })
  mgr.setModel(SRC)
  return { mgr, timers, log }
}

// ---- policy: off --------------------------------------------------------
test('off: acquire throws FeatureDisabledError with role code', async () => {
  const { mgr } = makeMgr()
  await mgr.setPolicy('off')
  await assert.rejects(() => mgr.acquire(), (e) => e instanceof FeatureDisabledError && e.code === 'llm_off')
  assert.equal(mgr.snapshot().state, 'off')
})

test('off: setPolicy unloads a resident model', async () => {
  const { mgr, log } = makeMgr()
  await mgr.acquire(); mgr.release()
  await mgr.setPolicy('off')
  assert.deepEqual(log, [['load', 'test-model'], ['unload', 1]])
  assert.equal(mgr.isLoaded(), false)
})

// ---- policy: ondemand ---------------------------------------------------
test('ondemand: acquire loads once, concurrent acquires share the load', async () => {
  const { mgr, log } = makeMgr()
  const [a, b] = await Promise.all([mgr.acquire(), mgr.acquire()])
  assert.equal(a, b)
  assert.deepEqual(log, [['load', 'test-model']])
  mgr.release(); mgr.release()
})

test('ondemand: release schedules idle unload; firing it frees the model', async () => {
  const { mgr, timers, log } = makeMgr()
  await mgr.acquire()
  assert.equal(timers.count(), 0)   // busy → no timer
  mgr.release()
  assert.equal(timers.count(), 1)
  timers.fire()
  await new Promise((r) => setImmediate(r))   // unload is async
  assert.deepEqual(log.at(-1), ['unload', 1])
  assert.equal(mgr.snapshot().state, 'idle')
})

test('ondemand: re-acquire cancels the pending idle unload', async () => {
  const { mgr, timers, log } = makeMgr()
  await mgr.acquire(); mgr.release()
  await mgr.acquire()               // cancels timer
  timers.fire()
  await new Promise((r) => setImmediate(r))
  assert.ok(!log.some((e) => e[0] === 'unload'))
  mgr.release()
})

test('ondemand: unload() is a no-op while busy', async () => {
  const { mgr, log } = makeMgr()
  await mgr.acquire()
  await mgr.unload()
  assert.ok(!log.some((e) => e[0] === 'unload'))
  mgr.release()
})

// ---- policy: always -----------------------------------------------------
test('always: release schedules no idle unload', async () => {
  const { mgr, timers } = makeMgr()
  await mgr.setPolicy('always')
  await mgr.acquire(); mgr.release()
  assert.equal(timers.count(), 0)
  assert.equal(mgr.isLoaded(), true)
})

test('always→ondemand transition starts the idle clock on a loaded, idle model', async () => {
  const { mgr, timers } = makeMgr()
  await mgr.setPolicy('always')
  await mgr.acquire(); mgr.release()
  await mgr.setPolicy('ondemand')
  assert.equal(timers.count(), 1)
})

// ---- model swap ---------------------------------------------------------
test('setModel: swapping while resident unloads the old model', async () => {
  const { mgr, log } = makeMgr()
  await mgr.acquire(); mgr.release()
  await mgr.setModel(SRC2)
  assert.deepEqual(log.at(-1), ['unload', 1])
  assert.equal(mgr.isLoaded(), false)
  assert.equal(mgr.snapshot().model, 'other-model')
})

// ---- errors -------------------------------------------------------------
test('load failure: state=error, and a later acquire retries', async () => {
  const timers = fakeTimers()
  let fail = true
  const loader = {
    load: async () => { if (fail) throw new Error('boom'); return 7 },
    unload: async () => {},
  }
  const mgr = new RoleManager('embed', { loader, idleMs: 1000, timers })
  mgr.setModel(SRC)
  await assert.rejects(() => mgr.acquire(), /boom/)
  assert.equal(mgr.snapshot().state, 'error')
  fail = false
  assert.equal(await mgr.acquire(), 7)
  mgr.release()
})

// ---- races: acquire/unload and setModel/load ----------------------------
test('acquire during an in-flight unload waits for it before loading (no overlap)', async () => {
  const timers = fakeTimers()
  const { loader, log, resolveLoad, resolveUnload } = deferredLoader()
  const mgr = new RoleManager('llm', { loader, idleMs: 1000, timers })
  mgr.setModel(SRC)

  const firstAcquire = mgr.acquire()
  resolveLoad()
  await firstAcquire
  mgr.release()

  const unloadP = mgr.unload()          // unload begins, not yet resolved
  const secondAcquire = mgr.acquire()   // must wait for the unload to finish
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(log.map((e) => e[0]), ['load-start', 'load-end', 'unload-start'])

  resolveUnload()
  await unloadP
  resolveLoad()
  await secondAcquire
  assert.deepEqual(log.map((e) => e[0]), ['load-start', 'load-end', 'unload-start', 'unload-end', 'load-start', 'load-end'])
  mgr.release()
})

test('setModel during an in-flight load discards the stale result; a waiting acquire gets the new model', async () => {
  const timers = fakeTimers()
  const { loader, log, resolveLoad, resolveUnload } = deferredLoader()
  const mgr = new RoleManager('llm', { loader, idleMs: 1000, timers })
  mgr.setModel(SRC)

  const acquireP = mgr.acquire()   // loading SRC, in flight
  mgr.setModel(SRC2)               // target moves before SRC's load resolves

  resolveLoad()                    // SRC's load resolves...
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(log.map((e) => e[0]), ['load-start', 'load-end', 'unload-start']) // ...and is unloaded as stale

  resolveUnload()                  // stale-model cleanup completes
  await new Promise((r) => setImmediate(r))
  assert.equal(log.at(-1)[0], 'load-start')
  assert.equal(log.at(-1)[1], 'other-model')  // now SRC2 starts loading

  resolveLoad()                    // SRC2 loads
  await acquireP                   // the original acquire() resolves with SRC2's id
  assert.equal(mgr.snapshot().model, 'other-model')
  assert.equal(mgr.isLoaded(), true)
  mgr.release()
})

test('a stale-discard unload is tracked so a fresh acquire waits for it (no overlap)', async () => {
  const timers = fakeTimers()
  const { loader, log, resolveLoad, resolveUnload } = deferredLoader()
  const mgr = new RoleManager('llm', { loader, idleMs: 1000, timers })
  mgr.setModel(SRC)

  const acquireA = mgr.acquire()   // loading SRC, in flight
  mgr.setModel(SRC2)               // target moves before SRC's load resolves

  resolveLoad()                    // SRC's load resolves and is detected stale
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(log.map((e) => e[0]), ['load-start', 'load-end', 'unload-start'])

  // A second, independent caller wants the role NOW, while the stale
  // model's discard-unload is still in flight. It must wait for that
  // unload to settle rather than racing a fresh load against it.
  const acquireB = mgr.acquire()
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(log.map((e) => e[0]), ['load-start', 'load-end', 'unload-start']) // still no second load-start

  resolveUnload()
  await new Promise((r) => setImmediate(r))   // let the retry's loader.load() fire before resolving it
  assert.equal(log.at(-1)[0], 'load-start')
  assert.equal(log.at(-1)[1], 'other-model')  // now SRC2 starts loading

  resolveLoad()                    // SRC2 loads once the discard settles
  const [idA, idB] = await Promise.all([acquireA, acquireB])
  assert.equal(idA, idB)
  assert.equal(mgr.snapshot().model, 'other-model')
  mgr.release(); mgr.release()
})

test('acquire throws if policy flips to off while its stale load is being discarded (busy is released, not leaked)', async () => {
  const timers = fakeTimers()
  const { loader, resolveLoad, resolveUnload } = deferredLoader()
  const mgr = new RoleManager('llm', { loader, idleMs: 1000, timers })
  mgr.setModel(SRC)

  const acquireA = mgr.acquire()   // loading SRC, in flight
  mgr.setModel(SRC2)               // target moves — SRC's load will be discarded as stale

  resolveLoad()                    // SRC's load resolves, detected stale, discard-unload begins
  await new Promise((r) => setImmediate(r))

  await mgr.setPolicy('off')       // policy flips off while the discard-unload is still in flight
  resolveUnload()                  // discard-unload settles

  await assert.rejects(() => acquireA, (e) => e instanceof FeatureDisabledError && e.code === 'llm_off')
  assert.equal(mgr.busy, 0)        // release() ran — busy was not leaked
})

test('POLICIES lists exactly the three policies', () => {
  assert.deepEqual(POLICIES, ['off', 'ondemand', 'always'])
})

test('FeatureDisabledError keeps its historical default code and message', () => {
  const e = new FeatureDisabledError('embed')
  assert.equal(e.code, 'embed_off')
  assert.equal(e.role, 'embed')
  assert.match(e.message, /turned off/)
})

test('FeatureDisabledError accepts an override code and message for non-policy causes', () => {
  const e = new FeatureDisabledError('llm', { code: 'llm_auth_failed', message: 'Endpoint rejected the API key.' })
  assert.equal(e.code, 'llm_auth_failed')
  assert.equal(e.role, 'llm')
  assert.equal(e.message, 'Endpoint rejected the API key.')
  assert.ok(e instanceof FeatureDisabledError, 'must stay the same class the routes already catch')
})
