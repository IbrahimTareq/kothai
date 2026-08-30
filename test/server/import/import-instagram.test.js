import test from 'node:test'
import assert from 'node:assert/strict'
import { sniff, parse, parseSavedPosts, parseCollections, deriveNote, deriveAccountFromTitle } from '../../../server/import/instagram.js'
import { findImporter } from '../../../server/import/index.js'

const SAVED = JSON.stringify({
  saved_saved_media: [
    { title: 'chefsteps', string_map_data: { 'Saved on': { href: 'https://www.instagram.com/reel/DEF456/', timestamp: 1721001600 } } },
    { title: 'natgeo', string_map_data: { 'Saved on': { href: 'https://www.instagram.com/p/ABC123/', timestamp: 1718000000 } } },
    { title: 'broken-no-href', string_map_data: { 'Saved on': { timestamp: 1718000001 } } },
  ],
})

const COLLECTIONS = JSON.stringify({
  saved_saved_collections: [
    { title: 'Recipes', list: [{ href: 'https://www.instagram.com/reel/DEF456/' }] },
  ],
})

function files(entries) {
  return new Map(Object.entries(entries).map(([k, v]) => [k, Buffer.from(v)]))
}

function savedPostsJson(count, prefix) {
  const rows = []
  for (let i = 0; i < count; i++) {
    rows.push({ title: `${prefix}${i}`, string_map_data: { 'Saved on': { href: `https://www.instagram.com/p/${prefix}${i}/`, timestamp: 1 } } })
  }
  return JSON.stringify({ saved_saved_media: rows })
}

test('sniff: recognizes an export containing saved_posts.json', () => {
  assert.equal(sniff(files({ 'your_instagram_activity/saved/saved_posts.json': SAVED })), true)
  assert.equal(sniff(files({ 'random.json': '{"a":1}' })), false)
})

test('parseSavedPosts: extracts url/poster/savedAt, skips entries without href', () => {
  const items = parseSavedPosts(JSON.parse(SAVED))
  assert.equal(items.length, 2)
  assert.equal(items[0].url, 'https://www.instagram.com/reel/DEF456/')
  assert.equal(items[0].poster, 'chefsteps')
  assert.equal(items[0].savedAt, 1721001600)
})

// parse() now emits membership as [{ name, urls }] — the collection's own
// member URLs — instead of joining collection names onto each item. The route
// resolves those URLs against its canonical-url index, which is what makes a
// collections file importable on its own, after its posts are already saved.
function collectionsOf(result, url) {
  return result.collections.filter((c) => c.urls.includes(url)).map((c) => c.name).sort()
}

test('parseCollections: deep-walks name + href groupings; unknown shapes yield empty map', () => {
  const map = parseCollections(JSON.parse(COLLECTIONS))
  assert.deepEqual([...map.keys()], ['Recipes'])
  assert.ok(map.get('Recipes').has('https://www.instagram.com/reel/DEF456/'))
  assert.equal(parseCollections({ totally: 'different' }).size, 0)
})

test('parse: reports each collection with its member urls; missing collections file is fine', () => {
  const withC = parse(files({
    'your_instagram_activity/saved/saved_posts.json': SAVED,
    'your_instagram_activity/saved/saved_collections.json': COLLECTIONS,
  }))
  assert.deepEqual(collectionsOf(withC, 'https://www.instagram.com/reel/DEF456/'), ['Recipes'])
  assert.deepEqual(collectionsOf(withC, 'https://www.instagram.com/p/ABC123/'), [])
  const noC = parse(files({ 'your_instagram_activity/saved/saved_posts.json': SAVED }))
  assert.equal(noC.items.length, 2)
  assert.deepEqual(noC.collections, [])
})

