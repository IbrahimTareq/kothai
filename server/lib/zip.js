// Minimal read-only ZIP extraction — enough to open a Meta data-export ZIP.
// Supports stored (0) and deflated (8) entries; no zip64, no encryption, no
// CRC verification, no writing. Dependency-free on purpose: the server's
// zero-dependency rule is a feature, and imports are the only consumer.
//
// This module is the trust boundary for user-uploaded archives arriving over
// HTTP: every malformed or hostile input must produce a clean Error (never a
// RangeError, TypeError, or an uncatchable OOM abort) so the route handler
// can map it to a clean 400 instead of crashing the process.
import { inflateRawSync } from 'node:zlib'

const EOCD_SIG = 0x06054b50 // end of central directory
const CEN_SIG = 0x02014b50  // central directory file header
const LOC_SIG = 0x04034b50  // local file header

// Per-entry and whole-archive decompression caps. Deflate can amplify ~1000x,
// so an innocuous-looking few-MB upload can otherwise inflate to tens of GB
// and abort the process (inflateRawSync's internal allocation failure is not
// a catchable JS exception) — capping turns a zip bomb into a clean thrown
// Error instead of a downed server.
const MAX_ENTRY_BYTES = 64 * 1024 * 1024
export const MAX_TOTAL_BYTES = 512 * 1024 * 1024

// Guarded reads: every offset below ultimately originates in the file itself
// (the EOCD's central-directory offset, each entry's local-header offset,
// declared name/extra/comment lengths, ...), so a truncated or crafted
// archive can point anywhere — including past the end of the buffer. Node's
// Buffer#read* throws a RangeError for that, which would leak past this
// module as an uncaught-shape crash instead of the clean Error the HTTP
// layer expects to catch and turn into a 400.
function u16(buf, off) {
  if (off < 0 || off + 2 > buf.length) throw new Error('corrupt zip: offset out of range')
  return buf.readUInt16LE(off)
}
function u32(buf, off) {
  if (off < 0 || off + 4 > buf.length) throw new Error('corrupt zip: offset out of range')
  return buf.readUInt32LE(off)
}
function utf8(buf, start, end) {
  if (start < 0 || end > buf.length || end < start) throw new Error('corrupt zip: offset out of range')
  return buf.toString('utf8', start, end)
}

// A ZIP is read back-to-front: find the EOCD record (which may be followed
// by an archive comment up to 64 KB), then walk the central directory it
// points at. The 4-byte signature can legitimately appear inside that
// comment (or be forged there to redirect the scan), so a candidate only
// counts once its comment-length field agrees with how far it actually sits
// from the end of the buffer — that's what the standard EOCD scan checks.
function findEocd(buf) {
  if (buf.length < 22) return -1
  const min = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG && buf.readUInt16LE(i + 20) === buf.length - i - 22) return i
  }
  return -1
}

// Path-traversal / absolute-path guard. The next task extracts these names
// onto disk under an import directory, so this module — the trust boundary —
// rejects anything that could escape it before that code ever sees the name.
function assertSafeName(name) {
  if (
    name.length === 0 ||
    name.includes('\0') ||
    name.startsWith('/') ||
    name.includes('\\') ||
    name.split('/').includes('..')
  ) {
    throw new Error(`corrupt zip: unsafe entry name "${name}"`)
  }
}

