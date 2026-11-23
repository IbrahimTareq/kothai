// Tests for server/import/omnivore.ts. Fixtures follow Omnivore's own export
// (metadata_<a>_to_<b>.json arrays, highlights/<slug>.md) with synthetic data.
import test from 'node:test'
import assert from 'node:assert/strict'
import { sniff, parse, deriveNote } from '../../../server/import/omnivore.ts'
import { findImporter } from '../../../server/import/index.ts'
import { deriveBookmarkNote } from '../../../server/import/bookmark.ts'

const files = (obj: Record<string, string>) => new Map(Object.entries(obj).map(([k, v]) => [k, Buffer.from(v)]))

const entry = (slug: string, extra: Record<string, unknown> = {}) => ({
  id: `id-${slug}`,
  slug,
  title: `Title ${slug}`,
  description: '',
  author: 'someone',
  url: `https://example.org/${slug}`,
  state: 'Active',
  readingProgress: 0,
  thumbnail: '',
  labels: [],
  savedAt: '2026-09-20T10:15:00.000Z',
  updatedAt: '2026-09-21T10:15:00.000Z',
  publishedAt: '2026-09-01T10:15:00.000Z',
  ...extra,
})
const meta = (...slugs: string[]) => JSON.stringify(slugs.map(s => entry(s)))

test('sniff: a metadata_0_to_20.json matches by name; a renamed one matches by its slug+savedAt keys', () => {
  assert.equal(sniff(files({ 'metadata_0_to_20.json': '[]' })), true)
  assert.equal(sniff(files({ 'export.json': meta('a') })), true)
  assert.equal(sniff(files({ 'export.json': '[{"url":"https://example.org"}]' })), false)
})

test('parse: items across several metadata files', () => {
  const a = JSON.stringify([entry('a', { labels: ['Read Later', 'Design'] }), entry('b')])
  const { items, warnings } = parse(files({ 'metadata_0_to_2.json': a, 'metadata_2_to_4.json': meta('c', 'd') }))
  assert.equal(items.length, 4)
  assert.deepEqual(items[0].tags, ['read later', 'design'])
  assert.equal(items[0].savedAt, Date.parse('2026-09-20T10:15:00.000Z') / 1000)
  assert.equal(items[0].url, 'https://example.org/a')
  assert.deepEqual(warnings, [])
})

test('parse: a highlights file joins its item by slug, zipped or loose', () => {
  const { items } = parse(
    files({
      '0/metadata_0_to_2.json': meta('my-post', 'other'),
      '0/highlights/my-post.md': '> quoted text',
      '3/unrelated.md': '> nobody owns this',
    }),
  )
  assert.equal(items[0].note, '> quoted text')
  assert.equal(items[1].note, '')
  const loose = parse(files({ '0/metadata_0_to_1.json': meta('my-post'), '3/my-post.md': '> quoted text' }))
  assert.equal(loose.items[0].note, '> quoted text')
})

test('parse: content/*.html in a ZIP is ignored, not parsed', () => {
  const { items, warnings } = parse(
    files({ 'metadata_0_to_1.json': meta('x'), 'content/x.html': '<html></html>', 'content/x.pdf': '%PDF' }),
  )
  assert.equal(items.length, 1)
  assert.deepEqual(warnings, [])
})

test('parse: 120 metadata files are all read', () => {
  const obj: Record<string, string> = {}
  for (let i = 0; i < 120; i++) obj[`metadata_${i}_to_${i + 1}.json`] = meta(`s${i}`)
  assert.equal(parse(files(obj)).items.length, 120)
})

test('parse: non-http links are counted in a warning; empty urls are not', () => {
  const bad = (url: string) => entry('x', { url })
  const one = parse(files({ 'metadata_0_to_2.json': JSON.stringify([bad('ftp://example.net/'), bad('')]) }))
  assert.equal(one.items.length, 0)
  assert.deepEqual(one.warnings, ['1 link was skipped because it was not an http(s) URL'])
  const two = parse(files({ 'metadata_0_to_2.json': JSON.stringify([bad('ftp://a/'), bad('javascript:alert(1)')]) }))
  assert.deepEqual(two.warnings, ['2 links were skipped because they were not http(s) URLs'])
})

test('parse: a metadata file that is not a JSON array adds a warning instead of throwing', () => {
  const { items, warnings } = parse(files({ 'metadata_0_to_1.json': '{"a":1}', 'metadata_1_to_2.json': 'nope' }))
  assert.equal(items.length, 0)
  assert.deepEqual(warnings, [
    'metadata_0_to_1.json is not an Omnivore metadata file (expected a JSON array)',
    'metadata_1_to_2.json is not an Omnivore metadata file (expected a JSON array)',
  ])
})

test('parse: archived items import like any other', () => {
  const json = JSON.stringify([entry('a', { state: 'Archived' })])
  assert.equal(parse(files({ 'metadata_0_to_1.json': json })).items.length, 1)
})

test('deriveNote is the shared bookmark derivation', () => {
  assert.equal(deriveNote, deriveBookmarkNote)
})

test('findImporter: an Omnivore metadata file routes to Omnivore', () => {
  assert.equal(findImporter(files({ 'metadata_0_to_1.json': meta('a') }))?.name, 'omnivore')
})