test('parse: a collections file on its own still yields its memberships, with no items', () => {
  const only = parse(files({ 'your_instagram_activity/saved/saved_collections.json': COLLECTIONS }))
  assert.equal(only.items.length, 0)
  assert.deepEqual(only.collections.map((c) => c.name), ['Recipes'])
  assert.deepEqual(collectionsOf(only, 'https://www.instagram.com/reel/DEF456/'), ['Recipes'])
})

test('deriveNote: reel → video, post → link, preserved timestamp, instagram tag', () => {
  const reel = deriveNote({ url: 'https://www.instagram.com/reel/DEF456/', poster: 'chefsteps', savedAt: 1721001600, collections: [] })
  assert.equal(reel.type, 'video')
  assert.equal(reel.title, '@chefsteps · Reel')
  assert.equal(reel.createdAt, new Date(1721001600 * 1000).toISOString())
  assert.deepEqual(reel.tags, ['instagram'])
  assert.equal(reel.url, reel.content) // enrich pipeline reads content as text
  const post = deriveNote({ url: 'https://www.instagram.com/p/ABC123/', poster: 'natgeo', savedAt: 0, collections: [] })
  assert.equal(post.type, 'link')
  assert.equal(post.title, '@natgeo · Post')
  assert.ok(post.createdAt) // savedAt 0/missing falls back to now
})

test('deriveNote: types by URL pathname only, ignoring query strings', () => {
  const note = deriveNote({ url: 'https://www.instagram.com/p/ABC/?ref=/tv/', poster: 'x', savedAt: 1, collections: [] })
  assert.equal(note.type, 'link')
})

// --- Hardening: this parser eats the same untrusted upload as server/lib/zip.js ---

test('parseSavedPosts: rejects non-http(s) href schemes (javascript:/data:/ftp:/lookalikes)', () => {
  const hostile = {
    saved_saved_media: [
      { title: 'a', string_map_data: { 'Saved on': { href: 'javascript:alert(1)', timestamp: 1 } } },
      { title: 'b', string_map_data: { 'Saved on': { href: 'data:text/html,<script>1</script>', timestamp: 1 } } },
      { title: 'c', string_map_data: { 'Saved on': { href: 'ftp://example.com/x', timestamp: 1 } } },
      { title: 'd', string_map_data: { 'Saved on': { href: 'httpfoo://example.com/x', timestamp: 1 } } },
      { title: 'e', string_map_data: { 'Saved on': { href: 'https://www.instagram.com/p/OK/', timestamp: 1 } } },
    ],
  }
  const items = parseSavedPosts(hostile)
  assert.equal(items.length, 1)
  assert.equal(items[0].url, 'https://www.instagram.com/p/OK/')
})

test('parseSavedPosts: caps item count so a pathologically large export cannot exhaust memory', () => {
  const rows = []
  for (let i = 0; i < 100_001; i++) {
    rows.push({ title: `p${i}`, string_map_data: { 'Saved on': { href: `https://www.instagram.com/p/${i}/`, timestamp: 1 } } })
  }
  const items = parseSavedPosts({ saved_saved_media: rows })
  assert.equal(items.length, 100_000)
  assert.equal(items.skipped, 1)
})

test('parseSavedPosts: clips absurdly long title/poster fields', () => {
  const hugeTitle = 'x'.repeat(10_000)
  const items = parseSavedPosts({
    saved_saved_media: [
      { title: hugeTitle, string_map_data: { 'Saved on': { href: 'https://www.instagram.com/p/ABC/', timestamp: 1 } } },
    ],
  })
  assert.equal(items.length, 1)
  assert.ok(items[0].poster.length <= 500)
})

test('parseSavedPosts: normalizes whitespace in poster names before clipping (these feed an LLM prompt)', () => {
  const items = parseSavedPosts({
    saved_saved_media: [
      { title: '  chef\n\tsteps  ', string_map_data: { 'Saved on': { href: 'https://www.instagram.com/p/W/', timestamp: 1 } } },
    ],
  })
  assert.equal(items[0].poster, 'chef steps')
})

