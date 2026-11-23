// Tests for server/import/mymind.ts. Fixtures follow mymind's "Export my mind"
// cards.csv with synthetic rows.
import test from 'node:test'
import assert from 'node:assert/strict'
import { sniff, parse, deriveNote } from '../../../server/import/mymind.ts'
import { findImporter } from '../../../server/import/index.ts'
import { deriveBookmarkNote } from '../../../server/import/bookmark.ts'

const files = (obj: Record<string, string>) => new Map(Object.entries(obj).map(([k, v]) => [k, Buffer.from(v)]))

const HEADER = 'id,type,title,url,content,note,tags,created'
const DATE = '2024-01-05T12:00:00Z'

test('sniff: cards.csv matches by name; a renamed one by its header', () => {
  assert.equal(sniff(files({ 'export/cards.csv': 'anything\n' })), true)
  assert.equal(sniff(files({ 'mine.csv': `${HEADER}\n` })), true)
  assert.equal(sniff(files({ 'mine.csv': 'title,url,time_added,tags,status\n' })), false)
})

test('parse: link cards come in with tags and the card note', () => {
  const csv = `${HEADER}\na1,Article,A saved page,https://example.com/page,,Remember this,"design, inspiration",${DATE}`
  const { items, warnings } = parse(files({ 'cards.csv': csv }))
  assert.equal(items.length, 1)
  assert.equal(items[0].title, 'A saved page')
  assert.equal(items[0].note, 'Remember this')
  assert.deepEqual(items[0].tags, ['design', 'inspiration'])
  assert.equal(items[0].savedAt, Date.parse(DATE) / 1000)
  assert.deepEqual(warnings, [])
})

test('parse: notes and images without a link are counted, not imported (R3)', () => {
  const csv = [HEADER, `a2,Note,Grocery idea,,"Buy figs\nand honey",,food,${DATE}`, `a3,Image,,,,,,${DATE}`].join('\n')
  const { items, warnings } = parse(files({ 'cards.csv': csv }))
  assert.equal(items.length, 0)
  assert.deepEqual(warnings, ["1 note and 1 image from mymind have no link and weren't imported."])
})

test('parse: the warning pluralises each part and omits a zero part; unknown types count as notes', () => {
  const row = (type: string) => `x,${type},T,,,,,${DATE}`
  const notes = parse(files({ 'cards.csv': [HEADER, row('Note'), row('Note'), row('Note')].join('\n') }))
  assert.deepEqual(notes.warnings, ["3 notes from mymind have no link and weren't imported."])
  const mixed = parse(files({ 'cards.csv': [HEADER, row('Image'), row('Image'), row('Audio')].join('\n') }))
  assert.deepEqual(mixed.warnings, ["1 note and 2 images from mymind have no link and weren't imported."])
  const images = parse(files({ 'cards.csv': [HEADER, row('Image')].join('\n') }))
  assert.deepEqual(images.warnings, ["1 image from mymind have no link and weren't imported."])
})

test('parse: a non-http link is a separate refused-link warning, not a no-link card', () => {
  const csv = [HEADER, `a,Article,A,ftp://example.net/,,,,${DATE}`, `b,Article,B,javascript:alert(1),,,,${DATE}`].join(
    '\n',
  )
  const { items, warnings } = parse(files({ 'cards.csv': csv }))
  assert.equal(items.length, 0)
  assert.deepEqual(warnings, ['2 links were skipped because they were not http(s) URLs'])
})

test('parse: a cards.csv with the wrong header warns instead of throwing', () => {
  const { items, warnings } = parse(files({ 'cards.csv': 'a,b\n1,2' }))
  assert.equal(items.length, 0)
  assert.deepEqual(warnings, ['cards.csv is not a mymind export (expected type, url, content and note columns)'])
})

test('deriveNote is the shared bookmark derivation', () => {
  assert.equal(deriveNote, deriveBookmarkNote)
})

test('findImporter: each CSV header routes to its own importer', () => {
  assert.equal(findImporter(files({ 'a.csv': `${HEADER}\n` }))?.name, 'mymind')
  assert.equal(
    findImporter(files({ 'a.csv': 'id,title,note,excerpt,url,folder,tags,created,cover,highlights,favorite\n' }))?.name,
    'raindrop',
  )
  assert.equal(findImporter(files({ 'a.csv': 'title,url,time_added,tags,status\n' }))?.name, 'pocket')
})
