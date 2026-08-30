// Tests for meta.js's Reddit fetcher: URL recognition, the `.json` URL it
// builds, the pure payload parser, and the fetchLinkMeta wiring.
//
// The parser gets the bulk of the coverage for the same reason
// parseInstagramEmbed does: it is where the shape assumptions live, and every
// field in a Reddit payload is optional in practice — deleted posts, removed
// bodies, link posts with no selftext, and threads with nothing but a
// stickied bot comment all arrive as the same structure with holes in it.
//
// Mocks are installed before meta.js is imported; see test/oembed.test.js.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

let responses
let fetched

function respond(url) {
  const r = responses[url]
  if (!r) return { ok: false, status: 404, headers: new Headers(), text: async () => '', json: async () => ({}) }
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': r.contentType || 'application/json' }),
    // Response.url is the URL after redirects — what resolveRedditShare reads
    // to turn a /s/ share link back into the canonical post URL.
    url: r.redirectsTo || url,
    text: async () => r.text ?? '',
    json: async () => r.json ?? {},
  }
}

const realSsrf = await import('../../../server/lib/ssrf.js')
mock.module('../../../server/lib/ssrf.js', {
  namedExports: { ...realSsrf, safeFetch: async (url) => { fetched.push(url); return respond(url) } },
})

const { isRedditPost, isRedditShare, redditJsonUrl, parseRedditPost, fetchLinkMeta } = await import('../../../server/ai/meta.js')

const POST_URL = 'https://www.reddit.com/r/breadit/comments/abc123/my_first_sourdough/'

// A realistic trimmed payload: the two-Listing array Reddit actually answers
// with, including the boilerplate a parser has to survive.
function payload({ post = {}, comments = [] } = {}) {
  return [
    {
      kind: 'Listing',
      data: {
        children: [
          {
            kind: 't3',
            data: {
              title: 'My first sourdough',
              selftext: 'I finally got an open crumb. 75% hydration, 20 hour cold retard.',
              subreddit: 'Breadit',
              author: 'baker99',
              url: POST_URL,
              thumbnail: 'self',
              preview: { images: [{ source: { url: 'https://preview.redd.it/loaf.jpg?width=1080' } }] },
              ...post,
            },
          },
        ],
      },
    },
    { kind: 'Listing', data: { children: comments.map((data) => ({ kind: 't1', data })) } },
  ]
}

test('isRedditPost matches post permalinks on reddit.com and its subdomains, not the rest of the site', () => {
  assert.equal(isRedditPost(POST_URL), true)
  assert.equal(isRedditPost('https://old.reddit.com/r/breadit/comments/abc123/'), true)
  assert.equal(isRedditPost('https://np.reddit.com/comments/abc123'), true)
  assert.equal(isRedditPost('https://www.reddit.com/r/breadit/'), false)     // subreddit index
  assert.equal(isRedditPost('https://www.reddit.com/user/baker99'), false)
  assert.equal(isRedditPost('https://evil.com/reddit.com/comments/x'), false)
  assert.equal(isRedditPost('not a url'), false)
})

test('redditJsonUrl appends .json to the path, dropping any tracking query the share link carried', () => {
  const api = redditJsonUrl('https://www.reddit.com/r/breadit/comments/abc123/slug/?utm_source=share&utm_medium=web')
  assert.equal(api, 'https://www.reddit.com/r/breadit/comments/abc123/slug.json?raw_json=1&limit=20')
  // A naive `url + '.json'` would have produced '…&utm_medium=web.json'.
  assert.doesNotMatch(api, /utm_/)
})

test('parseRedditPost pulls the title, selftext and top comments into the right fields', () => {
  const p = parseRedditPost(payload({
    comments: [
      { author: 'proofer', body: 'That crumb is textbook. What flour?' },
      { author: 'baker99', body: 'Bread flour, 12.7% protein.' },
    ],
  }))
  assert.equal(p.siteTitle, 'My first sourdough')
  assert.equal(p.siteName, 'Reddit')
  assert.match(p.siteDesc, /open crumb/)
  // The article field carries the readable body: sub/author header, the full
  // selftext, and the thread — the part a plain og:description scrape misses
  // entirely, and often where the actual answer lives.
  assert.match(p.article, /r\/Breadit — posted by u\/baker99/)
  assert.match(p.article, /20 hour cold retard/)
  assert.match(p.article, /Top comments:/)
  assert.match(p.article, /u\/proofer: That crumb is textbook/)
  assert.match(p.article, /u\/baker99: Bread flour/)
})