test('parseCollections: a maliciously deep-nested JS structure does not blow the stack, degrades to no collection found', () => {
  let node = [{ href: 'https://www.instagram.com/reel/DEEP/' }]
  for (let i = 0; i < 100_000; i++) node = [node]
  const json = { saved_saved_collections: [{ title: 'Deep', list: node }] }
  assert.doesNotThrow(() => parseCollections(json))
  const map = parseCollections(json)
  // href sits far past the walk-depth cap, so it's never found — the whole
  // export degrades to "no collections" instead of crashing the import.
  assert.equal(map.size, 0)
  assert.equal(map.truncated, true)
})

test('parse: a deep-nested collections export (driven through the Buffer boundary it actually arrives on) degrades cleanly with a warning', () => {
  // JSON.stringify IS recursive in V8 (unlike JSON.parse) and overflows
  // somewhere around 5-8k levels, so 2000 is deep enough to blow well past
  // our own MAX_WALK_DEPTH (64) while staying safely inside stringify's own
  // limit — this exercises tryJson()/Buffer parsing, not just the in-memory
  // walk.
  let node = [{ href: 'https://www.instagram.com/reel/DEEP/' }]
  for (let i = 0; i < 2000; i++) node = [node]
  const deepJson = JSON.stringify({ saved_saved_collections: [{ title: 'Deep', list: node }] })
  const result = parse(files({ 'your_instagram_activity/saved/saved_collections.json': deepJson }))
  assert.deepEqual(result.collections, [])
  assert.ok(result.warnings.includes('some collections were too deeply nested to read'))
})

test('parseSavedPosts: normalizes millisecond timestamps and rejects out-of-range/Infinity timestamps instead of crashing', () => {
  const json = {
    saved_saved_media: [
      // Milliseconds instead of seconds — a plausible export-version drift.
      { title: 'ms', string_map_data: { 'Saved on': { href: 'https://www.instagram.com/p/MS/', timestamp: 1721001600000 } } },
      // JSON.parse('1e400') yields Infinity — a "number > 0" check alone would let this through.
      { title: 'huge', string_map_data: { 'Saved on': { href: 'https://www.instagram.com/p/HUGE/', timestamp: 1e400 } } },
      // Finite but absurdly far in the future.
      { title: 'future', string_map_data: { 'Saved on': { href: 'https://www.instagram.com/p/FUTURE/', timestamp: 9_999_999_999_999 } } },
    ],
  }
  const items = parseSavedPosts(json)
  assert.equal(items.find((i) => i.poster === 'ms').savedAt, 1721001600) // normalized down to seconds, not left as 1721001600000
  assert.equal(items.find((i) => i.poster === 'huge').savedAt, 0) // Infinity degrades to "no timestamp"
  assert.equal(items.find((i) => i.poster === 'future').savedAt, 0)
  // deriveNote must never throw regardless of what savedAt ends up being.
  for (const item of items) assert.doesNotThrow(() => deriveNote(item).createdAt)
})

test('parseSavedPosts: resolves href and timestamp from the SAME string_map_data entry, not independently', () => {
  const json = {
    saved_saved_media: [{
      title: 'natgeo',
      string_map_data: {
        Owner: { value: 'natgeo', timestamp: 1000000000 },
        'Saved on': { href: 'https://www.instagram.com/p/RIGHT/', timestamp: 1721001600 },
      },
    }],
  }
  const items = parseSavedPosts(json)
  assert.equal(items.length, 1)
  assert.equal(items[0].url, 'https://www.instagram.com/p/RIGHT/')
  assert.equal(items[0].savedAt, 1721001600) // must come from the same entry as href, not Owner's timestamp
})

