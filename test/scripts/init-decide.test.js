// Unit tests for scripts/lib/init-decide.mjs — the pure logic turning probe
// facts and user answers into an image tag, an env map and warnings. No I/O,
// no Docker; every input is a plain object shaped like a real probe result.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GB, capability } from '../../scripts/lib/init-decide.mjs'

const probe = (over = {}) => ({
  arch: 'arm64', avx2: null, memBytes: 8 * GB, diskBytes: 40 * GB,
  dockerOk: true, composeV2: true, existingDb: false, existingCompose: false, portFree: true,
  ...over,
})

test('arm64 with room can run models locally', () => {
  assert.deepEqual(capability(probe()), { canRunLocal: true, reason: null })
})

test('x86_64 without AVX2 cannot — the Celeron NAS case', () => {
  const r = capability(probe({ arch: 'x86_64', avx2: false }))
  assert.equal(r.canRunLocal, false)
  assert.match(r.reason, /AVX2/)
})

test('x86_64 with AVX2 can', () => {
  assert.equal(capability(probe({ arch: 'x86_64', avx2: true })).canRunLocal, true)
})

test('too little memory available to Docker cannot, and the reason names the figure', () => {
  const r = capability(probe({ memBytes: 1.5 * GB }))
  assert.equal(r.canRunLocal, false)
  assert.match(r.reason, /1\.5 GB/)
})
