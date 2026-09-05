// A mixed install saves an on-device embedding key and remote llm/vision ids
// in the same request, each into its own store. Getting this wrong loses the
// endpoint's model names on every restart — they end up in the local columns,
// which the remote provider never reads.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

const caps = (roles, managesResidency) => ({
  kind: roles.llm === roles.embed && roles.embed === roles.vision ? roles.llm : 'mixed',
  managesResidency,
  downloadsWeights: managesResidency,
  roles,
})

// One mock for the whole file: node's module mocker refuses to mock the same
// specifier twice, and a mocked module the route has already imported keeps
// pointing at this namespace anyway. So the provider answer is mutable state
// each test sets, rather than a fresh mock per test.
const provider = { caps: caps({ llm: 'local', embed: 'local', vision: 'local' }, true), applied: [] }

mock.module('../../../server/ai/index.js', {
  namedExports: {
    capabilities: () => provider.caps,
    validateModel: () => ({ ok: true }),
    applySettings: async (patch) => { provider.applied.push(patch) },
    applyResidency: async () => {},
    boot: async () => {},
    warmRole: async () => {},
  },
})

const { _validateModels, handleSaveSettings } = await import('../../../server/routes/settings.js')

test('validateModels splits a patch by the provider that owns each role', async () => {
  provider.caps = caps({ llm: 'remote', embed: 'local', vision: 'remote' }, true)

  const out = _validateModels({ embed: 'embeddinggemma-300m', remote: { llm: 'gpt-oss:120b' } })
  assert.deepEqual(out.local, { embed: 'embeddinggemma-300m' })
  assert.deepEqual(out.remote, { llm: 'gpt-oss:120b' })
  assert.equal(out.error, undefined)
})

test('a pure-remote install still reads every role from body.remote', async () => {
  provider.caps = caps({ llm: 'remote', embed: 'remote', vision: 'remote' }, false)

  const out = _validateModels({ remote: { llm: 'a', embed: 'b' } })
  assert.deepEqual(out.remote, { llm: 'a', embed: 'b' })
  assert.deepEqual(out.local, {})
})

test('a pure-local install still reads every role from the body root', async () => {
  provider.caps = caps({ llm: 'local', embed: 'local', vision: 'local' }, true)

  const out = _validateModels({ llm: 'x', embed: 'y' })
  assert.deepEqual(out.local, { llm: 'x', embed: 'y' })
  assert.deepEqual(out.remote, {})
})

// The end-to-end shape of the bug: one save on a mixed install, through the
// real route and the real SQLite-backed store, then a simulated restart. The
// endpoint's ids must come back from getRemote() — that is the half of the
// settings server/index.js hands the remote provider at boot — and must NOT
// have been written into the on-device columns, which only the local registry
// reads.
test('a mixed save survives a restart: endpoint ids land in the remote store, not the local one', async () => {
  provider.caps = caps({ llm: 'remote', embed: 'local', vision: 'remote' }, true)
  provider.applied = []

  const { _resetDb } = await import('../../../server/data/db.js')
  const settings = await import('../../../server/data/settings.js')
  const { DEFAULTS } = await import('../../../server/ai/presets.js')

  _resetDb()
  settings._reset()
  await settings.load()

  const body = {
    embed: DEFAULTS.embed,                                  // on-device registry key
    remote: { llm: 'gpt-oss:120b', vision: 'qwen2.5-vl' },  // endpoint-defined ids
  }
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  const res = { statusCode: 0, body: null, writeHead(c) { this.statusCode = c }, end(b) { this.body = JSON.parse(b) } }
  await handleSaveSettings(req, res)
  assert.equal(res.statusCode, 200)

  // The endpoint ids were handed to the facade to apply right away...
  assert.ok(provider.applied.some((p) => p.llm === 'gpt-oss:120b' && p.vision === 'qwen2.5-vl'), 'remote ids applied')

  // ...and they were persisted where the remote provider will look for them
  // on the next boot. Re-read from SQLite to simulate that restart.
  settings._reset()
  await settings.load()
  assert.equal(settings.getRemote().llm, 'gpt-oss:120b')
  assert.equal(settings.getRemote().vision, 'qwen2.5-vl')
  // The on-device columns keep registry keys — an endpoint id here would be
  // both a lost remote name and an unknown local one.
  assert.equal(settings.get().llm, DEFAULTS.llm)
  assert.equal(settings.get().vision, DEFAULTS.vision)
  assert.equal(settings.get().embed, DEFAULTS.embed)
})