test('parseSavedPosts: prefers a permalink-shaped href over an earlier Profile href', () => {
  const json = {
    saved_saved_media: [{
      title: 'natgeo',
      string_map_data: {
        Profile: { href: 'https://www.instagram.com/natgeo/', timestamp: 1721001600 },
        'Saved on': { href: 'https://www.instagram.com/p/RIGHT/', timestamp: 1721001600 },
      },
    }],
  }
  const items = parseSavedPosts(json)
  assert.equal(items.length, 1)
  assert.equal(items[0].url, 'https://www.instagram.com/p/RIGHT/')
})

test('parseSavedPosts: rejects an oversized href rather than truncating it into a broken link', () => {
  const hugeUrl = 'https://www.instagram.com/p/' + 'A'.repeat(3000) + '/'
  const json = {
    saved_saved_media: [
      { title: 'huge', string_map_data: { 'Saved on': { href: hugeUrl, timestamp: 1 } } },
      { title: 'ok', string_map_data: { 'Saved on': { href: 'https://www.instagram.com/p/OK/', timestamp: 1 } } },
    ],
  }
  const items = parseSavedPosts(json)
  assert.equal(items.length, 1)
  assert.equal(items[0].poster, 'ok')
})

test('parseCollections: nested collections are not lumped into their wrapper', () => {
  const json = {
    saved_saved_collections: [{
      title: 'Saved',
      groups: [
        { title: 'Recipes', list: [{ href: 'https://www.instagram.com/reel/R/' }] },
        { title: 'Travel', list: [{ href: 'https://www.instagram.com/p/T/' }] },
      ],
    }],
  }
  const map = parseCollections(json)
  assert.deepEqual([...map.keys()].sort(), ['Recipes', 'Travel'])
  assert.ok(map.get('Recipes').has('https://www.instagram.com/reel/R/'))
  assert.ok(map.get('Travel').has('https://www.instagram.com/p/T/'))
  assert.ok(!map.get('Recipes').has('https://www.instagram.com/p/T/'))
  assert.equal(map.has('Saved'), false) // the wrapper itself owns no direct hrefs
})

test('parse: the item cap is a shared budget across multiple saved_posts.json files, not reset per file', () => {
  const result = parse(files({
    'part1/saved_posts.json': savedPostsJson(70_000, 'a'),
    'part2/saved_posts.json': savedPostsJson(70_000, 'b'),
  }))
  assert.equal(result.items.length, 100_000)
  assert.ok(result.warnings.some((w) => w.includes('item cap reached')))
})

test('parse: corrupt JSON in one file does not fail the whole import; it is reported as a warning', () => {
  const result = parse(files({
    'your_instagram_activity/saved/saved_posts.json': '{not valid json',
    'your_instagram_activity/saved/saved_collections.json': COLLECTIONS,
  }))
  assert.equal(result.items.length, 0)
  assert.ok(result.warnings.some((w) => w.includes('saved_posts.json could not be parsed')))
})

test('parse: a post can belong to more than one collection', () => {
  const twoCollections = JSON.stringify({
    saved_saved_collections: [
      { title: 'Recipes', list: [{ href: 'https://www.instagram.com/reel/DEF456/' }] },
      { title: 'Favorites', list: [{ href: 'https://www.instagram.com/reel/DEF456/' }] },
    ],
  })
  const result = parse(files({
    'your_instagram_activity/saved/saved_posts.json': SAVED,
    'your_instagram_activity/saved/saved_collections.json': twoCollections,
  }))
  assert.deepEqual(collectionsOf(result, 'https://www.instagram.com/reel/DEF456/'), ['Favorites', 'Recipes'])
})

// --- Re-review fixes: collections-walk regression, total deriveNote, linear join ---

