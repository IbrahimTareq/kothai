// A role stored as 'off' (first-run Skip, or a role switched off in the old
// residency picker) stays off after the upgrade that removed residency: the
// boot migration in data/settings.ts clears that role's endpoint model name,
// so an install with an endpoint does not start AI calls it never made before.
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { _resetDb } from '../../../server/data/db.ts'
import { setAiCredentials } from '../../../server/config.ts'
import * as settings from '../../../server/data/settings.ts'
import { initProvider, roleEnabled, _reset } from '../../../server/ai/index.ts'

// Port 9 (discard) refuses at once, so the boot probe fails fast; roleEnabled
// asks only whether a role has an endpoint and a model, not whether it answers.
setAiCredentials({ baseUrl: 'http://127.0.0.1:9/v1', apiKey: null, providerId: null })
after(() => setAiCredentials(null))

function seed(residency: Record<'llm' | 'embed' | 'vision', string>) {
  _resetDb()
    .prepare(`
      INSERT INTO settings (id, llm, embed, vision, residency_llm, residency_embed, residency_vision, configured, remote_llm, remote_embed, remote_vision)
      VALUES (1, 'a', 'b', 'c', ?, ?, ?, 1, 'gpt-4o-mini', 'text-embedding-3-small', 'gpt-4.1-mini')
    `)
    .run(residency.llm, residency.embed, residency.vision)
  settings._reset()
}

beforeEach(() => _reset())

test('a skipped install with an endpoint and models boots with every role off', async () => {
  seed({ llm: 'off', embed: 'off', vision: 'off' })
  await settings.load()
  assert.deepEqual(settings.getRemote(), { llm: '', embed: '', vision: '' })
  await initProvider(settings.getRemote())
  for (const role of ['llm', 'embed', 'vision'] as const) assert.equal(roleEnabled(role), false, role)
})

test('a role stored always or ondemand keeps its model and stays on', async () => {
  seed({ llm: 'always', embed: 'off', vision: 'ondemand' })
  await settings.load()
  assert.deepEqual(settings.getRemote(), { llm: 'gpt-4o-mini', embed: '', vision: 'gpt-4.1-mini' })
  await initProvider(settings.getRemote())
  assert.equal(roleEnabled('llm'), true)
  assert.equal(roleEnabled('embed'), false)
  assert.equal(roleEnabled('vision'), true)
})

// Once only: a model the user picks after the upgrade must survive the next boot.
test('running the migration again changes nothing more', async () => {
  seed({ llm: 'off', embed: 'always', vision: 'off' })
  await settings.load()
  await settings.save({ remote: { llm: 'picked-after-upgrade' } })
  settings._reset()
  await settings.load()
  assert.deepEqual(settings.getRemote(), { llm: 'picked-after-upgrade', embed: 'text-embedding-3-small', vision: '' })
})
