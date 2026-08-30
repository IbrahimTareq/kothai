// Unit tests for server/ai/backlog.js — which enrichment steps a note still
// needs under a residency map, and the legacy ai-marker migration.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stepsFor, backlogCount, deriveAiMarkers } from '../../../server/ai/backlog.js'

const ALL_ON = { llm: 'ondemand', embed: 'always', vision: 'ondemand' }
const ALL_OFF = { llm: 'off', embed: 'off', vision: 'off' }

test('stepsFor: bare text note with everything on needs classify + embed', () => {
  assert.deepEqual(stepsFor({ ai: {} }, ALL_ON), ['classify', 'embed'])
})

test('stepsFor: image note also needs vision', () => {
  assert.deepEqual(stepsFor({ image: '/uploads/x.png', ai: {} }, ALL_ON), ['vision', 'classify', 'embed'])
})

test('stepsFor: completed markers remove steps', () => {
  const note = { image: '/uploads/x.png', ai: { vision: true, classify: true, embed: true } }
  assert.deepEqual(stepsFor(note, ALL_ON), [])
})

test('stepsFor: off roles contribute no steps', () => {
  assert.deepEqual(stepsFor({ image: '/uploads/x.png', ai: {} }, ALL_OFF), [])
  assert.deepEqual(stepsFor({ ai: {} }, { ...ALL_ON, llm: 'off' }), ['embed'])
})

test('stepsFor: vision only applies to image notes', () => {
  assert.deepEqual(stepsFor({ ai: { classify: true, embed: true } }, ALL_ON), [])
})

test('backlogCount: counts notes with at least one needed step', () => {
  const notes = [
    { ai: { classify: true, embed: true } },      // done
    { ai: {} },                                    // needs both
    { image: '/u/a.png', ai: { classify: true, embed: true } },  // needs vision
  ]
  assert.equal(backlogCount(notes, ALL_ON), 2)
  assert.equal(backlogCount(notes, ALL_OFF), 0)
})

test('deriveAiMarkers: legacy enriched note infers embed + vision, never classify', () => {
  const legacy = { category: 'Recipes', tags: ['x'], summary: 's', embedding: [0.1], image: '/u/a.png', description: 'a cat' }
  assert.deepEqual(deriveAiMarkers(legacy), { embed: true, vision: true })
})

test('deriveAiMarkers: heuristic-only note infers nothing', () => {
  assert.deepEqual(deriveAiMarkers({ category: '', tags: [], summary: '', embedding: null }), {})
})

test('deriveAiMarkers: existing ai object is returned untouched', () => {
  const ai = { classify: true }
  assert.equal(deriveAiMarkers({ ai, embedding: [1] }), ai)
})

// summary is also set by the vision step, independent of classify success —
// classify is never inferred from any field, so this stays unset regardless.
test('deriveAiMarkers: vision success alone does not imply classify succeeded', () => {
  const note = { image: '/u/a.png', description: 'a cat', summary: 'a cat' } // no embedding
  assert.deepEqual(deriveAiMarkers(note), { vision: true })
})

// addNote() defaults every note's category to 'General' at creation time,
// before any enrichment runs — classify is never inferred from any field.
test('deriveAiMarkers: creation-time default category alone does not imply classify succeeded', () => {
  const note = { category: 'General', tags: [], summary: '', embedding: null } // never enriched
  assert.deepEqual(deriveAiMarkers(note), {})
})

// embedding is written by three independent paths — the classify+embed
// pipeline, a manual tag-edit re-embed (handleUpdateNote), and a settings
// embedding-model-switch re-embed (handleSaveSettings) — only the first is
// classify-gated. classify must never be inferred from embedding presence,
// or notes touched by the other two paths get silently and permanently
// excluded from real classification.
test('deriveAiMarkers: embedding alone (e.g. from a tag-edit re-embed) does not imply classify succeeded', () => {
  const note = { embedding: [0.2, 0.4], tags: ['manually-added'], category: 'General' }
  assert.deepEqual(deriveAiMarkers(note), { embed: true })
})
