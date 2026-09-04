// Display rules for the model download cache (/api/models/files).
//
// Pure on purpose: the row in Settings is thin, and everything here is the part
// worth pinning down in tests — cache entries are named for the SDK, not for
// the person deciding what to delete.
import type { ModelFile } from '../types'

// Cache filenames are `<sha256(registryPath)[:16]>_<registry basename>`. The
// hash is noise to the user and, at 16 hex characters in front of every entry,
// noise that pushes the part they need off a phone-width row. Anchored and
// length-exact so a model whose own name happens to contain hex isn't trimmed.
const CACHE_PREFIX = /^[0-9a-f]{16}_/

export function fileLabel(f: ModelFile): string {
  if (f.kind === 'dir') return `${f.name} — companion files`
  return f.name.replace(CACHE_PREFIX, '').replace(/\.gguf$/, '')
}

// GB once it earns the unit, MB below that. The presets elsewhere in Settings
// are all multi-GB so fmtGB is right there; here the list runs from a 278 MB
// embedding model to a 2.5 GB LLM, and rounding the small end to "0.3 GB"
// hides exactly the difference the user is weighing up.
export function fmtSize(bytes: number): string {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB'
  return Math.round(bytes / 1e6) + ' MB'
}

export function storageSummary({ totalBytes, reclaimableBytes }: { totalBytes: number; reclaimableBytes: number }): string {
  const head = `${fmtSize(totalBytes)} downloaded`
  return reclaimableBytes > 0
    ? `${head} · ${fmtSize(reclaimableBytes)} can be freed`
    : `${head} · nothing to free — every file is in use`
}