test('parseRedditPost drops stickied bot comments and deleted bodies', () => {
  const p = parseRedditPost(payload({
    comments: [
      { author: 'AutoModerator', body: 'Please read the rules.', stickied: true },
      { author: 'ghost', body: '[deleted]' },
      { author: 'ghost2', body: '[removed]' },
      { author: 'real', body: 'Looks great.' },
    ],
  }))
  assert.doesNotMatch(p.article, /read the rules/)
  assert.doesNotMatch(p.article, /\[deleted\]|\[removed\]/)
  assert.match(p.article, /u\/real: Looks great\./)
})

test('parseRedditPost handles a link post with no selftext and no comments', () => {
  const p = parseRedditPost(payload({ post: { selftext: '' }, comments: [] }))
  assert.equal(p.siteDesc, null, 'no body means no siteDesc, not an empty string')
  assert.equal(p.siteTitle, 'My first sourdough')
  assert.match(p.article, /r\/Breadit/, 'the sub/author line is still worth having on its own')
})

test('parseRedditPost returns empty fields rather than throwing on a payload with nothing in it', () => {
  for (const bad of [null, undefined, [], {}, [{ data: {} }], [{ data: { children: [] } }]]) {
    const p = parseRedditPost(bad)
    assert.equal(p.siteTitle, null)
    assert.equal(p.siteDesc, null)
    assert.equal(p.article, null)
    assert.equal(p.thumbUrl, null)
    assert.equal(p.siteName, 'Reddit')
  }
})

test('parseRedditPost prefers the preview image, then a real thumbnail, and never a sentinel word', () => {
  assert.equal(parseRedditPost(payload()).thumbUrl, 'https://preview.redd.it/loaf.jpg?width=1080')

  // 'self' / 'default' / 'nsfw' are Reddit's stand-ins for "no preview" —
  // fetching one would be a request for a URL that does not exist.
  const noPreview = parseRedditPost(payload({ post: { preview: undefined, thumbnail: 'self' } }))
  assert.equal(noPreview.thumbUrl, null)

  const realThumb = parseRedditPost(payload({ post: { preview: undefined, thumbnail: 'https://b.thumbs.redditmedia.com/x.jpg' } }))
  assert.equal(realThumb.thumbUrl, 'https://b.thumbs.redditmedia.com/x.jpg')

  // A direct image submission: the post's own url IS the picture.
  const direct = parseRedditPost(payload({ post: { preview: undefined, thumbnail: 'default', url: 'https://i.redd.it/loaf.png' } }))
  assert.equal(direct.thumbUrl, 'https://i.redd.it/loaf.png')
})

test('fetchLinkMeta routes a Reddit permalink to the .json fetcher, not to oEmbed or the og scraper', async () => {
  fetched = []
  responses = {
    [redditJsonUrl(POST_URL)]: {
      json: payload({ comments: [{ author: 'proofer', body: 'Textbook crumb.' }] }),
    },
  }
  const meta = await fetchLinkMeta(POST_URL, 'note-r1')

  assert.deepEqual(fetched, [redditJsonUrl(POST_URL), 'https://preview.redd.it/loaf.jpg?width=1080'],
    'exactly the JSON fetch and the thumbnail download — no oEmbed call, no page scrape')
  assert.equal(meta.siteTitle, 'My first sourdough')
  assert.equal(meta.siteName, 'Reddit')
  assert.match(meta.siteDesc, /open crumb/)
  assert.match(meta.article, /Textbook crumb/)
})

