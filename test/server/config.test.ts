// Unit tests for server/config.ts — pure resolution of paths + port from env.
// resolveConfig is exported precisely so precedence can be tested without
// mutating process.env or re-importing the module.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { resolveConfig } from '../../server/config.ts'

const ROOT = '/srv/kothai'

test('defaults: every path sits under the repo root, port is 5173', () => {
  const c = resolveConfig({}, ROOT)
  assert.equal(c.PORT, 5173)
  assert.equal(c.DATA_DIR, path.join(ROOT, 'data'))
  assert.equal(c.MODELS_DIR, path.join(ROOT, 'models'))
  assert.equal(c.CONFIG_PATH, path.join(ROOT, 'qvac.config.json'))
})

test('UPLOAD_DIR is always derived from DATA_DIR, never set directly', () => {
  const c = resolveConfig({}, ROOT)
  assert.equal(c.UPLOAD_DIR, path.join(ROOT, 'data', 'uploads'))

  const moved = resolveConfig({ KOTHAI_DATA_DIR: '/mnt/notes' }, ROOT)
  assert.equal(moved.UPLOAD_DIR, '/mnt/notes/uploads')
})

test('PORT: env wins, non-numeric falls back to the default', () => {
  assert.equal(resolveConfig({ PORT: '8080' }, ROOT).PORT, 8080)
  assert.equal(resolveConfig({ PORT: 'nonsense' }, ROOT).PORT, 5173)
  assert.equal(resolveConfig({ PORT: '' }, ROOT).PORT, 5173)
  assert.equal(resolveConfig({ PORT: '0' }, ROOT).PORT, 0)
})

test('KOTHAI_HOME derives all three paths from one root (single-volume hosts)', () => {
  const c = resolveConfig({ KOTHAI_HOME: '/data' }, ROOT)
  assert.equal(c.DATA_DIR, '/data/data')
  assert.equal(c.MODELS_DIR, '/data/models')
  assert.equal(c.CONFIG_PATH, '/data/qvac.config.json')
  assert.equal(c.UPLOAD_DIR, '/data/data/uploads')
})

test('a specific var beats KOTHAI_HOME; unset siblings still derive from it', () => {
  const c = resolveConfig({ KOTHAI_HOME: '/data', KOTHAI_MODELS_DIR: '/big/models' }, ROOT)
  assert.equal(c.MODELS_DIR, '/big/models')
  assert.equal(c.DATA_DIR, '/data/data')
  assert.equal(c.CONFIG_PATH, '/data/qvac.config.json')
})

test('the QVAC config path always derives from the root, never from its own var', () => {
  assert.equal(
    resolveConfig({ KOTHAI_CONFIG_PATH: '/elsewhere.json' }, ROOT).CONFIG_PATH,
    path.join(ROOT, 'qvac.config.json'),
  )
})

test('relative env values resolve against the root; absolute ones are kept', () => {
  const c = resolveConfig({ KOTHAI_DATA_DIR: 'notes', KOTHAI_MODELS_DIR: '/mnt/w' }, ROOT)
  assert.equal(c.DATA_DIR, path.join(ROOT, 'notes'))
  assert.equal(c.MODELS_DIR, '/mnt/w')
})

test('empty-string vars are ignored rather than resolving to the root', () => {
  const c = resolveConfig({ KOTHAI_DATA_DIR: '', KOTHAI_HOME: '' }, ROOT)
  assert.equal(c.DATA_DIR, path.join(ROOT, 'data'))
})

test('ALLOW_PRIVATE_FETCH is off unless explicitly opted into', () => {
  assert.equal(resolveConfig({}, '/app').ALLOW_PRIVATE_FETCH, false)
  assert.equal(resolveConfig({ KOTHAI_ALLOW_PRIVATE_FETCH: '1' }, '/app').ALLOW_PRIVATE_FETCH, true)
  assert.equal(resolveConfig({ KOTHAI_ALLOW_PRIVATE_FETCH: 'true' }, '/app').ALLOW_PRIVATE_FETCH, true)
  // Anything else is off: a stray value must not silently disable the SSRF
  // guard, and "0"/"false" are what someone writes when they mean off.
  assert.equal(resolveConfig({ KOTHAI_ALLOW_PRIVATE_FETCH: '0' }, '/app').ALLOW_PRIVATE_FETCH, false)
  assert.equal(resolveConfig({ KOTHAI_ALLOW_PRIVATE_FETCH: 'false' }, '/app').ALLOW_PRIVATE_FETCH, false)
  assert.equal(resolveConfig({ KOTHAI_ALLOW_PRIVATE_FETCH: '' }, '/app').ALLOW_PRIVATE_FETCH, false)
})

test('PASSWORD is null unless KOTHAI_PASSWORD is set — auth stays off for every existing install', () => {
  assert.equal(resolveConfig({}, '/app').PASSWORD, null)
  assert.equal(resolveConfig({ KOTHAI_PASSWORD: '' }, '/app').PASSWORD, null)
  assert.equal(resolveConfig({ KOTHAI_PASSWORD: 'hunter2' }, '/app').PASSWORD, 'hunter2')
})

test('AI_EMBED_PROVIDER is null unless set, and passes its raw value through', () => {
  assert.equal(resolveConfig({}, ROOT).AI_EMBED_PROVIDER, null)
  assert.equal(resolveConfig({ KOTHAI_AI_EMBED_PROVIDER: 'remote' }, ROOT).AI_EMBED_PROVIDER, 'remote')
  assert.equal(resolveConfig({ KOTHAI_AI_EMBED_PROVIDER: 'local' }, ROOT).AI_EMBED_PROVIDER, 'local')
})

// The inference endpoint (base URL, key, provider kind) is no longer part of
// this frozen resolution — it is resolved on demand so it can change at
// runtime. Its precedence rules are covered in test/server/config-ai.test.ts.
