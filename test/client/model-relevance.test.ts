// An endpoint's /v1/models is a catalogue of everything it sells, not a list of
// models for the job at hand. OpenAI returns ~70 ids, of which about four are
// plausible answers for any given role — the rest are image, audio, moderation
// and legacy completion models. Offering all of them for all three roles is
// what made the old datalist useless.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { relevantModels } from '../../client/domain/modelRelevance.ts'

// A realistic slice of what OpenAI actually lists.
const OPENAI = [
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4.1',
  'gpt-4.1-mini',
  'o3-mini',
  'text-embedding-3-small',
  'text-embedding-3-large',
  'text-embedding-ada-002',
  'dall-e-3',
  'tts-1',
  'tts-1-hd',
  'whisper-1',
  'omni-moderation-latest',
  'babbage-002',
  'davinci-002',
  'gpt-4o-audio-preview',
  'gpt-4o-realtime-preview',
]

test('the embedding role offers only embedding models', () => {
  const r = relevantModels('embed', OPENAI)
  assert.deepEqual(r.matched, ['text-embedding-3-small', 'text-embedding-3-large', 'text-embedding-ada-002'])
})

test('the language role hides embedding, audio, image and moderation models', () => {
  const { matched } = relevantModels('llm', OPENAI)
  for (const junk of ['text-embedding-3-small', 'dall-e-3', 'tts-1', 'whisper-1', 'omni-moderation-latest']) {
    assert.ok(!matched.includes(junk), `${junk} is not a language model`)
  }
  assert.ok(matched.includes('gpt-4o-mini'))
  assert.ok(matched.includes('o3-mini'))
})

test('the language role hides realtime and audio variants — they need another API', () => {
  const { matched } = relevantModels('llm', OPENAI)
  assert.ok(!matched.includes('gpt-4o-audio-preview'))
  assert.ok(!matched.includes('gpt-4o-realtime-preview'))
})

test('the vision role offers models that actually take images', () => {
  const { matched } = relevantModels('vision', OPENAI)
  assert.ok(matched.includes('gpt-4o'))
  assert.ok(!matched.includes('text-embedding-3-small'))
  assert.ok(!matched.includes('whisper-1'))
})

test('everything not matched is still reachable, never discarded', () => {
  const r = relevantModels('embed', OPENAI)
  assert.equal(r.matched.length + r.rest.length, OPENAI.length)
  assert.ok(r.rest.includes('dall-e-3'))
})

// Ollama ids look nothing like OpenAI's, and a rule tuned to one must not
// blank the other — an empty list is worse than an unfiltered one.
test('Ollama-style names still resolve', () => {
  const ollama = ['llama3.2:3b', 'qwen3:8b', 'nomic-embed-text', 'mxbai-embed-large', 'llama3.2-vision:11b']
  assert.deepEqual(relevantModels('embed', ollama).matched, ['nomic-embed-text', 'mxbai-embed-large'])
  assert.ok(relevantModels('vision', ollama).matched.includes('llama3.2-vision:11b'))
  assert.ok(relevantModels('llm', ollama).matched.includes('llama3.2:3b'))
})

test('an unrecognised catalogue falls back to offering everything', () => {
  const odd = ['model-a', 'model-b', 'model-c']
  const r = relevantModels('embed', odd)
  assert.deepEqual(r.matched, odd, 'better the whole list than an empty one')
  assert.deepEqual(r.rest, [])
})

test('an empty catalogue is empty, not a crash', () => {
  const r = relevantModels('llm', [])
  assert.deepEqual(r.matched, [])
  assert.deepEqual(r.rest, [])
})
