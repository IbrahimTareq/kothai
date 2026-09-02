// Tests for server/import/tiktok.js. Fixtures mirror the shape of a real
// "Download your data" JSON export (verified against one: 197 favourites, 13
// collections) but carry synthetic ids — a personal export is nobody's test
// fixture.
import test from 'node:test'
import assert from 'node:assert/strict'
import { sniff, parse, parseFavorites, parseCollectionNames, parseTikTokDate, canonicalVideoUrl, deriveNote } from '../../../server/import/tiktok.js'
import { findImporter } from '../../../server/import/index.js'

function files(obj) {
  return new Map(Object.entries(obj).map(([k, v]) => [k, Buffer.from(typeof v === 'string' ? v : JSON.stringify(v))]))
}

const share = (id) => `https://www.tiktokv.com/share/video/${id}/`

const EXPORT = {
  'Likes and Favorites': {
    Collection: {},
    'Favorite Collection': {
      FavoriteCollectionList: [
        { Date: '2025-02-11 04:19:36', FavoriteCollection: 'Umrah' },
        { Date: '2025-02-01 21:53:30', FavoriteCollection: 'Audio' },
      ],
    },
    'Favorite Effects': { FavoriteEffectsList: null },
    'Favorite Videos': {
      App: 1,
      FavoriteVideoList: [
        { Date: '2025-08-09 10:20:53', Link: share('7325881953608158497') },
        { Date: '2024-12-15 03:48:06', Link: share('7078467411363515691') },
      ],
    },
    'Like List': { App: 1, ItemFavoriteList: [{ Date: '2025-01-01 00:00:00', Link: share('999') }] },
  },
}

test('sniff: matches the export by filename, and by content when it has been renamed', () => {
  assert.equal(sniff(files({ 'user_data_tiktok.json': EXPORT })), true)
  assert.equal(sniff(files({ 'user_data.json': EXPORT })), true)
  assert.equal(sniff(files({ 'my-tiktok-stuff.json': EXPORT })), true, 'content probe covers a renamed download')
  assert.equal(sniff(files({ 'saved_posts.json': { saved_saved_media: [] } })), false)
})

test('findImporter: an Instagram export still routes to Instagram, a TikTok one to TikTok', () => {
  assert.equal(findImporter(files({ 'user_data_tiktok.json': EXPORT }))?.name, 'tiktok')
  assert.equal(
    findImporter(files({ 'your_instagram_activity/saved/saved_posts.json': { saved_saved_media: [{ title: 'x', string_map_data: { 'Saved on': { href: 'https://www.instagram.com/p/A/', timestamp: 1 } } }] } }))?.name,
    'instagram',
  )
})

test('canonicalVideoUrl: the export link is rewritten to the form oEmbed answers', () => {
  // Verified live: tiktok.com/oembed returns a caption, author and thumbnail
  // for /video/<id>, and a bare 400 for the tiktokv.com/share form.
  assert.equal(canonicalVideoUrl(share('7325881953608158497')), 'https://www.tiktok.com/video/7325881953608158497')
  assert.equal(canonicalVideoUrl('https://www.tiktok.com/@someone/video/123'), 'https://www.tiktok.com/video/123')
  assert.equal(canonicalVideoUrl('https://vm.tiktok.com/ZMabcdef/'), 'https://vm.tiktok.com/ZMabcdef/', 'a short link has no readable id — left alone rather than guessed at')
})

test('parseTikTokDate: the bare export timestamp is read as UTC, not local time', () => {
  assert.equal(parseTikTokDate('2025-08-09 10:20:53'), Date.UTC(2025, 7, 9, 10, 20, 53) / 1000)
  assert.equal(parseTikTokDate('not a date'), 0)
  assert.equal(parseTikTokDate(null), 0)
})

test('parse: favourites become items; likes and collection membership do not', () => {
  const result = parse(files({ 'user_data_tiktok.json': EXPORT }))
  assert.equal(result.items.length, 2, 'the Like List is deliberately not imported')
  assert.deepEqual(result.items.map((i) => i.url), [
    'https://www.tiktok.com/video/7325881953608158497',
    'https://www.tiktok.com/video/7078467411363515691',
  ])
  assert.deepEqual(result.collections, [], 'no membership in the export, so no Spaces to create')
  assert.ok(
    result.warnings.some((w) => /2 TikTok collection\(s\) found/.test(w) && /Umrah/.test(w)),
    `expected the collections to be reported, got ${JSON.stringify(result.warnings)}`,
  )
})

