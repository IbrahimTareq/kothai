// Tests for server/import/pocket.ts. Fixtures follow Pocket's CSV export (both
// the current header with `cursor` and the older one without) with synthetic rows.
import test from 'node:test'
import assert from 'node:assert/strict'
import { sniff, parse, deriveNote } from '../../../server/import/pocket.ts'
import { findImporter } from '../../../server/import/index.ts'
import { deriveBookmarkNote } from '../../../server/import/bookmark.ts'

const files = (obj: Record<string, string>) => new Map(Object.entries(obj).map(([k, v]) => [k, Buffer.from(v)]))

const CURRENT = [
  'title,url,time_added,cursor,tags,status',
  'Example,https://example.org/a,1684913346,,tag1|tag2,unread',
  'Read,https://example.org/read,1712037544,MTcw,,archive',
].join('\n')
const OLDER = [
  'title,url,time_added,tags,status',
  'Example,https://example.org/a,1684913346,tag1|tag2,unread',
  'Read,https://example.org/read,1712037544,,archive',
].join('\n')

test('sniff: matches a part_NNNNNN.csv by name, and a renamed file by its header (title,url,time_added)', () => {
  assert.equal(sniff(files({ 'part_000000.csv': 'x' })), true)
  assert.equal(sniff(files({ 'export/part_000001.csv': 'x' })), true)
  assert.equal(sniff(files({ 'my-saves.csv': CURRENT })), true)
  assert.equal(sniff(files({ 'a.csv': 'title,note,excerpt,url,folder,tags,created\n' })), false)
  assert.equal(sniff(files({ 'a.csv': 'title,url,description,tags,created_at\n' })), false)
  assert.equal(sniff(files({ 'a.csv': 'url,title,note,tags,created,type\n' })), false)
})

test('parse: reads the current header with the cursor column', () => {
  const { items } = parse(files({ 'part_000000.csv': CURRENT }))
  assert.deepEqual(
    items.map(i => [i.title, i.savedAt, i.tags]),
    [
      ['Example', 1684913346, ['tag1', 'tag2']],
      ['Read', 1712037544, []],
    ],
  )
})

test('parse: reads the older header without the cursor column', () => {
  const { items } = parse(files({ 'part_000000.csv': OLDER }))
  assert.deepEqual(
    items.map(i => [i.title, i.savedAt, i.tags]),
    [
      ['Example', 1684913346, ['tag1', 'tag2']],
      ['Read', 1712037544, []],
    ],
  )
})

test('parse: rows across part_000000.csv and part_000001.csv are both read', () => {
  const { items } = parse(
    files({
      'part_000000.csv': 'title,url,time_added,tags,status\nA,https://a.example/,1684913346,,unread',
      'part_000001.csv': 'title,url,time_added,tags,status\nB,https://b.example/,1684913347,,unread',
    }),
  )
  assert.deepEqual(
    items.map(i => i.title),
    ['A', 'B'],
  )
})

test('parse: non-http and empty links are refused and counted', () => {
  const { items, warnings } = parse(
    files({
      'part_000000.csv':
        'title,url,time_added,tags,status\nF,ftp://example.net/,1,,unread\nJ,javascript:alert(1),1,,unread',
    }),
  )
  assert.equal(items.length, 0)
  assert.ok(
    warnings.some(w => w.includes('2')),
    JSON.stringify(warnings),
  )
})

test("parse: a CSV that is not Pocket's adds a warning instead of throwing", () => {
  const { items, warnings } = parse(files({ 'part_000000.csv': 'a,b\n1,2' }))
  assert.equal(items.length, 0)
  assert.ok(warnings.length > 0)
})

test('deriveNote is the shared bookmark derivation', () => {
  assert.equal(deriveNote, deriveBookmarkNote)
})

test('findImporter: a Pocket CSV routes to Pocket, and Instagram/TikTok exports still route to themselves', () => {
  assert.equal(findImporter(files({ 'part_000000.csv': CURRENT }))?.name, 'pocket')
  assert.equal(findImporter(files({ 'user_data_tiktok.json': '{"FavoriteVideoList":[]}' }))?.name, 'tiktok')
  assert.equal(
    findImporter(files({ 'your_instagram_activity/saved/saved_posts.json': '{"saved_saved_media":[]}' }))?.name,
    'instagram',
  )
})
