// reconfigure() re-boots the provider against whatever config now says, so an
// endpoint saved in the browser takes effect without a container restart.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { initProvider, reconfigure, statusSnapshot, _reset } from '../../../server/ai/index.ts'
import { provider } from '../../helpers/providers.ts'

const fakeProvider = (name: string, log: unknown[]) =>
  provider({
    init: async models => {
      log.push(['init', models])
    },
    // Named in its status, so a test can tell which provider is live.
    statusSnapshot: () => ({
      roles: provider().statusSnapshot().roles,
      aggregate: { state: 'ready', progress: 100, message: name },
    }),
  })

beforeEach(() => _reset())

test('re-inits the provider with the stored model names', async () => {
  const log: unknown[] = []
  const load = () => fakeProvider('remote', log)
  await initProvider({}, { load })
  log.length = 0
  await reconfigure({ llm: 'gpt-4o-mini' }, { load })
  assert.deepEqual(log, [['init', { llm: 'gpt-4o-mini' }]])
})

test('reconfigure before init fails loudly', async () => {
  await assert.rejects(() => reconfigure({}), /not initialised/)
})

test('a failure leaves the previous provider live rather than half-built', async () => {
  const log: unknown[] = []
  await initProvider({}, { load: () => fakeProvider('before', log) })
  const broken = fakeProvider('after', log)
  broken.init = async () => {
    throw new Error('endpoint provider exploded')
  }
  await assert.rejects(() => reconfigure({}, { load: () => broken }), /exploded/)
  assert.equal(statusSnapshot().aggregate.message, 'before', 'the working provider must survive a failed reconfigure')
})
