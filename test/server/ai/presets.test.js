// Unit tests for server/ai/presets.js — the pure model-preset catalogue.
// It must stay free of @qvac/sdk imports: the lite image has no local
// provider but still needs DEFAULTS, because the settings table's
// llm/embed/vision columns are NOT NULL.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PRESETS, DEFAULTS } from '../../../server/ai/presets.js'

test('every role has at least one preset', () => {
  for (const role of ['llm', 'embed', 'vision']) {
    assert.ok(PRESETS[role].length > 0, `${role} has no presets`)
  }
})

test('every DEFAULTS key names a preset that actually exists', () => {
  for (const role of ['llm', 'embed', 'vision']) {
    assert.ok(
      PRESETS[role].some((p) => p.key === DEFAULTS[role]),
      `DEFAULTS.${role} = ${DEFAULTS[role]} is not in PRESETS.${role}`,
    )
  }
})

test('every vision preset carries a projection model key', () => {
  for (const p of PRESETS.vision) assert.ok(p.proj, `${p.key} has no proj`)
})

test('presets.js imports no SDK — it must load in the lite image', () => {
  const src = readFileSync(new URL('../../../server/ai/presets.js', import.meta.url), 'utf8')
  assert.ok(!/@qvac/.test(src), 'presets.js must not reference @qvac')
})
