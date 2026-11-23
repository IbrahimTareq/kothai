import test from 'node:test'
import assert from 'node:assert/strict'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { readCsv, csvHeader } from '../../../server/import/csv.ts'

const buf = (s: string) => Buffer.from(s)

test('readCsv: quoted cells keep commas, doubled quotes and newlines', () => {
  const { rows } = readCsv(buf('a,b\n"x, y","say ""hi""\nthere"\n'))
  assert.deepEqual(rows, [{ a: 'x, y', b: 'say "hi"\nthere' }])
})

test('readCsv: BOM, CRLF and a trailing blank line parse like a clean file', () => {
  const { header, rows } = readCsv(buf('﻿a,b\r\n1,2\r\n\r\n'))
  assert.deepEqual(header, ['a', 'b'])
  assert.deepEqual(rows, [{ a: '1', b: '2' }])
})

test('readCsv: the header is trimmed and lower-cased', () => {
  assert.deepEqual(readCsv(buf(' Title , URL \nx,y\n')).header, ['title', 'url'])
})

test('readCsv: a short row fills missing cells with empty strings; a long row extra cells are dropped', () => {
  const { rows } = readCsv(buf('a,b,c\n1\n1,2,3,4,5\n'))
  assert.deepEqual(rows, [
    { a: '1', b: '', c: '' },
    { a: '1', b: '2', c: '3' },
  ])
})

test('readCsv: maxRows truncates and says so', () => {
  const r = readCsv(buf('a\n1\n2\n3\n'), 2)
  assert.equal(r.rows.length, 2)
  assert.equal(r.truncated, true)
  assert.equal(readCsv(buf('a\n1\n2\n'), 2).truncated, false)
})

test('readCsv: an unterminated quote reads to end of file without throwing, and says so', () => {
  const { rows, unterminated } = readCsv(buf('a,b\n1,"never closed\nstill going'))
  assert.deepEqual(rows, [{ a: '1', b: 'never closed\nstill going' }])
  assert.equal(unterminated, true)
  assert.equal(readCsv(buf('a,b\n1,"closed"\n')).unterminated, false)
})

// A Pocket title `A 5" screen review` sits unquoted in the export. Opening
// quote mode on it swallowed every later row into one cell, and the import
// reported an empty export.
test('readCsv: a quote inside an unquoted cell is a literal character, not the start of a quoted cell', () => {
  const { rows, unterminated } = readCsv(buf('t,u\nA 5" screen review,x\nB,y\nC,z\n'))
  assert.deepEqual(rows, [
    { t: 'A 5" screen review', u: 'x' },
    { t: 'B', u: 'y' },
    { t: 'C', u: 'z' },
  ])
  assert.equal(unterminated, false)
})

// `cell += ch` built a one-character cons-string per byte, kept unflattened in
// the rows: a 45 MB export held 1.4 GB of heap after GC, and a ZIP entry may be
// 64 MB, so one upload could OOM the container.
test('readCsv: a 20 MB export is held in a small multiple of its size, not ~30x', () => {
  setFlagsFromString('--expose-gc')
  const gc = runInNewContext('gc') as () => void
  const note = 'a thought about this page, '.repeat(16)
  const row = `https://example.com/x,"${note}"\n`
  const input = buf(`url,note\n${row.repeat(Math.ceil(20_000_000 / row.length))}`)
  gc()
  const before = process.memoryUsage().heapUsed
  const { rows } = readCsv(input)
  gc()
  const grown = process.memoryUsage().heapUsed - before
  assert.ok(rows.length > 40_000)
  assert.ok(
    grown < input.length * 4,
    `heap grew ${Math.round(grown / 1e6)} MB for ${Math.round(input.length / 1e6)} MB`,
  )
})

test('readCsv: a lone CR ends a row, and a cell is clipped to 20000 characters', () => {
  assert.deepEqual(readCsv(buf('a\r1\r2')).rows, [{ a: '1' }, { a: '2' }])
  assert.equal(readCsv(buf(`a\n${'x'.repeat(30_000)}\n`)).rows[0]!.a.length, 20_000)
})

test('csvHeader: reads only the first line, lower-cased', () => {
  assert.deepEqual(csvHeader(buf('﻿Title,URL\nrow,data\n')), ['title', 'url'])
  assert.deepEqual(csvHeader(buf(`${'a,'.repeat(5000)}\nz`)).length < 5000, true)
})