test('a walled JSON endpoint degrades to oEmbed/OpenGraph instead of leaving the note with nothing', async () => {
  // Reddit answers an anonymous .json request with 403 today, and its plain
  // HTML page carries no og: tags either. Its oEmbed endpoint still works, so
  // that is what a Reddit save actually gets — the real post title, rather
  // than nothing at all plus five wasted metaTries retries.
  fetched = []
  const oembed = 'https://www.reddit.com/oembed?url=' + encodeURIComponent(POST_URL) + '&format=json'
  responses = {
    // no entry for the .json url → 403-equivalent, get() throws
    [oembed]: { json: { title: 'Why did the Roman Empire fall?', author_name: 'PatsHobbyJP', provider_name: 'reddit' } },
    [POST_URL]: { text: '<html><head><title>Reddit</title></head></html>', contentType: 'text/html' },
  }
  const meta = await fetchLinkMeta(POST_URL, 'note-r2')
  assert.equal(meta.siteTitle, 'Why did the Roman Empire fall?')
  assert.equal(meta.siteName, 'reddit')
  assert.ok(fetched.includes(redditJsonUrl(POST_URL)), 'the rich route is still tried first')
})

test('a 200 that contains no post (a login wall) degrades the same way as a hard failure', async () => {
  fetched = []
  const oembed = 'https://www.reddit.com/oembed?url=' + encodeURIComponent(POST_URL) + '&format=json'
  responses = {
    [redditJsonUrl(POST_URL)]: { json: { kind: 'Listing', data: { children: [] } } },
    [oembed]: { json: { title: 'Recovered by oEmbed', provider_name: 'reddit' } },
    [POST_URL]: { text: '<html></html>', contentType: 'text/html' },
  }
  const meta = await fetchLinkMeta(POST_URL, 'note-r3')
  assert.equal(meta.siteTitle, 'Recovered by oEmbed')
})

// ---- share links --------------------------------------------------------
// /r/<sub>/s/<id> is what Reddit's own share sheet produces, so it is the form
// most saves actually arrive in. It matches neither the oEmbed registry's
// pattern nor isRedditPost, so before this it skipped the whole Reddit path and
// the note ended up titled "Reddit" by the shell page's <title>.

const SHARE_URL = 'https://www.reddit.com/r/breadit/s/GStuyyUMKl'

test('isRedditShare matches a share link and nothing that merely looks like one', () => {
  assert.equal(isRedditShare(SHARE_URL), true)
  assert.equal(isRedditShare('https://reddit.com/r/breadit/s/abc/'), true, 'trailing slash')
  // r/s is a real subreddit name, and this is an ordinary post URL in it.
  assert.equal(isRedditShare('https://www.reddit.com/r/s/comments/abc123/x/'), false)
  assert.equal(isRedditShare(POST_URL), false)
  assert.equal(isRedditShare('https://notreddit.com/r/x/s/abc'), false)
  assert.equal(isRedditShare('not a url'), false)
})

test('fetchLinkMeta resolves a share link to the canonical post before fetching metadata', async () => {
  fetched = []
  // Reddit answers the share link with a redirect to the permalink, carrying
  // share_id/utm_* tracking params that must not reach the .json URL.
  responses = {
    [SHARE_URL]: {
      contentType: 'text/html',
      text: '<html><head><title>Reddit</title></head></html>',
      redirectsTo: POST_URL + '?share_id=abc&utm_medium=android_app',
    },
    [redditJsonUrl(POST_URL)]: { json: payload() },
  }
  const meta = await fetchLinkMeta(SHARE_URL, 'note-r4')

  assert.deepEqual(fetched, [SHARE_URL, redditJsonUrl(POST_URL), 'https://preview.redd.it/loaf.jpg?width=1080'],
    'the share link is followed once, then the canonical URL drives the rest')
  assert.equal(meta.siteTitle, 'My first sourdough', 'the real post title, not the "Reddit" shell title')
})

test('a share link that does not resolve to a post falls back to the generic path', async () => {
  // A share link to a subreddit rather than to a post: there is no permalink
  // behind it, so the generic oEmbed + OpenGraph route handles it as before.
  fetched = []
  const SUB_SHARE = 'https://www.reddit.com/r/breadit/s/zzz'
  responses = {
    [SUB_SHARE]: {
      contentType: 'text/html',
      text: '<html><head><meta property="og:title" content="r/breadit"></head></html>',
      redirectsTo: 'https://www.reddit.com/r/breadit/',
    },
  }
  const meta = await fetchLinkMeta(SUB_SHARE, 'note-r5')
  assert.equal(meta.siteTitle, 'r/breadit')
  assert.ok(!fetched.some((u) => u.endsWith('.json?raw_json=1&limit=20')), 'no .json fetch for a non-post')
})