// Returns Map<entryName, Buffer> of every file entry (directories skipped).
//
// `maxTotalBytes` lets a caller pass a SMALLER remaining budget than the
// module default. One import request can now carry several uploads (see
// server/routes/import.js), and a per-call cap would hand an attacker N x
// MAX_TOTAL_BYTES simply by splitting one bomb across N archives — the
// caller decrements a shared budget and passes what's left.
export function readZip(buf, { maxTotalBytes = MAX_TOTAL_BYTES } = {}) {
  if (!Buffer.isBuffer(buf)) throw new Error('readZip: expected a Buffer')
  // A non-positive or non-finite budget would make every entry below fail
  // in a confusing place; reject it up front as the caller's error.
  if (!Number.isFinite(maxTotalBytes) || maxTotalBytes <= 0) {
    throw new Error('zip exceeds maximum total extracted size')
  }

  const eocd = findEocd(buf)
  if (eocd < 0) throw new Error('not a zip archive')

  const count = u16(buf, eocd + 10)
  const cdSize = u32(buf, eocd + 12)
  const cdOffset = u32(buf, eocd + 16)
  // 0xffff / 0xffffffff are ZIP64 "see the extra record" sentinels, not
  // literal values — trusting them as literal would silently truncate the
  // entry count or misplace the central directory instead of failing loudly.
  // Real-world Instagram exports (a few thousand saved posts at most) never
  // need ZIP64, so we simply don't support it.
  if (count === 0xffff || cdOffset === 0xffffffff) {
    throw new Error('zip64 archives are not supported')
  }
  if (cdOffset + cdSize > buf.length) {
    throw new Error('corrupt zip: central directory out of range')
  }

  const files = new Map()
  const cdEnd = cdOffset + cdSize
  let total = 0 // running decompressed-bytes budget across the whole archive
  let p = cdOffset
  // Bound the walk by the central directory's byte SIZE, not the declared
  // entry `count` — count is attacker-controlled, and for genuine ZIP64
  // archives it's a sentinel rather than the true entry total anyway.
  while (p < cdEnd) {
    if (u32(buf, p) !== CEN_SIG) throw new Error('corrupt zip: bad central directory')
    const flags = u16(buf, p + 8)
    const method = u16(buf, p + 10)
    const compSize = u32(buf, p + 20)
    const nameLen = u16(buf, p + 28)
    const extraLen = u16(buf, p + 30)
    const commentLen = u16(buf, p + 32)
    const localOff = u32(buf, p + 42)
    const name = utf8(buf, p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + commentLen
    if (p > cdEnd) throw new Error('corrupt zip: bad central directory')

    if (name.endsWith('/')) continue // directory entry
    assertSafeName(name)
    if (flags & 0x1) throw new Error('encrypted zip not supported')

    if (u32(buf, localOff) !== LOC_SIG) throw new Error('corrupt zip: bad local header')
    // Local header can carry its own (different-length) extra field — read
    // the data position from the local header, but sizes from the central
    // directory (the authoritative copy; the local header's may be zero
    // when a trailing data descriptor is used instead).
    const lNameLen = u16(buf, localOff + 26)
    const lExtraLen = u16(buf, localOff + 28)
    const start = localOff + 30 + lNameLen + lExtraLen
    if (start < 0 || start + compSize > buf.length) {
      throw new Error(`corrupt zip: entry data out of range: ${name}`)
    }
    const data = buf.subarray(start, start + compSize)

    if (method === 0) {
      total += data.length
      if (total > maxTotalBytes) throw new Error(`zip exceeds maximum total extracted size (at entry: ${name})`)
      files.set(name, Buffer.from(data))
    } else if (method === 8) {
      const remaining = maxTotalBytes - total
      if (remaining <= 0) throw new Error(`zip exceeds maximum total extracted size (at entry: ${name})`)
      // budget < MAX_ENTRY_BYTES means the *total* archive budget, not this
      // entry's own cap, is what's actually binding — used below so the
      // thrown message names whichever limit really tripped.
      const budget = Math.min(MAX_ENTRY_BYTES, remaining)
      let out
      try {
        out = inflateRawSync(data, { maxOutputLength: budget })
      } catch (err) {
        if (err.code === 'ERR_BUFFER_TOO_LARGE') {
          throw new Error(
            budget < MAX_ENTRY_BYTES
              ? `zip exceeds maximum total extracted size (at entry: ${name})`
              : `corrupt zip: entry too large when decompressed: ${name}`
          )
        }
        // Any other inflate failure means the deflate stream itself is
        // broken, not that it's oversized — a different diagnosis, so it
        // gets a different message rather than being mislabeled as "too big".
        throw new Error(`corrupt zip: bad deflate stream: ${name}`)
      }
      // out.length can never exceed `budget` (maxOutputLength guarantees
      // that, or the catch above already threw), so no post-hoc total-cap
      // check is needed here.
      total += out.length
      files.set(name, out)
    } else {
      throw new Error(`unsupported zip compression method ${method}`)
    }
  }
  return files
}