test('parseCollections: titled href-bearing leaves are not stolen as their own collections (regression from the finding-6 fix)', () => {
  // `title` is ubiquitous in Meta exports — it's the poster username on every
  // saved_posts.json row too — so a naive "named node = collection" rule
  // invents a "natgeo"/"chefsteps" collection out of these leaf link entries
  // instead of leaving both hrefs under their real wrapper, "Recipes".
  const json = {
    saved_saved_collections: [{
      title: 'Recipes',
      list: [
        { title: 'natgeo', href: 'https://www.instagram.com/p/A/' },
        { title: 'chefsteps', href: 'https://www.instagram.com/p/B/' },
      ],
    }],
  }
  const map = parseCollections(json)
  assert.deepEqual([...map.keys()], ['Recipes'])
  assert.ok(map.get('Recipes').has('https://www.instagram.com/p/A/'))
  assert.ok(map.get('Recipes').has('https://www.instagram.com/p/B/'))
  assert.equal(map.has('natgeo'), false)
  assert.equal(map.has('chefsteps'), false)
})

test('parseCollections: nested wrapper collections still work alongside the titled-leaf fix', () => {
  const json = {
    saved_saved_collections: [{
      title: 'Saved',
      groups: [
        { title: 'Recipes', list: [{ href: 'https://www.instagram.com/reel/R/' }] },
        { title: 'Travel', list: [{ href: 'https://www.instagram.com/p/T/' }] },
      ],
    }],
  }
  const map = parseCollections(json)
  assert.deepEqual([...map.keys()].sort(), ['Recipes', 'Travel'])
  assert.equal(map.has('Saved'), false)
})

test('deriveNote: is total even for an absurdly large finite savedAt (1e300) that Number.isFinite alone would admit', () => {
  // new Date(1e300 * 1000).toISOString() throws RangeError — anything past
  // ~8.64e12 seconds is outside Date's representable range, and 1e300 is
  // finite so a bare Number.isFinite guard would let it through.
  assert.doesNotThrow(() => deriveNote({ url: 'https://www.instagram.com/p/X/', poster: 'x', savedAt: 1e300, collections: [] }))
  const note = deriveNote({ url: 'https://www.instagram.com/p/X/', poster: 'x', savedAt: 1e300, collections: [] })
  assert.ok(note.createdAt) // falls back to "now" rather than an Invalid Date
})

test('parseSavedPosts: an oversized permalink href falls back to a shorter usable href on the same row', () => {
  // Length must be part of the SELECTION predicate, not a check applied
  // after `entry` is already chosen — otherwise an oversized permalink drops
  // the whole row even though a perfectly usable fallback href exists.
  const hugePermalink = 'https://www.instagram.com/p/' + 'A'.repeat(3000) + '/'
  const json = {
    saved_saved_media: [{
      title: 'natgeo',
      string_map_data: {
        'Saved on': { href: hugePermalink, timestamp: 1721001600 },
        Fallback: { href: 'https://www.instagram.com/other/short/', timestamp: 1721001600 },
      },
    }],
  }
  const items = parseSavedPosts(json)
  assert.equal(items.length, 1)
  assert.equal(items[0].url, 'https://www.instagram.com/other/short/')
})

test('parse: an oversized href is counted and warned about rather than silently dropped', () => {
  const hugeUrl = 'https://www.instagram.com/p/' + 'A'.repeat(3000) + '/'
  const json = JSON.stringify({
    saved_saved_media: [
      { title: 'huge', string_map_data: { 'Saved on': { href: hugeUrl, timestamp: 1 } } },
    ],
  })
  const result = parse(files({ 'your_instagram_activity/saved/saved_posts.json': json }))
  assert.equal(result.items.length, 0)
  assert.ok(result.warnings.some((w) => w.includes('unusable URL')))
})

test('parse: an unrecognized saved_posts.json shape warns instead of silently reporting "imported 0"', () => {
  for (const shape of [{ something_else: 1 }, [], 'a string']) {
    const result = parse(files({ 'your_instagram_activity/saved/saved_posts.json': JSON.stringify(shape) }))
    assert.equal(result.items.length, 0)
    assert.ok(result.warnings.some((w) => w.includes('no recognizable saved posts')), `expected a warning for shape ${JSON.stringify(shape)}`)
  }
})

