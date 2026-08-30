// Unit tests for the remote provider's circuit breaker. Pure module with an
// injected clock, mirroring how RoleManager takes injectable timers.
//
// Why this exists: with ~1500 notes in the enrichment backlog, an endpoint
// outage would otherwise mean 1500 failed calls — and against a metered
// provider, 1500 billed-but-useless requests. Local inference has no
// equivalent systemic-outage mode, which is why nothing like this existed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Circuit } from '../../../server/ai/circuit.js'

const clock = (start = 0) => { const o = { t: start, now: () => o.t }; return o }

test('starts closed and allows calls', () => {
  assert.equal(new Circuit({ now: clock().now }).allow(), true)
})

test('stays closed below the failure threshold', () => {
  const c = new Circuit({ threshold: 3, now: clock().now })
  c.recordFailure(); c.recordFailure()
  assert.equal(c.allow(), true)
})

test('opens on the threshold-th consecutive failure', () => {
  const c = new Circuit({ threshold: 3, now: clock().now })
  c.recordFailure(); c.recordFailure(); c.recordFailure()
  assert.equal(c.allow(), false)
})

test('a success resets the consecutive-failure count', () => {
  const c = new Circuit({ threshold: 3, now: clock().now })
  c.recordFailure(); c.recordFailure()
  c.recordSuccess()
  c.recordFailure(); c.recordFailure()
  assert.equal(c.allow(), true)
})

test('allows one probe again once the cooldown elapses', () => {
  const k = clock()
  const c = new Circuit({ threshold: 1, cooldownMs: 1000, now: k.now })
  c.recordFailure()
  assert.equal(c.allow(), false)
  k.t = 999
  assert.equal(c.allow(), false)
  k.t = 1000
  assert.equal(c.allow(), true)
})

test('a failed probe re-opens the circuit for a fresh cooldown', () => {
  const k = clock()
  const c = new Circuit({ threshold: 1, cooldownMs: 1000, now: k.now })
  c.recordFailure()
  k.t = 1000
  assert.equal(c.allow(), true)
  c.recordFailure()
  k.t = 1500
  assert.equal(c.allow(), false)
  k.t = 2000
  assert.equal(c.allow(), true)
})

test('a successful probe fully closes the circuit', () => {
  const k = clock()
  const c = new Circuit({ threshold: 1, cooldownMs: 1000, now: k.now })
  c.recordFailure()
  k.t = 1000
  c.allow()
  c.recordSuccess()
  assert.equal(c.allow(), true)
  assert.equal(c.state, 'closed')
})

test('a non-transient failure opens immediately regardless of threshold', () => {
  const c = new Circuit({ threshold: 10, now: clock().now })
  c.recordFailure({ transient: false })
  assert.equal(c.allow(), false)
  assert.equal(c.state, 'open')
})

test('reason surfaces the last failure message for the status aggregate', () => {
  const c = new Circuit({ threshold: 1, now: clock().now })
  c.recordFailure({ message: 'connect ECONNREFUSED' })
  assert.equal(c.reason, 'connect ECONNREFUSED')
})
