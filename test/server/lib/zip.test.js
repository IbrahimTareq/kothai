import test from 'node:test'
import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'
import { readZip } from '../../../server/lib/zip.js'

// Test-only minimal ZIP writer: local header + central directory + EOCD.
// method: 0 = stored, 8 = deflated. `comment` (string or Buffer) becomes the
// archive comment trailing the EOCD record. `localExtra` (Buffer) is written
// into every entry's LOCAL header only, letting tests exercise the case
// where the local and central extra-field lengths differ (both are legal
// and real zip writers do this). Each entry's content (`text`) may be a
// string, a Buffer, or a zero-arg factory returning a Buffer — the factory
// form lets a decompression-bomb test allocate one large raw buffer at a
// time and let it go out of scope after deflating, instead of every raw
// buffer in a multi-entry archive being alive simultaneously.
function makeZip(entries, { method = 8, comment = '', localExtra = null } = {}) {
  const locals = []
  const centrals = []
  let offset = 0
  const extraBuf = localExtra ? Buffer.from(localExtra) : Buffer.alloc(0)
  for (const [name, text] of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const content = typeof text === 'function' ? text() : text
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    const data = method === 8 ? deflateRawSync(raw) : raw
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)            // version needed
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(0, 14)            // crc (unverified by reader)
    local.writeUInt32LE(data.length, 18)  // comp size
    local.writeUInt32LE(raw.length, 22)   // uncomp size
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(extraBuf.length, 28)
    const localFull = Buffer.concat([local, nameBuf, extraBuf, data])
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(0, 16)          // crc
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    // central extraLen intentionally left 0 — deliberately independent of
    // the local header's extra field length (see localExtra above).
    central.writeUInt32LE(offset, 42)     // local header offset
    centrals.push(Buffer.concat([central, nameBuf]))
    locals.push(localFull)
    offset += localFull.length
  }
  const cd = Buffer.concat(centrals)
  const commentBuf = Buffer.isBuffer(comment) ? comment : Buffer.from(comment, 'utf8')
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(commentBuf.length, 20)
  return Buffer.concat([...locals, cd, eocd, commentBuf])
}

// Shared helper for the "corrupt one field of a valid zip" tests below.
function cdStartOf(zip) {
  const eocdPos = zip.length - 22
  return eocdPos - zip.readUInt32LE(eocdPos + 12)
}

test('readZip: extracts deflated entries by name', () => {
  const zip = makeZip([
    ['your_instagram_activity/saved/saved_posts.json', '{"hello":"world"}'],
    ['media/readme.txt', 'nope'],
  ])
  const files = readZip(zip)
  assert.equal(files.size, 2)
  assert.equal(files.get('your_instagram_activity/saved/saved_posts.json').toString(), '{"hello":"world"}')
  assert.equal(files.get('media/readme.txt').toString(), 'nope')
})

test('readZip: extracts stored (uncompressed) entries', () => {
  const files = readZip(makeZip([['a.json', '[1,2,3]']], { method: 0 }))
  assert.equal(files.get('a.json').toString(), '[1,2,3]')
})

test('readZip: skips directory entries', () => {
  const files = readZip(makeZip([['dir/', ''], ['dir/f.txt', 'x']]))
  assert.equal(files.size, 1)
  assert.equal(files.get('dir/f.txt').toString(), 'x')
})

test('readZip: rejects non-zip input', () => {
  assert.throws(() => readZip(Buffer.from('definitely not a zip archive, no EOCD here')), /not a zip/i)
})

test('readZip: rejects unsupported compression method', () => {
  const zip = makeZip([['weird.bin', 'data']], { method: 0 })
  // readZip only consults the central directory's method field (never the
  // local header's), so that's the only place that needs corrupting here.
  zip.writeUInt16LE(99, cdStartOf(zip) + 10)
  assert.throws(() => readZip(zip), /compression/i)
})

test('readZip: empty zip (0 entries) returns an empty Map', () => {
  const files = readZip(makeZip([]))
  assert.equal(files.size, 0)
})

test('readZip: archive comment with a forged EOCD signature does not confuse the scan', () => {
  // Regression for a false-positive bug: the backward scan used to accept
  // any occurrence of the EOCD signature bytes, so a comment containing them
  // (accidentally or by a hostile crafter) would make the reader parse the
  // comment as if it were the real central directory. The fix cross-checks
  // each candidate's comment-length field against its actual distance from
  // the end of the buffer, so a forged signature inside a real comment must
  // not throw off the real EOCD it precedes.
  //
  // The scan starts at buf.length - 22 and walks backward, so a forged
  // signature only exercises that check if it sits at least 22 bytes before
  // EOF — anything in the final 21 bytes is never visited by either the old
  // or the new code and would make this test pass vacuously either way.
  // Here the signature starts 30 bytes before EOF (12-byte prefix, 4-byte
  // signature, 26 bytes of trailing filler).
  const forged = Buffer.concat([
    Buffer.from('junk before '), // 12 bytes
    Buffer.from([0x50, 0x4b, 0x05, 0x06]), // forged EOCD signature
    Buffer.alloc(26, 0x41), // 26 bytes of filler after the signature (>= 18 required)
  ])
  const zip = makeZip([['a.txt', 'hello']], { comment: forged })
  const files = readZip(zip)
  assert.equal(files.size, 1)
  assert.equal(files.get('a.txt').toString(), 'hello')
})

