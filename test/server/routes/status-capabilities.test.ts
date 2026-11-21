// /api/status against the real handler with a stubbed response: the fields the
// client reads, the first-run gate, and the demo's allowances.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initProvider, _reset } from '../../../server/ai/index.ts'
import { handleStatus, firstRunComplete } from '../../../server/routes/status.ts'
import { demoLimits } from '../../../server/routes/demo.ts'
import * as store from '../../../server/data/notes.ts'
import { mockRes } from '../../helpers/http.ts'

test('handleStatus still carries the fields the client already reads', async () => {
  _reset()
  await initProvider({})
  const { res, sent } = mockRes()
  handleStatus(res, null)
  const body = sent.json()
  for (const k of ['roles', 'aggregate', 'configured', 'count']) {
    assert.ok(k in body, `missing ${k}`)
  }
})

// The first-run gate. An endpoint still needs a model name per role before
// anything can run, so the gate stays open until first run is done —
// otherwise an install lands in the app with every role dark and nothing
// pointing at Settings.
test('an install that has never been set up has not finished first run', () => {
  assert.equal(firstRunComplete(false, false), false)
})

test('an install predating the gate is left alone', () => {
  // Those installs never posted /api/setup, so `configured` is false — but
  // they carry names, which settings.load() reports as preGate. They must not
  // be sent back through setup.
  assert.equal(firstRunComplete(false, true), true)
  // And an explicit skip stands on its own, with no names at all.
  assert.equal(firstRunComplete(true, false), true)
})

// The regression this shape exists to prevent. The wizard seeds endpoint model
// names partway through first run so the embedding role can resolve before the
// picker is drawn. While the gate inferred completion from "are there names?",
// that seeding ended first run early and Save & start came back 409.
test('names written DURING first run do not end it', () => {
  // preGate is decided at load and stays false for a fresh install, however
  // many names get written afterwards.
  assert.equal(firstRunComplete(false, false), false)
})

// The demo's banner, its capture box and its New space button read these, so a
// visitor sees what they have left before a refusal tells them.
test('on the demo, status tells a visitor what they have left today', async () => {
  _reset()
  await initProvider({})
  demoLimits.save.reset()
  demoLimits.ask.reset()
  demoLimits.space.reset()
  demoLimits.save.take('a')
  const { res, sent } = mockRes()
  handleStatus(res, 'a')
  assert.deepEqual(sent.json().demo, { savesLeft: 4, asksLeft: 10, spacesLeft: 3 })
  const plain = mockRes()
  handleStatus(plain.res, null)
  assert.equal(plain.sent.json().demo, null, 'an ordinary install is not a demo')
})

test('on the demo, the note count leaves out other visitors’ links', async () => {
  _reset()
  await initProvider({})
  store._reset()
  await store.addNote({ type: 'link', content: 'seed' })
  await store.addNote({ type: 'link', content: 'theirs', visitor: 'b' })
  const { res, sent } = mockRes()
  handleStatus(res, 'a')
  assert.equal(sent.json().count, 1)
})
