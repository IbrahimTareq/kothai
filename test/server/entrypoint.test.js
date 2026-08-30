// Unit test for the entrypoint's privilege decision. The filesystem and
// privilege-drop behavior itself is verified in the CI smoke test (it needs a
// real container); this covers the branch that decides whether to act at all.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { plan } from '../../docker/entrypoint.js'

test('root repairs ownership and drops privileges', () => {
  assert.deepEqual(plan(0), { chown: true, drop: true })
})

test('a non-root uid does neither — it cannot, and must not crash trying', () => {
  assert.deepEqual(plan(1000), { chown: false, drop: false })
  assert.deepEqual(plan(65534), { chown: false, drop: false })
})

test('a platform-assigned random uid is treated as non-root', () => {
  assert.deepEqual(plan(1000670000), { chown: false, drop: false })
})