test('readZip: local header extra field length differing from central directory is handled', () => {
  // Real zip writers commonly attach different extra-field data (e.g.
  // Unix timestamps) to the local header than to the central directory
  // record for the same entry. The data offset must come from the local
  // header's own extra-length field, not the central directory's.
  const zip = makeZip([['a.txt', 'payload']], { localExtra: Buffer.from([0x01, 0x02, 0x03, 0x04]) })
  const files = readZip(zip)
  assert.equal(files.get('a.txt').toString(), 'payload')
})

test('readZip: rejects a truncated buffer (no full EOCD record present)', () => {
  const zip = makeZip([['a.txt', 'hi']])
  const truncated = zip.subarray(0, zip.length - 10)
  assert.throws(() => readZip(truncated), /corrupt zip|not a zip/i)
})

test('readZip: rejects an out-of-range central-directory offset', () => {
  const zip = makeZip([['a.txt', 'hi']])
  const eocdPos = zip.length - 22
  zip.writeUInt32LE(0xfffffff0, eocdPos + 16)
  assert.throws(() => readZip(zip), /corrupt zip|not a zip/i)
})

test('readZip: rejects an out-of-range local header offset', () => {
  const zip = makeZip([['a.txt', 'hi']])
  zip.writeUInt32LE(0xfffffff0, cdStartOf(zip) + 42)
  assert.throws(() => readZip(zip), /corrupt zip|not a zip/i)
})

test('readZip: rejects a compSize that overruns the buffer', () => {
  const zip = makeZip([['a.txt', 'hi']], { method: 0 })
  zip.writeUInt32LE(0xfffffff0, cdStartOf(zip) + 20)
  assert.throws(() => readZip(zip), /corrupt zip|not a zip/i)
})

test('readZip: rejects zip64 sentinel entry count (0xffff)', () => {
  const zip = makeZip([['a.txt', 'hi']])
  const eocdPos = zip.length - 22
  zip.writeUInt16LE(0xffff, eocdPos + 8)
  zip.writeUInt16LE(0xffff, eocdPos + 10)
  assert.throws(() => readZip(zip), /zip64/i)
})

test('readZip: rejects zip64 sentinel central-directory offset (0xffffffff)', () => {
  const zip = makeZip([['a.txt', 'hi']])
  const eocdPos = zip.length - 22
  zip.writeUInt32LE(0xffffffff, eocdPos + 16)
  assert.throws(() => readZip(zip), /zip64/i)
})

test('readZip: rejects path-traversal entry names', () => {
  const zip = makeZip([['../../etc/passwd', 'pwned']])
  assert.throws(() => readZip(zip), /corrupt zip/i)
})

test('readZip: rejects encrypted entries', () => {
  const zip = makeZip([['secret.txt', 'shh']])
  const cdStart = cdStartOf(zip)
  const flags = zip.readUInt16LE(cdStart + 8)
  zip.writeUInt16LE(flags | 0x1, cdStart + 8) // general-purpose bit 0 = encrypted
  assert.throws(() => readZip(zip), /encrypted/i)
})

test('readZip: rejects non-Buffer input', () => {
  assert.throws(() => readZip('not a buffer'), /buffer/i)
})

test('readZip: rejects a single entry that inflates past the per-entry cap', () => {
  // MAX_ENTRY_BYTES (64 MiB) is enforced via zlib's maxOutputLength, which
  // aborts the decompression before allocating the oversized output buffer -
  // that is what keeps a zip bomb from being able to OOM the process. Zeros
  // compress ~1029:1, so the archive on disk stays a few KB despite the
  // entry claiming to inflate past the cap.
  const OVER_ENTRY_CAP = 64 * 1024 * 1024 + 1024 * 1024 // 65 MiB raw, 1 MiB over the cap
  const zip = makeZip([['bomb.bin', () => Buffer.alloc(OVER_ENTRY_CAP)]])
  assert.throws(() => readZip(zip), /too large/i)
})

test('readZip: enforces the total decompressed-bytes budget across entries, not just per-entry', () => {
  // Proves the 512 MiB *total* cap is tracked cumulatively rather than reset
  // per entry: each of these 9 entries individually sits under the 64 MiB
  // per-entry cap, but their sum (540 MiB) crosses the total budget partway
  // through the last one. Entries are built from zero-arg factories (see
  // makeZip) so only one 60 MiB raw buffer is alive at a time while building
  // the archive - zeros compress ~1029:1, so what's retained afterward is
  // negligible until readZip itself decompresses each entry back out.
  const ENTRY_BYTES = 60 * 1024 * 1024 // comfortably under the 64 MiB per-entry cap
  const entries = Array.from({ length: 9 }, (_, i) => [`z${i}.bin`, () => Buffer.alloc(ENTRY_BYTES)])
  const zip = makeZip(entries)
  assert.throws(() => readZip(zip), /total/i)
})
