// The upgrade notice in the topbar, for an install whose on-device models were
// removed. At 375px its full sentence wrapped to three lines plus the link and
// the dismiss button, stacked in a column inside a band budgeted for two short
// lines, and its first line was cut off above the top edge.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = (path: string) => readFileSync(new URL(`../../client/${path}`, import.meta.url), 'utf8')
const phone = (css: string) => css.slice(css.indexOf('@media (max-width:640px)'))

test('the desktop line carries the whole notice, and a phone gets the short one', () => {
  const banner = src('components/Demo.tsx')
  assert.match(
    banner.replace(/\s+/g, ' '),
    /On-device models were removed\. Connect an endpoint to turn AI back on\. Ollama keeps everything on your machine\./,
  )
  assert.match(banner, /className="upgrade-short">On-device models were removed\.</)
  assert.match(src('styles/views/shell.css'), /\.upgrade-short\{display:none\}/)
  const css = phone(src('styles/foundation/responsive.css'))
  assert.match(css, /\.upgrade-long\{display:none\}/)
  assert.match(css, /\.upgrade-short\{display:inline\}/)
})

test('on a phone the notice is one row, so the dismiss button does not stack under the text', () => {
  assert.match(phone(src('styles/foundation/responsive.css')), /\.upgrade-banner\{flex-direction:row/)
})

test('the link opens the Connection panel’s picker, not just Settings', () => {
  assert.match(src('components/Demo.tsx'), /replaceState\(null, '', '\/settings#connect'\)/)
  assert.match(
    src('components/settings/ConnectionPanel.tsx'),
    /location\.hash === '#connect' && cfg\.source !== 'env' \? 'shared' : null/,
  )
})
