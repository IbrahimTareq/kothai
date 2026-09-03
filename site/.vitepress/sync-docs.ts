// The markdown lives in /docs at the repo root so it keeps rendering on GitHub
// and stays in the same commit as the code it describes. VitePress needs its
// pages inside its own package, though — with a srcDir outside it, every bare
// import in a compiled page resolves against the app's node_modules instead of
// this one, which breaks the SSR pass in ways that are not worth patching.
//
// So the pages are mirrored into site/src (gitignored) before VitePress scans
// them, and the mirror is watched in dev. /docs stays the only source of truth.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

export function syncDocs(from: string, to: string): void {
  mkdirSync(to, { recursive: true })

  const wanted = readdirSync(from).filter(
    (name) => name.endsWith('.md') && statSync(join(from, name)).isFile(),
  )

  // Drop anything the source no longer has, so a renamed or deleted doc cannot
  // linger in the mirror and get published.
  for (const stale of readdirSync(to)) {
    if (!wanted.includes(stale)) rmSync(join(to, stale), { recursive: true, force: true })
  }

  for (const name of wanted) {
    const src = join(from, name)
    const dest = join(to, name)
    // Skip untouched files so dev-server watchers do not see a write on boot.
    if (existsSync(dest) && statSync(dest).mtimeMs >= statSync(src).mtimeMs) continue
    cpSync(src, dest)
  }
}
