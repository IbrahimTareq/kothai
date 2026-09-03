// Unit tests for the provider-contract methods providers/local.js adds on top
// of its historical surface. The four inference calls do real model I/O and
// are covered by the cross-provider contract suite instead; these are the
// pure descriptor/validation methods the facade and routes depend on.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { capabilities, validateModel, weightsInUse } from '../../../../server/ai/providers/local.js'

test('capabilities reports a local provider that manages residency and downloads weights', () => {
  assert.deepEqual(capabilities(), { kind: 'local', managesResidency: true, downloadsWeights: true })
})

test('validateModel accepts a key from the preset catalogue', () => {
  assert.deepEqual(validateModel('llm', 'QWEN3_1_7B_INST_Q4'), { ok: true })
})

test('validateModel rejects a key that is not a known preset', () => {
  const r = validateModel('llm', 'gpt-4o-mini')
  assert.equal(r.ok, false)
  assert.match(r.error, /unknown llm model/)
})

// The model-cache endpoints need to know which files on disk the CURRENT
// selection depends on. Asserting real registry filenames is deliberate: the
// whole in-use check keys off these basenames, so if an @qvac/sdk bump renames
// one, that has to fail here rather than silently offering the user's active
// model up for deletion.
test('weightsInUse maps the selected models to their registry filenames, projector included', () => {
  const map = weightsInUse({
    llm: 'QWEN3_4B_INST_Q4_K_M',
    embed: 'EMBEDDINGGEMMA_300M_Q8_0',
    vision: 'QWEN3_5_2B_MULTIMODAL_Q4_K_M',
  })
  assert.deepEqual(map, {
    'Qwen3-4B-Q4_K_M.gguf': 'llm',
    'embeddinggemma-300M-Q8_0.gguf': 'embed',
    'Qwen3.5-2B-Q4_K_M.gguf': 'vision',
    // Vision is two files — dropping the projector breaks the model as surely
    // as dropping the weights.
    'mmproj-F16.gguf': 'vision',
  })
})

test('weightsInUse protects the default preset when the saved key is not a known one', () => {
  // Same fallback configureModels applies, so the file this protects is the
  // file the app would actually load.
  const map = weightsInUse({ llm: 'gpt-4o-mini' })
  assert.equal(map['Qwen3-1.7B-Q4_0.gguf'], 'llm')
})
