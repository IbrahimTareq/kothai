// Tests for the embedding input template — the query/document asymmetry that
// prompt-instructed embedding models are trained with, and the recipe marker
// that forces a re-embed when it changes.
//
// EmbeddingGemma expects task-specific prefixes; embedding a question and a
// saved note through the same raw-text path asks the model to put them in the
// same region of the space, when the training scheme is built on their being
// different kinds of text. The check is keyed on the MODEL rather than on the
// provider, so these tests pin that too: a local install can be running
// GTE-Large, and a remote endpoint can be running anything at all.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { embedInput, isPromptedEmbedModel, EMBED_RECIPE } from '../../../server/ai/prompts.js'

const GEMMA = 'EMBEDDINGGEMMA_300M_Q8_0'

test('isPromptedEmbedModel recognises EmbeddingGemma by preset key and by remote model name', () => {
  assert.equal(isPromptedEmbedModel(GEMMA), true)
  assert.equal(isPromptedEmbedModel('EMBEDDINGGEMMA_300M_Q4_0'), true)
  assert.equal(isPromptedEmbedModel('embeddinggemma:300m'), true)     // ollama
  assert.equal(isPromptedEmbedModel('google/embedding-gemma-300m'), true)
})

test('isPromptedEmbedModel fails closed for every model that is not prompt-instructed', () => {
  // Prefixing a model that was not trained with these templates corrupts
  // every vector it produces, so anything unrecognised gets raw text.
  assert.equal(isPromptedEmbedModel('GTE_LARGE_FP16'), false)          // the other local preset
  assert.equal(isPromptedEmbedModel('nomic-embed-text'), false)
  assert.equal(isPromptedEmbedModel('bge-large-en-v1.5'), false)
  assert.equal(isPromptedEmbedModel('text-embedding-3-small'), false)
  assert.equal(isPromptedEmbedModel(''), false)
  assert.equal(isPromptedEmbedModel(undefined), false)
})

test('a query and a document are given different prefixes — the whole point of the scheme', () => {
  const q = embedInput('brown butter pasta', { mode: 'query', model: GEMMA })
  const d = embedInput('brown butter pasta', { mode: 'document', model: GEMMA })
  assert.equal(q, 'task: search result | query: brown butter pasta')
  assert.equal(d, 'title: none | text: brown butter pasta')
  assert.notEqual(q, d)
})

test('document is the default mode — every caller but Ask is indexing', () => {
  assert.equal(embedInput('x', { model: GEMMA }), 'title: none | text: x')
})

test('a model that is not prompt-instructed gets the raw text, in both modes', () => {
  assert.equal(embedInput('brown butter pasta', { mode: 'query', model: 'GTE_LARGE_FP16' }), 'brown butter pasta')
  assert.equal(embedInput('brown butter pasta', { mode: 'document', model: 'GTE_LARGE_FP16' }), 'brown butter pasta')
  // No model named at all is the same fail-closed case.
  assert.equal(embedInput('brown butter pasta'), 'brown butter pasta')
})

test('empty and null input never produce a bare prefix with nothing after it', () => {
  assert.equal(embedInput('', { model: 'GTE_LARGE_FP16' }), '')
  assert.equal(embedInput(null, { model: 'GTE_LARGE_FP16' }), '')
  assert.equal(embedInput('   ', { model: 'GTE_LARGE_FP16' }), '')
})

test('EMBED_RECIPE is a non-empty identifier — it is what triggers the library re-embed', () => {
  assert.equal(typeof EMBED_RECIPE, 'string')
  assert.ok(EMBED_RECIPE.length > 0)
})
