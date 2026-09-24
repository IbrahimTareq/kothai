import test from 'node:test'
import assert from 'node:assert/strict'
import { applyTheme } from '../../client/app/theme.ts'

function fakeDoc(theme?: string, transitions = true) {
  const faded: string[] = []
  const root = { dataset: theme ? { theme } : ({} as Record<string, string>) }
  const doc = {
    documentElement: root,
    startViewTransition: transitions
      ? (update: () => void) => {
          update()
          faded.push(root.dataset.theme)
        }
      : undefined,
  }
  return { doc: doc as unknown as Document, root, faded }
}

test('a theme switch crossfades', () => {
  const { doc, root, faded } = fakeDoc('dark')
  applyTheme(doc, 'light')
  assert.equal(root.dataset.theme, 'light')
  assert.deepEqual(faded, ['light'])
})

test('the first apply on load does not animate', () => {
  const { doc, root, faded } = fakeDoc()
  applyTheme(doc, 'light')
  assert.equal(root.dataset.theme, 'light')
  assert.deepEqual(faded, [])
})

test('re-applying the current theme does not animate', () => {
  const { doc, faded } = fakeDoc('dark')
  applyTheme(doc, 'dark')
  assert.deepEqual(faded, [])
})

test('without view transitions the theme still switches', () => {
  const { doc, root } = fakeDoc('dark', false)
  applyTheme(doc, 'light')
  assert.equal(root.dataset.theme, 'light')
})
