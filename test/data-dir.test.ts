// The suite must never open the checkout's own data/ folder. A test that
// reached the settings store without a data dir of its own (recovery.test.ts,
// once recovery asked reembed whether a sweep was owed) opened the developer's
// real data/kothai.db and reset its settings row: first run reopened and the
// library was marked as already re-embedded. `pnpm test` now points
// KOTHAI_DATA_DIR at a fresh temp dir for every test process; this holds it
// there. Run a single file with KOTHAI_DATA_DIR set too.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DATA_DIR } from '../server/config.ts'

const repoData = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data')

test('under the test runner, DATA_DIR is not the checkout’s data folder', () => {
  assert.notEqual(path.resolve(DATA_DIR), path.resolve(repoData))
})
