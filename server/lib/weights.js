// The model cache on disk — what QVAC downloaded, and what can be deleted.
//
// QVAC writes weights into MODELS_DIR and never prunes: switching the LLM
// preset once leaves the old multi-GB file there forever, and a preset dropped
// from the catalogue leaves a file nothing in the app can even name. This
// module is the file-level view of that directory, deliberately knowing
// nothing about presets or roles — the caller passes in which registry
// filenames are spoken for and gets back an annotated listing.
//
// Being wrong in the "not in use" direction costs the user a multi-GB
// re-download, so the in-use test matches on the registry BASENAME
// (`Qwen3-4B-Q4_K_M.gguf`) and not on the SDK's full cache filename, which
// carries a `sha256(registryPath)[:16]_` prefix that is an @qvac/sdk internal
// and can change under us. A basename collision between two presets makes both
// files look in use — over-protective, never under-protective.
import { readdir, stat, rm } from 'node:fs/promises'
import path from 'node:path'

// A cache entry is one direct child of MODELS_DIR: a `.gguf` file, or a
// companion-set / shard directory. Names come off the wire on the delete path,
// so this is the only thing standing between a DELETE and an arbitrary path —
// no separators, no traversal, no leading dot (which would also let a request
// name `.` or `..` and would only ever match OS cruft like .DS_Store anyway).
export function isSafeEntryName(name) {
  return typeof name === 'string' && name.length > 0 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
}

// Total bytes under a directory. Cheap enough to do eagerly: a companion set
// is a handful of files, and the alternative (reporting a directory with no
// size) makes the listing useless for deciding what to delete.
async function dirSize(dir) {
  let total = 0
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) total += await dirSize(full)
    else total += (await stat(full)).size
  }
  return total
}

// Every filename anywhere under a directory, so a set directory holding an
// in-use file is protected as a whole.
async function fileNames(dir) {
  const out = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...(await fileNames(path.join(dir, e.name))))
    else out.push(e.name)
  }
  return out
}

/**
 * List the model cache.
 *
 * @param dir          MODELS_DIR
 * @param inUse        { [registryBasename]: role } — see the note above on why
 *                     this is keyed by basename rather than cache filename.
 * @returns { entries, totalBytes, reclaimableBytes }, entries largest first.
 */
export async function scanWeights(dir, inUse = {}) {
  let dirents
  try {
    dirents = await readdir(dir, { withFileTypes: true })
  } catch {
    // No models dir yet (fresh install, or a remote-only deployment that never
    // downloads weights) is an empty cache, not an error.
    return { entries: [], totalBytes: 0, reclaimableBytes: 0 }
  }

  const entries = []
  for (const e of dirents) {
    if (e.name.startsWith('.')) continue
    const full = path.join(dir, e.name)
    const isDir = e.isDirectory()
    // A cache file's name is `<hash>_<registry basename>`, so endsWith() is
    // what turns the basename map into a match. Bare equality also holds for
    // any entry the SDK cached unprefixed.
    const used = isDir
      ? (await fileNames(full)).map((n) => inUse[n]).find(Boolean) || null
      : Object.entries(inUse).find(([base]) => e.name === base || e.name.endsWith(`_${base}`))?.[1] || null
    entries.push({
      name: e.name,
      kind: isDir ? 'dir' : 'file',
      sizeBytes: isDir ? await dirSize(full) : (await stat(full)).size,
      inUse: Boolean(used),
      usedBy: used,
    })
  }

  entries.sort((a, b) => b.sizeBytes - a.sizeBytes)
  return {
    entries,
    totalBytes: entries.reduce((n, e) => n + e.sizeBytes, 0),
    reclaimableBytes: entries.reduce((n, e) => (e.inUse ? n : n + e.sizeBytes), 0),
  }
}

function fail(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

// Delete one cache entry. Callers decide whether the entry is deletable (see
// the route's in-use check); this only enforces that the name addresses
// something inside `dir`.
export async function removeWeight(dir, name) {
  if (!isSafeEntryName(name)) throw fail('invalid_name', `Not a model cache entry: ${name}`)
  const full = path.join(dir, name)
  let freedBytes
  try {
    const s = await stat(full)
    freedBytes = s.isDirectory() ? await dirSize(full) : s.size
  } catch {
    throw fail('not_found', `No such model file: ${name}`)
  }
  await rm(full, { recursive: true, force: true })
  return { freedBytes }
}
