// The site's own public/ holds the files only the site publishes — CNAME and
// install.sh. The logo and the two font faces below are the app's, referenced
// by the head links in config.ts and by @font-face in theme/custom.css, and a
// second committed copy of a woff2 is a copy that goes stale silently.
//
// So they are mirrored in (gitignored) rather than duplicated, the same trade
// syncDocs makes for the markdown. The list is the whole contract: if the site
// starts using another app asset, it goes here.
import { cpSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

const SHARED = [
  'logo.svg',
  'vendor/fonts/Geist-latin.woff2',
  'vendor/fonts/GeistMono-latin.woff2',
]

export function syncAssets(from: string, to: string): void {
  for (const name of SHARED) {
    const src = join(from, name)
    const dest = join(to, name)
    if (!existsSync(src)) throw new Error(`sync-assets: ${name} is missing from ${from}`)
    mkdirSync(dirname(dest), { recursive: true })
    // Skip untouched files so dev-server watchers do not see a write on boot.
    if (existsSync(dest) && statSync(dest).mtimeMs >= statSync(src).mtimeMs) continue
    cpSync(src, dest)
  }
}
