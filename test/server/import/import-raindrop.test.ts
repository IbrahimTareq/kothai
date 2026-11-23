// Tests for server/import/raindrop.ts. Fixtures follow Raindrop's CSV export
// (Settings → Backups/Export) with synthetic rows.
import test from 'node:test'
import assert from 'node:assert/strict'
import { sniff, parse, deriveNote } from '../../../server/import/raindrop.ts'
import { findImporter } from '../../../server/import/index.ts'
import { deriveBookmarkNote } from '../../../server/import/bookmark.ts'

const files = (obj: Record<string, string>) => new Map(Object.entries(obj).map(([k, v]) => [k, Buffer.from(v)]))

const HEADER = 'id,title,note,excerpt,url,folder,tags,created,cover,highlights,favorite'

test("sniff: Raindrop's header matches; Pocket's and mymind's do not", () => {
  assert.equal(sniff(files({ 'Raindrop.csv': `${HEADER}\n` })), true)
  assert.equal(sniff(files({ 'a.csv': 'title,url,time_added,cursor,tags,status\n' })), false)
  assert.equal(sniff(files({ 'a.csv': 'url,title,note,tags,created,type\n' })), false)
})

test('parse: tags in one quoted comma cell, ISO date with ms, note and highlights into the note', () => {
  const csv = `${HEADER}\n1,Fonts,my note,ex,https://example.org/a,Design,"design, Fonts",2026-09-20T10:15:00.000Z,,a quote,false`
  const { items } = parse(files({ 'r.csv': csv }))
  assert.equal(items.length, 1)
  assert.deepEqual(items[0].tags, ['design', 'fonts'])
  assert.equal(items[0].savedAt, Date.parse('2026-09-20T10:15:00.000Z') / 1000)
  assert.equal(items[0].note, 'my note\n\na quote')
})

test('parse: a note alone, or highlights alone, is the note unchanged', () => {
  const csv = [
    HEADER,
    '1,A,only note,,https://example.org/a,,,2026-09-20T10:15:00.000Z,,,false',
    '2,B,,,https://example.org/b,,,2026-09-20T10:15:00.000Z,,only quote,false',
  ].join('\n')
  const { items } = parse(files({ 'r.csv': csv }))
  assert.deepEqual(
    items.map(i => i.note),
    ['only note', 'only quote'],
  )
})

test('parse: folders become collections; Unsorted does not', () => {
  const csv = [
    HEADER,
    '1,A,,,https://example.org/a,Design / Artists,,2026-09-20T10:15:00.000Z,,,false',
    '2,B,,,https://example.org/b,Design / Artists,,2026-09-20T10:15:00.000Z,,,false',
    '3,C,,,https://example.org/c,Unsorted,,2026-09-20T10:15:00.000Z,,,false',
  ].join('\n')
  const { collections } = parse(files({ 'r.csv': csv }))
  assert.deepEqual(collections, [
    { name: 'Design / Artists', urls: ['https://example.org/a', 'https://example.org/b'] },
  ])
})

test('parse: Unsorted is matched case-insensitively', () => {
  const csv = `${HEADER}\n1,A,,,https://example.org/a,unsorted,,2026-09-20T10:15:00.000Z,,,false`
  assert.deepEqual(parse(files({ 'r.csv': csv })).collections, [])
})

test('parse: non-http links are counted in a warning; empty urls are not', () => {
  const row = (url: string) => `1,A,,,${url},,,2026-09-20T10:15:00.000Z,,,false`
  const one = parse(files({ 'r.csv': [HEADER, row('ftp://example.net/'), row('')].join('\n') }))
  assert.equal(one.items.length, 0)
  assert.deepEqual(one.warnings, ['1 link was skipped because it was not an http(s) URL'])
  const two = parse(files({ 'r.csv': [HEADER, row('ftp://example.net/'), row('javascript:alert(1)')].join('\n') }))
  assert.deepEqual(two.warnings, ['2 links were skipped because they were not http(s) URLs'])
})

test("parse: a CSV that is not Raindrop's adds a warning instead of throwing", () => {
  const { items, warnings } = parse(files({ 'r.csv': 'a,b\n1,2' }))
  assert.equal(items.length, 0)
  assert.deepEqual(warnings, ['r.csv is not a Raindrop export (expected url, folder and excerpt columns)'])
})

test('deriveNote is the shared bookmark derivation', () => {
  assert.equal(deriveNote, deriveBookmarkNote)
})

test('findImporter: a Raindrop CSV routes to Raindrop, and Pocket still routes to itself', () => {
  assert.equal(findImporter(files({ 'r.csv': `${HEADER}\n` }))?.name, 'raindrop')
  assert.equal(findImporter(files({ 'part_000000.csv': 'title,url,time_added,tags,status\n' }))?.name, 'pocket')
})