test('parse: an older export nesting the same lists under a different wrapper still reads', () => {
  // Only the WRAPPER has drifted between export versions; the list keys have
  // not, which is why the parser walks for them instead of pinning a path.
  const older = { Activity: { 'Favorite Videos': { FavoriteVideoList: [{ Date: '2024-01-01 00:00:00', Link: share('555') }] } } }
  const result = parse(files({ 'user_data.json': older }))
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].url, 'https://www.tiktok.com/video/555')
})

test('parse: an export with no favourites says so instead of reporting a silent zero', () => {
  const empty = { 'Likes and Favorites': { 'Favorite Videos': { FavoriteVideoList: [] } } }
  const result = parse(files({ 'user_data_tiktok.json': empty }))
  assert.equal(result.items.length, 0)
  assert.ok(result.warnings.some((w) => /no favourited videos/.test(w)), JSON.stringify(result.warnings))
})

test('parseFavorites: off-platform, non-http and oversized links are refused', () => {
  const rows = [
    { Date: '2025-01-01 00:00:00', Link: share('1') },
    { Date: '2025-01-01 00:00:00', Link: 'javascript:alert(1)' },
    { Date: '2025-01-01 00:00:00', Link: 'https://evil.example.com/video/2' },
    { Date: '2025-01-01 00:00:00', Link: `https://www.tiktokv.com/share/video/3/?x=${'a'.repeat(3000)}` },
    { Date: '2025-01-01 00:00:00' },
  ]
  const items = parseFavorites(rows)
  assert.equal(items.length, 1)
  assert.equal(items[0].url, 'https://www.tiktok.com/video/1')
  assert.equal(items.unusableUrl, 3, 'the row with no Link at all is not counted as a failure')
})

test('parseFavorites: the item cap is a budget the caller can shrink, and overflow is counted', () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ Date: '2025-01-01 00:00:00', Link: share(String(i)) }))
  const items = parseFavorites(rows, 2)
  assert.equal(items.length, 2)
  assert.equal(items.skipped, 3)
})

test('parse: a maliciously deep export degrades to a warning instead of blowing the stack', () => {
  let node = { FavoriteVideoList: [{ Date: '2025-01-01 00:00:00', Link: share('1') }] }
  for (let i = 0; i < 5000; i++) node = { nested: node }
  const result = parse(files({ 'user_data_tiktok.json': JSON.stringify(node) }))
  assert.equal(result.items.length, 0)
  assert.ok(result.warnings.some((w) => /too deeply nested/.test(w)), JSON.stringify(result.warnings))
})

test('parse: corrupt JSON is reported, not thrown', () => {
  const result = parse(new Map([['user_data_tiktok.json', Buffer.from('{"FavoriteVideoList": broken')]]))
  assert.equal(result.items.length, 0)
  assert.ok(result.warnings.some((w) => /could not be parsed/.test(w)))
})

test('parseCollectionNames: names are deduped and read from either key', () => {
  assert.deepEqual(
    parseCollectionNames([{ FavoriteCollection: 'Umrah' }, { FavoriteCollection: 'Umrah' }, { Name: 'Tools' }, { FavoriteCollection: '' }]),
    ['Umrah', 'Tools'],
  )
})

test('deriveNote: a favourite becomes a video note keeping its saved-on date', () => {
  const note = deriveNote({ url: 'https://www.tiktok.com/video/1', poster: '', savedAt: parseTikTokDate('2025-08-09 10:20:53') })
  assert.equal(note.type, 'video')
  assert.deepEqual(note.tags, ['tiktok'])
  assert.equal(note.url, 'https://www.tiktok.com/video/1')
  assert.equal(note.account, null, 'the export carries no handle — enrichment fills it in from oEmbed')
  assert.equal(note.title, 'TikTok video')
  assert.equal(note.createdAt, '2025-08-09T10:20:53.000Z')
  assert.equal(note.pending, true)
})

test('deriveNote: an absent or absurd timestamp falls back to now rather than throwing', () => {
  assert.doesNotThrow(() => deriveNote({ url: 'https://www.tiktok.com/video/1', savedAt: 1e300 }))
  assert.doesNotThrow(() => deriveNote({ url: 'https://www.tiktok.com/video/1', savedAt: 0 }))
})
