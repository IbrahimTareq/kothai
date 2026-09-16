// Container entrypoint. Starts as root so it can repair the ownership of
// bind-mounted volumes (every install before this ran as root, so existing
// data/ and models/ are root-owned), then drops to uid 1000 and hands off to
// the normal server entry. Outside Docker nothing uses this file — `npm start`
// still runs server/index.js directly.
//
// Deliberately uses Node's own chown/setuid instead of `chown`/`gosu`/`setpriv`
// so the image needs no extra apt packages and makes no assumption about which
// binaries the slim base ships.
import { mkdirSync, statSync, chownSync, lchownSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { DATA_DIR, MODELS_DIR, CONFIG_PATH } from '../server/config.ts'

const APP_UID = 1000 // the `node` user, already present in node:22-bookworm-slim
const APP_GID = 1000

// Only root can chown or drop privileges. Anyone else must skip both silently.
// `undefined` is the no-uid case (non-POSIX, where process.getuid does not
// exist) and answers the same as any non-root uid: do neither.
export function plan(uid: number | undefined) {
  const isRoot = uid === 0
  return { chown: isRoot, drop: isRoot }
}

function chownTree(target: string, uid: number, gid: number) {
  chownSync(target, uid, gid)
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const child = path.join(target, entry.name)
    // entry.isDirectory() is false for symlinks-to-dirs — intentional, avoids following links out of the volume
    if (entry.isDirectory()) chownTree(child, uid, gid)
    else lchownSync(child, uid, gid)
  }
}

// `recursive: false` is REQUIRED for the config file's parent, which by default
// is /app — recursing there would rewrite ownership across node_modules.
function ensureOwned(dir: string, { recursive }: { recursive: boolean }) {
  mkdirSync(dir, { recursive: true })
  if (statSync(dir).uid === APP_UID) return // already correct — the common case
  console.log(`  repairing ownership of ${dir}…`)
  if (recursive) chownTree(dir, APP_UID, APP_GID)
  else chownSync(dir, APP_UID, APP_GID)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { chown, drop } = plan(process.getuid?.())
  if (chown) {
    ensureOwned(DATA_DIR, { recursive: true })
    ensureOwned(MODELS_DIR, { recursive: true })
    ensureOwned(path.dirname(CONFIG_PATH), { recursive: false })
  }
  if (drop) {
    // @types/node declares getuid/setgid/setuid optional because Windows has
    // none of them, so these two calls need `?.` to typecheck. It cannot be
    // the silent no-op it looks like — leaving the container running as root
    // is the one failure this file exists to prevent: drop is true only when
    // getuid() answered 0, and a process with no getuid has no uid to be 0.
    process.setgid?.(APP_GID)
    process.setuid?.(APP_UID)
  }
  await import('../server/index.ts')
}
