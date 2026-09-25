// server/lib/tar.ts — extracting a backup archive the user uploads to restore.
//
// The archive is untrusted input that becomes files on disk, so the property
// that matters is that nothing in it can write outside the directory it is
// extracted into: not a climbing name, not an absolute one, not a link. The
// archives here are built by hand because a hostile one is exactly what a real
// tar tool refuses to produce.
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { extractTar } from '../../../server/lib/tar.ts'

const ROOT = mkdtempSync(path.join(os.tmpdir(), 'kothai-tar-test-'))
let dest = ''
beforeEach(() => {
  dest = mkdtempSync(path.join(ROOT, 'dest-'))
})
after(() => rmSync(ROOT, { recursive: true, force: true }))

// One ustar header, checksum included. `type` '0' is a regular file.
function header(name: string, size: number, type = '0'): Buffer {
  const h = Buffer.alloc(512)
  h.write(name, 0, 100)
  h.write('0000644\0', 100)
  h.write('0000000\0', 108)
  h.write('0000000\0', 116)
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124)
  h.write('00000000000\0', 136)
  h.write(type, 156)
  h.write('ustar\u000000', 257)
  h.fill(' ', 148, 156)
  const sum = h.reduce((a, b) => a + b, 0)
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  return h
}

function entry(name: string, body: Buffer | string, type = '0'): Buffer {
  const bytes = Buffer.from(body)
  return Buffer.concat([header(name, bytes.length, type), bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)])
}

const archive = (...entries: Buffer[]) => Buffer.concat([...entries, Buffer.alloc(1024)])

// A request body arrives in whatever pieces the network hands over, so a
// header or a file's last bytes can straddle any boundary.
function inChunks(bytes: Buffer, size: number): Readable {
  const pieces: Buffer[] = []
  for (let i = 0; i < bytes.length; i += size) pieces.push(bytes.subarray(i, i + size))
  return Readable.from(pieces)
}

const db = Buffer.from(Array.from({ length: 1300 }, (_, i) => i % 251))
const sample = archive(entry('kothai.db', db), entry('uploads/a.png', 'png'), entry('uploads/empty.txt', ''))

for (const size of [1, 100, 511, 513, sample.length]) {
  test(`extracts every file with its exact bytes, in ${size}-byte chunks`, async () => {
    const names = await extractTar(inChunks(sample, size), dest)
    assert.deepEqual(names, ['kothai.db', 'uploads/a.png', 'uploads/empty.txt'])
    assert.deepEqual(readFileSync(path.join(dest, 'kothai.db')), db)
    assert.equal(readFileSync(path.join(dest, 'uploads/a.png'), 'utf8'), 'png')
    assert.equal(readFileSync(path.join(dest, 'uploads/empty.txt'), 'utf8'), '')
  })
}

for (const name of ['../escape.txt', 'uploads/../../escape.txt', '/tmp/kothai-tar-escape.txt', '.hidden']) {
  test(`refuses the name ${name} rather than write outside the destination`, async () => {
    await assert.rejects(extractTar(Readable.from([archive(entry(name, 'x'))]), dest), { name: 'Error' })
    assert.equal(existsSync(path.join(ROOT, 'escape.txt')), false)
    assert.equal(existsSync('/tmp/kothai-tar-escape.txt'), false)
  })
}

for (const [type, kind] of [
  ['1', 'hard link'],
  ['2', 'symlink'],
  ['5', 'directory'],
]) {
  test(`refuses a ${kind} — only plain files belong in a backup`, async () => {
    await assert.rejects(extractTar(Readable.from([archive(entry('uploads/x', '', type))]), dest), { name: 'Error' })
  })
}

test('bytes that are not a tar archive fail with a clean Error, not a crash', async () => {
  const noise = Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 7919) % 256))
  await assert.rejects(extractTar(Readable.from([noise]), dest), { name: 'Error', message: /not a backup archive/ })
})

test('an archive cut off mid-file is an error, not a quietly shorter restore', async () => {
  const cut = entry('kothai.db', db).subarray(0, 900)
  await assert.rejects(extractTar(Readable.from([cut]), dest), { name: 'Error', message: /cut off/ })
})
