// Regression test for the enrichNote step-gating bug: a note missing only
// one step (per stepsFor) must not have OTHER already-completed steps
// recomputed. This is exactly the composition enrichNote relies on — full
// coverage of stepsFor's own logic already lives in test/backlog.test.js;
// this test locks in the specific data-loss scenario found in review.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stepsFor } from '../../../server/ai/backlog.js'

const ALL_ON = { llm: 'ondemand', embed: 'always', vision: 'ondemand' }

test('a note with classify+embed already done and manually-edited tags only needs vision — classify/embed must not be in its step list', () => {
  const note = {
    image: '/uploads/cat.png',
    tags: ['user-picked-this-tag'], // manually edited by the user after classify ran
    ai: { classify: true, embed: true }, // vision missing — e.g. saved back when vision was off
  }
  const steps = stepsFor(note, ALL_ON)
  assert.deepEqual(steps, ['vision'])
  assert.ok(!steps.includes('classify'), 'classify must not rerun — it would overwrite the manually-edited tags')
  assert.ok(!steps.includes('embed'), 'embed must not rerun — nothing changed that would need a new embedding')
})

test('a brand-new note (no ai markers yet) needs every applicable step', () => {
  const freshNote = { image: '/uploads/new.png' } // no `ai` field at all — matches addNote()'s shape
  assert.deepEqual(stepsFor(freshNote, ALL_ON), ['vision', 'classify', 'embed'])
})
