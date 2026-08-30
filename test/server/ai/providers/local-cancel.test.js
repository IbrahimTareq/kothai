// Cancelling a streamed answer has to leave the model free for the next one.
//
// The first version released the role lock as soon as the events loop ended,
// which was before @qvac/sdk had actually torn the cancelled run down. The
// next question then reached a model that still considered the old request
// live and came back "rejected by registry concurrency policy" — so the cost
// of stopping an answer was the one after it.
import { test, mock, before, after } from 'node:test'
import assert from 'node:assert/strict'

process.env.STASH_TEARDOWN_GRACE_MS = '300'   // read at import, below

const order = []
let releaseTeardown       // resolves the simulated SDK teardown
let endEvents             // ends the simulated event stream, as a real cancel does
let cancelCalledWith = null

mock.module('@qvac/sdk', {
  namedExports: {
    loadModel: async () => 'model-1',
    unloadModel: async () => {},
    close: async () => {},
    embed: async () => ({ embedding: [0.1] }),
    // Cancelling ends the event stream promptly, as the real SDK does; it is
    // the run's *final* that lags behind, which is the window the bug lived in.
    cancel: async ({ requestId }) => {
      cancelCalledWith = requestId
      order.push('cancel-called')
      endEvents?.()
    },
    completion: () => ({
      requestId: 'run-1',
      events: (async function* () {
        yield { type: 'contentDelta', seq: 0, text: 'partial ' }
        await new Promise((r) => { endEvents = r })
      })(),
      final: new Promise((resolve) => {
        releaseTeardown = () => { order.push('teardown-done'); resolve({ contentText: 'partial ' }) }
      }),
    }),
    QWEN3_1_7B_INST_Q4: { name: 'llm', expectedSize: 1 },
    EMBEDDINGGEMMA_300M_Q8_0: { name: 'embed', expectedSize: 1 },
    QWEN3_5_2B_MULTIMODAL_Q4_K_M: { name: 'vision', expectedSize: 1 },
    MMPROJ_QWEN3_5_2B_MULTIMODAL_F16: { name: 'proj', expectedSize: 1 },
  },
})

let local
// The provider keeps role managers alive; without this the process never exits.
after(async () => { await local?.shutdown() })
before(async () => {
  local = await import('../../../../server/ai/providers/local.js')
  await local.init({ local: { llm: 'QWEN3_1_7B_INST_Q4', embed: 'EMBEDDINGGEMMA_300M_Q8_0', vision: 'QWEN3_5_2B_MULTIMODAL_Q4_K_M' } })
  await local.applyResidency({ llm: 'ondemand', embed: 'ondemand', vision: 'ondemand' })
})

test('a cancelled answer waits for the run to be torn down before it resolves', async () => {
  const ctl = new AbortController()
  const seen = []
  const run = local.answerStream({
    question: 'q', contextNotes: [], onToken: (t) => seen.push(t), signal: ctl.signal,
  })

  // Let the first delta land, then stop.
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(seen, ['partial '], 'the delta before the stop is delivered')
  ctl.abort()
  await new Promise((r) => setTimeout(r, 20))

  assert.equal(cancelCalledWith, 'run-1', 'the specific run is cancelled, not the whole model')

  // The call must still be outstanding: the run has not finished tearing down.
  let settled = false
  run.then(() => { settled = true })
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(settled, false, 'answerStream must not resolve while the run is still being torn down')

  releaseTeardown()
  const text = await run
  assert.equal(text, 'partial', 'the tokens produced before the stop are kept (trimmed)')
  assert.deepEqual(order, ['cancel-called', 'teardown-done'])
})

test('a wedged teardown frees the model anyway rather than holding it forever', async () => {
  const ctl = new AbortController()
  const started = Date.now()
  const run = local.answerStream({ question: 'q', contextNotes: [], signal: ctl.signal })
  await new Promise((r) => setTimeout(r, 20))
  ctl.abort()
  // releaseTeardown is deliberately never called: the SDK never settles.
  const text = await run
  const waited = Date.now() - started
  assert.equal(text, 'partial')
  assert.ok(waited >= 300, `should wait out the grace period, waited ${waited}ms`)
  assert.ok(waited < 3000, `should give up rather than hold the model, waited ${waited}ms`)
})

// @qvac/sdk permits one completion per model. roles.js's acquire() is a
// refcount that keeps the weights resident — it never ordered callers — so a
// second completion reaching the model while the first was still winding down
// came back "rejected by registry concurrency policy". The queue below is what
// makes a question asked straight after a stop wait its turn instead of failing.
test('completions on a role are serialised, not run concurrently', async () => {
  const ctl = new AbortController()
  const first = local.answerStream({ question: 'q1', contextNotes: [], signal: ctl.signal })
  await new Promise((r) => setTimeout(r, 20))

  // Second question arrives while the first is still live.
  let secondStarted = false
  const second = local.answer({ question: 'q2', contextNotes: [] }).then((t) => { secondStarted = true; return t })
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(secondStarted, false, 'the second completion must not run while the first holds the model')

  ctl.abort()                       // stop the first, as the composer's stop button does
  await first
  releaseTeardown?.()               // let the second run settle
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(await second, 'partial', 'the queued question runs once the model is free')
})
