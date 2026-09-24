// Unit tests for server/ai/backlog.ts — which enrichment steps a note still
// needs under a residency map, and the legacy ai-marker migration.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stepsFor, backlogCount, deriveAiMarkers } from '../../../server/ai/backlog.ts'
import type { Residency } from '../../../server/ai/roles.ts'

const ALL_ON: Residency = { llm: 'ondemand', embed: 'always', vision: 'ondemand' }
const ALL_OFF: Residency = { llm: 'off', embed: 'off', vision: 'off' }

test('stepsFor: a bare note with everything on needs classify + embed', () => {
  assert.deepEqual(stepsFor({ ai: {} }, ALL_ON), ['classify', 'embed'])
})

test('stepsFor: completed markers remove steps', () => {
  assert.deepEqual(stepsFor({ ai: { classify: true, embed: true } }, ALL_ON), [])
})

test('stepsFor: off roles contribute no steps', () => {
  assert.deepEqual(stepsFor({ ai: {} }, ALL_OFF), [])
  assert.deepEqual(stepsFor({ ai: {} }, { ...ALL_ON, llm: 'off' }), ['embed'])
})

test('backlogCount: counts notes with at least one needed step', () => {
  const notes = [
    { ai: { classify: true, embed: true } }, // done
    { ai: {} }, // needs both
    { thumb: '/u/a.png', ai: { classify: true, embed: true } }, // needs thumbVision
  ]
  assert.equal(backlogCount(notes, ALL_ON), 2)
  assert.equal(backlogCount(notes, ALL_OFF), 0)
})

test('deriveAiMarkers: legacy enriched note infers embed, never classify', () => {
  const legacy = { category: 'Recipes', tags: ['x'], summary: 's', embedding: [0.1] }
  assert.deepEqual(deriveAiMarkers(legacy), { embed: true })
})

test('deriveAiMarkers: heuristic-only note infers nothing', () => {
  const note = { category: '', tags: [], summary: '', embedding: null }
  assert.deepEqual(deriveAiMarkers(note), {})
})

test('deriveAiMarkers: existing ai object is returned untouched', () => {
  const ai = { classify: true }
  assert.equal(deriveAiMarkers({ ai, embedding: [1] }), ai)
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
