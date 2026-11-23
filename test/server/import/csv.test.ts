import test from 'node:test'
import assert from 'node:assert/strict'
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

test('readCsv: an unterminated quote reads to end of file without throwing', () => {
  const { rows } = readCsv(buf('a,b\n1,"never closed\nstill going'))
  assert.deepEqual(rows, [{ a: '1', b: 'never closed\nstill going' }])
})

test('readCsv: a lone CR ends a row, and a cell is clipped to 20000 characters', () => {
  assert.deepEqual(readCsv(buf('a\r1\r2')).rows, [{ a: '1' }, { a: '2' }])
  assert.equal(readCsv(buf(`a\n${'x'.repeat(30_000)}\n`)).rows[0]!.a.length, 20_000)
})

test('csvHeader: reads only the first line, lower-cased', () => {
  assert.deepEqual(csvHeader(buf('﻿Title,URL\nrow,data\n')), ['title', 'url'])
  assert.deepEqual(csvHeader(buf(`${'a,'.repeat(5000)}\nz`)).length < 5000, true)
})
