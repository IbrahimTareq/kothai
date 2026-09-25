// Streaming ustar extraction — enough to unpack a Kothai backup
// (routes/backup.ts writes them). Plain files only; no links, no pax headers,
// no GNU long names. Dependency-free for the same reason as zip.ts.
//
// This is the trust boundary for a restore: the archive arrives over HTTP and
// every entry becomes a file on disk, so a name is only ever joined onto
// `dest` after it has been shown to stay inside it. Anything malformed must
// surface as a plain Error the route can answer with a 400.
//
// Streamed rather than buffered like zip.ts: a backup carries the whole
// library, uploads included — hundreds of MB on a real install, past what
// that module's in-memory 512 MB cap would take. With nothing held in memory
// there is no decompression-bomb abort to guard against; a disk that fills
// fails the write with ENOSPC, and the caller deletes what was extracted.
import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { once } from 'node:events'
import { finished } from 'node:stream/promises'
import path from 'node:path'

const BLOCK = 512

// One directory level at most (`uploads/<file>`), and no segment may start
// with a dot — which rules out `.` and `..` along with hidden files. An
// absolute name fails too: its first segment is empty.
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/
const safeName = (name: string) => {
  const parts = name.split('/')
  return parts.length <= 2 && parts.every(p => SEGMENT.test(p))
}

const field = (h: Buffer, start: number, len: number) => {
  const raw = h.subarray(start, start + len)
  const end = raw.indexOf(0)
  return raw.subarray(0, end === -1 ? len : end).toString('utf8')
}

// The checksum is the one thing that tells a tar header from arbitrary bytes:
// the sum of the header with its own checksum field read as spaces.
function checksumOk(h: Buffer): boolean {
  let sum = 8 * 0x20
  for (let i = 0; i < BLOCK; i++) if (i < 148 || i >= 156) sum += h[i]
  return Number.parseInt(field(h, 148, 8).trim(), 8) === sum
}

function parseHeader(h: Buffer): { name: string; size: number } {
  if (!checksumOk(h)) throw new Error('This is not a backup archive.')
  const name = field(h, 0, 100)
  const type = field(h, 156, 1)
  if (type !== '0' && type !== '') throw new Error(`The backup holds "${name}", which is not a plain file.`)
  if (!safeName(name)) throw new Error(`The backup holds "${name}", which is not a name a backup uses.`)
  // Octal digits only: base-256 sizes (high bit set) are for files over 8 GB.
  const digits = field(h, 124, 12).trim()
  if (!/^[0-7]+$/.test(digits)) throw new Error('This is not a backup archive.')
  return { name, size: Number.parseInt(digits, 8) }
}

// Extracts every entry of `input` (an uncompressed tar stream) under `dest`
// and answers the entry names in archive order. `dest` should be empty: an
// entry that already exists is an error rather than an overwrite.
export async function extractTar(input: AsyncIterable<Buffer>, dest: string): Promise<string[]> {
  const names: string[] = []
  let pending: Buffer = Buffer.alloc(0)
  let out: WriteStream | null = null
  let remaining = 0 // bytes of the current file still to write
  let padding = 0 // zero bytes that round the current file up to a block
  let ended = false // the zero block that closes the archive has been seen

  const close = async () => {
    const done = out
    out = null
    done?.end()
    if (done) await finished(done)
  }

  try {
    for await (const chunk of input) {
      // Past the end marker the rest is drained, not kept: tar pads its tail
      // with zeros, and anything longer is not ours to hold in memory. Not a
      // `break`, which would tear down the stream still feeding this one.
      if (ended) continue
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
      while (pending.length && !ended) {
        if (remaining) {
          const piece = pending.subarray(0, remaining)
          pending = pending.subarray(piece.length)
          remaining -= piece.length
          if (out && !out.write(piece)) await once(out, 'drain')
          if (!remaining) await close()
        } else if (padding) {
          const skip = Math.min(padding, pending.length)
          pending = pending.subarray(skip)
          padding -= skip
        } else if (pending.length < BLOCK) {
          break
        } else {
          const h = pending.subarray(0, BLOCK)
          pending = pending.subarray(BLOCK)
          if (h.every(b => b === 0)) {
            ended = true
            break
          }
          const { name, size } = parseHeader(h)
          await mkdir(path.dirname(path.join(dest, name)), { recursive: true })
          out = createWriteStream(path.join(dest, name), { flags: 'wx' })
          names.push(name)
          remaining = size
          padding = (BLOCK - (size % BLOCK)) % BLOCK
          if (!size) await close()
        }
      }
    }
    if (!ended) throw new Error('The backup archive is cut off — it may not have finished downloading.')
    return names
  } finally {
    out?.destroy()
  }
}