test('parse: collection membership stays linear at scale (was O(items × collections))', () => {
  const rows = []
  const collectionEntries = []
  for (let i = 0; i < 5000; i++) {
    rows.push({ title: `p${i}`, string_map_data: { 'Saved on': { href: `https://www.instagram.com/p/${i}/`, timestamp: 1 } } })
    collectionEntries.push({ title: `c${i}`, list: [{ href: `https://www.instagram.com/p/${i}/` }] })
  }
  const savedJson = JSON.stringify({ saved_saved_media: rows })
  const collectionsJson = JSON.stringify({ saved_saved_collections: collectionEntries })
  const start = Date.now()
  const result = parse(files({
    'your_instagram_activity/saved/saved_posts.json': savedJson,
    'your_instagram_activity/saved/saved_collections.json': collectionsJson,
  }))
  const elapsed = Date.now() - start
  assert.equal(result.items.length, 5000)
  assert.deepEqual(collectionsOf(result, 'https://www.instagram.com/p/2500/'), ['c2500'])
  assert.ok(elapsed < 2000, `join took too long: ${elapsed}ms (was measured at 7+ seconds for 20k×20k pre-fix)`)
})

test('findImporter: routes an instagram export to the instagram importer, null otherwise', () => {
  const ig = findImporter(files({ 'your_instagram_activity/saved/saved_posts.json': SAVED }))
  assert.equal(ig?.name, 'instagram')
  assert.equal(findImporter(files({ 'unknown.json': '{}' })), null)
})

// --- Newer Accounts Center export shape: a top-level ARRAY of label_values rows ---
// Meta's current "Export your information → JSON" writes saved_posts.json as a
// bare array whose rows carry `label_values` (URL/Caption/Title + Owner dict)
// and a row-level `timestamp`, with no `saved_saved_media` wrapper at all.
// A real 1,675-post export parsed to zero items under the old shape-pinned
// reader and surfaced only "contains no recognizable saved posts".

const SAVED_LABEL_VALUES = JSON.stringify([
  {
    timestamp: 1721001600,
    media: [],
    label_values: [
      { label: 'URL', value: 'https://www.instagram.com/reel/DEF456/', href: 'https://www.instagram.com/reel/DEF456/' },
      { label: 'Caption', value: 'a caption' },
      { label: 'Title', value: '' },
      { dict: [], title: 'Hashtags' },
      { dict: [{ dict: [{ label: 'URL', value: '' }, { label: 'Name', value: 'ChefSteps' }, { label: 'Username', value: 'chefsteps' }], title: '' }], title: 'Owner' },
    ],
    fbid: '1',
  },
  {
    timestamp: 1718000000,
    media: [],
    label_values: [
      { label: 'URL', value: 'https://www.instagram.com/p/ABC123/', href: 'https://www.instagram.com/p/ABC123/' },
      { dict: [{ dict: [{ label: 'Name', value: 'Nat Geo' }], title: '' }], title: 'Owner' },
    ],
    fbid: '2',
  },
  { timestamp: 1718000001, media: [], label_values: [{ label: 'Caption', value: 'no url here' }], fbid: '3' },
])

test('parseSavedPosts: reads the newer top-level-array label_values export shape', () => {
  const items = parseSavedPosts(JSON.parse(SAVED_LABEL_VALUES))
  assert.equal(items.length, 2)
  assert.equal(items[0].url, 'https://www.instagram.com/reel/DEF456/')
  assert.equal(items[0].poster, 'chefsteps') // Owner → Username preferred
  assert.equal(items[0].savedAt, 1721001600) // row-level timestamp
  assert.equal(items[1].url, 'https://www.instagram.com/p/ABC123/')
  assert.equal(items[1].poster, 'Nat Geo') // falls back to Owner → Name
})

