// How an embedding vector is stored on disk, shared by the two tables that
// hold one (notes.embedding and tag_vocab.embedding).
//
// Float32 bytes rather than JSON text. As decimal text a 768-dim vector is
// ~15 KB; as float32 it is 3 KB. float32 is what the models emit anyway, and
// cosine similarity over these vectors is unaffected by the last few digits of
// mantissa — the ranking is identical.
export function encodeEmbedding(embedding) {
  if (!embedding || !embedding.length) return null
  return new Uint8Array(Float32Array.from(embedding).buffer)
}

// node:sqlite returns a BLOB as a Uint8Array that may be a view into a larger
// buffer at an arbitrary byte offset. Float32Array cannot be constructed over
// an offset that is not a multiple of 4, so this copies rather than views —
// the copy is the correctness fix, not an oversight.
export function decodeEmbedding(blob) {
  if (!blob || !blob.byteLength) return null
  const bytes = Uint8Array.from(blob)
  return new Float32Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 4))
}
