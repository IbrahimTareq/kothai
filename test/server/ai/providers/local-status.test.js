// Unit tests for server/ai/qvac.js's computeAggregate — the pure logic
// deriving the client's single boot/status signal from per-role RoleManager
// snapshots and policies. No SDK, no RoleManager instances — just plain
// snapshot-shaped objects, matching what RoleManager.snapshot() returns.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeAggregate } from '../../../../server/ai/providers/local.js'

const idle = (model = '') => ({ state: 'idle', progress: 0, message: '', model })
const off = () => ({ state: 'off', progress: 0, message: '', model: '' })
const ready = (model) => ({ state: 'ready', progress: 100, message: 'Ready', model })
const loading = (model, progress, message) => ({ state: 'loading', progress, message: message ?? `${model}: ${progress}%`, model })
const error = (model, message = 'boom') => ({ state: 'error', progress: 0, message, model })

test('all roles off → ready', () => {
  const roles = { llm: off(), embed: off(), vision: off() }
  const policies = { llm: 'off', embed: 'off', vision: 'off' }
  assert.deepEqual(computeAggregate(roles, policies), { state: 'ready', progress: 100, message: 'Ready' })
})

test('single always-role loading → loading with its own progress', () => {
  const roles = { llm: idle(), embed: loading('E', 42), vision: idle() }
  const policies = { llm: 'ondemand', embed: 'always', vision: 'ondemand' }
  assert.deepEqual(computeAggregate(roles, policies), { state: 'loading', progress: 42, message: 'E: 42%' })
})

test('multi always-role sequential loading averages only over currently-loading roles, not diluted by idle ones', () => {
  // embed already ready (100), llm actively loading at 20% — averaging over
  // BOTH (the old, buggy behavior) would report 60%; correct is 20%.
  const roles = { llm: loading('L', 20), embed: ready('E'), vision: idle() }
  const policies = { llm: 'always', embed: 'always', vision: 'ondemand' }
  assert.deepEqual(computeAggregate(roles, policies), { state: 'loading', progress: 20, message: 'L: 20%' })
})

test('two roles loading simultaneously averages across just those two', () => {
  const roles = { llm: loading('L', 10), embed: loading('E', 90), vision: off() }
  const policies = { llm: 'always', embed: 'always', vision: 'off' }
  assert.deepEqual(computeAggregate(roles, policies), { state: 'loading', progress: 50, message: 'L: 10%' })
})

test('an errored ondemand role does NOT mask an always role that is actively loading', () => {
  const roles = { llm: idle(), embed: loading('E', 55), vision: error('V', 'network blip') }
  const policies = { llm: 'ondemand', embed: 'always', vision: 'ondemand' }
  assert.deepEqual(computeAggregate(roles, policies), { state: 'loading', progress: 55, message: 'E: 55%' })
})

test('an errored ondemand role does NOT mask steady-state ready', () => {
  const roles = { llm: ready('L'), embed: ready('E'), vision: error('V', 'network blip') }
  const policies = { llm: 'always', embed: 'always', vision: 'ondemand' }
  assert.deepEqual(computeAggregate(roles, policies), { state: 'ready', progress: 100, message: 'Ready' })
})

test('an errored always role IS a genuine fault, even if another role is loading', () => {
  const roles = { llm: error('L', 'out of memory'), embed: loading('E', 30), vision: idle() }
  const policies = { llm: 'always', embed: 'always', vision: 'ondemand' }
  assert.deepEqual(computeAggregate(roles, policies), { state: 'error', progress: 0, message: 'out of memory' })
})

test('an errored ondemand role with nothing else active/loading → ready, not error (scoped to its own next use)', () => {
  const roles = { llm: off(), embed: off(), vision: error('V', 'network blip') }
  const policies = { llm: 'off', embed: 'off', vision: 'ondemand' }
  assert.deepEqual(computeAggregate(roles, policies), { state: 'ready', progress: 100, message: 'Ready' })
})