test('parse: a bare newer-shape saved_posts.json imports without a "no recognizable saved posts" warning', () => {
  const result = parse(files({ 'saved_posts.json': SAVED_LABEL_VALUES }))
  assert.equal(result.items.length, 2)
  assert.deepEqual(result.warnings, [])
})

test('parseSavedPosts: newer shape falls back to the URL label value when href is absent', () => {
  const items = parseSavedPosts([
    { timestamp: 1, label_values: [{ label: 'URL', value: 'https://www.instagram.com/p/NOHREF/' }] },
  ])
  assert.equal(items.length, 1)
  assert.equal(items[0].url, 'https://www.instagram.com/p/NOHREF/')
})

test('parseSavedPosts: newer shape applies the same hostile-input guards (scheme, length, timestamp)', () => {
  const items = parseSavedPosts([
    { timestamp: 1, label_values: [{ label: 'URL', value: 'javascript:alert(1)', href: 'javascript:alert(1)' }] },
    { timestamp: 1, label_values: [{ label: 'URL', href: 'https://www.instagram.com/p/' + 'x'.repeat(3000) }] },
    { timestamp: 1e400, label_values: [{ label: 'URL', href: 'https://www.instagram.com/p/OK/' }] },
  ])
  assert.equal(items.length, 1)
  assert.equal(items[0].url, 'https://www.instagram.com/p/OK/')
  assert.equal(items[0].savedAt, 0)
})

test('parseCollections: recognizes the newer label_values Name shape for a collection', () => {
  const map = parseCollections([
    { label_values: [{ label: 'Name', value: 'Recipes' }], list: [{ href: 'https://www.instagram.com/reel/DEF456/' }] },
  ])
  assert.deepEqual([...map.keys()], ['Recipes'])
  assert.ok(map.get('Recipes').has('https://www.instagram.com/reel/DEF456/'))
})

// Real newer-shape saved_collections.json: a top-level array of rows whose
// name is a `label_values` Name row and whose members hang off a wrapper
// entry literally titled "Media". The generic deep-walk treats any titled
// node as a nested collection, so without a dedicated reader every real
// collection came back empty and all their posts collapsed into one bogus
// collection called "Media".
const COLLECTIONS_LABEL_VALUES = JSON.stringify([
  {
    timestamp: 1781425447,
    media: [],
    label_values: [
      { label: 'Name', value: 'Filming Style' },
      { label: 'Type', value: 'Default' },
      { label: 'Update time', timestamp_value: 1781425535 },
      {
        title: 'Media',
        dict: [
          { title: '', dict: [
            { label: 'URL', value: 'https://www.instagram.com/reel/AAA/', href: 'https://www.instagram.com/reel/AAA/' },
            { label: 'Caption', value: 'movements #cinematic' },
            { title: 'Hashtags', dict: [{ title: '', dict: [{ label: 'Name', value: 'cinematic' }] }] },
            { title: 'Owner', dict: [{ title: '', dict: [{ label: 'URL', value: '' }, { label: 'Username', value: 'someone' }] }] },
          ] },
          { title: '', dict: [{ label: 'URL', value: 'https://www.instagram.com/p/BBB/', href: 'https://www.instagram.com/p/BBB/' }] },
        ],
      },
    ],
  },
  {
    timestamp: 1781425448,
    media: [],
    label_values: [
      { label: 'Name', value: 'Recipes' },
      { title: 'Media', dict: [{ title: '', dict: [{ label: 'URL', value: 'https://www.instagram.com/reel/CCC/', href: 'https://www.instagram.com/reel/CCC/' }] }] },
    ],
  },
])

