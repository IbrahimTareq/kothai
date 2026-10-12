// In Settings a model row committed on one tap: a multi-GB download, or for
// Embedding a re-index of every note, with no second step — while the
// Connection panel's switch to an endpoint states "up to X GB to download"
// first. Onboarding shares the picker but only selects, ahead of its own
// submit, so it stays one tap. Found by the first design critique (2026-10-11).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = (path: string) => readFileSync(new URL(`../../client/${path}`, import.meta.url), 'utf8')

function roleAccordion(file: string): string {
  const s = src(file)
  // \s, not the bare name: a comment in Settings.tsx mentions `<RoleAccordion>`.
  const at = s.search(/<RoleAccordion\s/)
  assert.ok(at >= 0, `${file} renders no <RoleAccordion>`)
  return s.slice(at, s.indexOf('/>', at))
}

test('Settings asks before a model switch commits', () => {
  assert.match(roleAccordion('views/Settings.tsx'), /\sconfirm\b/)
})

test('first-run onboarding still picks in one tap', () => {
  assert.doesNotMatch(roleAccordion('views/Onboarding.tsx'), /\sconfirm\b/)
})

test('the picker asks through <Confirm>, and its rows are a radiogroup', () => {
  const picker = src('components/settings/ModelPicker.tsx')
  assert.match(picker, /<Confirm\b/)
  assert.match(picker, /role="radiogroup"/)
  assert.match(picker, /role="radio"/)
  assert.match(picker, /aria-checked=/)
})