test('parseCollections: newer array shape keeps each collection separate instead of collapsing into "Media"', () => {
  const map = parseCollections(JSON.parse(COLLECTIONS_LABEL_VALUES))
  assert.deepEqual([...map.keys()].sort(), ['Filming Style', 'Recipes'])
  assert.deepEqual([...map.get('Filming Style')].sort(), [
    'https://www.instagram.com/p/BBB/',
    'https://www.instagram.com/reel/AAA/',
  ])
  assert.deepEqual([...map.get('Recipes')], ['https://www.instagram.com/reel/CCC/'])
  // "Media"/"Hashtags"/"Owner" are structural wrappers in this shape, never collections.
  assert.equal(map.has('Media'), false)
  assert.equal(map.has('Hashtags'), false)
  assert.equal(map.has('Owner'), false)
})

test('parse: newer-shape posts and collections join up end to end', () => {
  const posts = JSON.stringify([
    { timestamp: 1721001600, label_values: [{ label: 'URL', value: 'https://www.instagram.com/reel/AAA/', href: 'https://www.instagram.com/reel/AAA/' }] },
    { timestamp: 1721001601, label_values: [{ label: 'URL', value: 'https://www.instagram.com/reel/CCC/', href: 'https://www.instagram.com/reel/CCC/' }] },
  ])
  const result = parse(files({ 'saved_posts.json': posts, 'saved_collections.json': COLLECTIONS_LABEL_VALUES }))
  assert.deepEqual(collectionsOf(result, 'https://www.instagram.com/reel/AAA/'), ['Filming Style'])
  assert.deepEqual(collectionsOf(result, 'https://www.instagram.com/reel/CCC/'), ['Recipes'])
  assert.deepEqual(result.warnings, [])
})

test('parseSavedPosts: a maliciously deep-nested dict in the newer shape does not blow the stack', () => {
  let node = { dict: [{ label: 'Username', value: 'deep' }] }
  for (let i = 0; i < 100_000; i++) node = { dict: [node] }
  const rows = [{ timestamp: 1, label_values: [{ label: 'URL', href: 'https://www.instagram.com/p/DEEP/' }, node] }]
  assert.doesNotThrow(() => parseSavedPosts(rows))
  const items = parseSavedPosts(rows)
  // Degrades to "no poster found" rather than crashing the whole import.
  assert.equal(items.length, 1)
  assert.equal(items[0].url, 'https://www.instagram.com/p/DEEP/')
  assert.equal(items[0].poster, '')
})

test('parse: a caption that merely starts with a URL is not reported as an unusable post URL', () => {
  const rows = JSON.stringify([
    { timestamp: 1, label_values: [{ label: 'Caption', value: 'https://makerworld.com/@someone check it out' }] },
  ])
  const result = parse(files({ 'saved_posts.json': rows }))
  assert.equal(result.items.length, 0)
  assert.ok(!result.warnings.some((w) => /unusable URL/.test(w)))
})

test('deriveNote: persists the poster username as a first-class `account` field', () => {
  const note = deriveNote({ url: 'https://www.instagram.com/p/ABC123/', poster: 'natgeo', savedAt: 0, collections: [] })
  assert.equal(note.account, 'natgeo')
})

test('deriveNote: no poster means no account (not the "instagram" title fallback)', () => {
  const note = deriveNote({ url: 'https://www.instagram.com/p/ABC123/', poster: '', savedAt: 0, collections: [] })
  assert.equal(note.account, null)
  assert.equal(note.title, '@instagram · Post') // title fallback is unchanged
})

test('deriveAccountFromTitle: extracts the handle from a legacy note title', () => {
  assert.equal(deriveAccountFromTitle('@chefsteps · Reel'), 'chefsteps')
  assert.equal(deriveAccountFromTitle('@natgeo · Post'), 'natgeo')
})

test('deriveAccountFromTitle: returns null for anything that does not match the exact import title shape', () => {
  assert.equal(deriveAccountFromTitle('Untitled'), null)
  assert.equal(deriveAccountFromTitle('@partial · '), null)
  assert.equal(deriveAccountFromTitle(''), null)
  assert.equal(deriveAccountFromTitle(null), null)
})
