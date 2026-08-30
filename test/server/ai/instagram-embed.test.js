import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isInstagramPost,
  parseInstagramEmbed,
  instagramEmbedUrl,
  captionToMeta,
  describeMissingPieces,
  nextIgFetchDelay,
  isSafeFetchUrl,
  get,
  withLocation,
  mergeSiteDesc,
  parseInstagramCarousel,
  unescapeEmbedUrl,
} from '../../../server/ai/meta.js'

test('isInstagramPost: matches post/reel/tv URLs on instagram.com only', () => {
  assert.equal(isInstagramPost('https://www.instagram.com/reel/DEF456/'), true)
  assert.equal(isInstagramPost('https://instagram.com/p/ABC123/'), true)
  assert.equal(isInstagramPost('https://www.instagram.com/tv/XYZ/'), true)
  assert.equal(isInstagramPost('https://www.instagram.com/chefsteps/'), false)   // profile
  assert.equal(isInstagramPost('https://evil.com/instagram.com/p/ABC/'), false)
  assert.equal(isInstagramPost('not a url'), false)
})

test('parseInstagramEmbed: pulls caption text and image url from embed html', () => {
  const html = `<html><body>
    <img class="EmbeddedMediaImage" src="https://scontent.cdninstagram.com/x.jpg" alt="">
    <div class="Caption"><a>chefsteps</a> Brown butter pasta, 3 ingredients &amp; 10 minutes.<br>#pasta</div>
  </body></html>`
  const { caption, thumbUrl } = parseInstagramEmbed(html)
  // Exact match (not assert.match) pins entity decoding, <br>→newline, and
  // tag-stripping all at once — all three are implemented but a loose match
  // wouldn't actually prove any of them ran correctly.
  assert.equal(caption, 'chefsteps Brown butter pasta, 3 ingredients & 10 minutes.\n#pasta')
  assert.equal(thumbUrl, 'https://scontent.cdninstagram.com/x.jpg')
})

test('parseInstagramEmbed: login-walled or unexpected html yields empty result', () => {
  const { caption, thumbUrl } = parseInstagramEmbed('<html><body>Log in to see this</body></html>')
  assert.equal(caption, null)
  assert.equal(thumbUrl, null)
})

test('parseInstagramEmbed: nested <div> in the caption truncates at the first close tag (known, accepted tradeoff)', () => {
  const html = `<div class="Caption"><a>chefsteps</a> before<div class="unexpected">nested</div> after</div>`
  const { caption } = parseInstagramEmbed(html)
  assert.match(caption, /before/)
  assert.doesNotMatch(caption, /after/) // truncated, not garbled — still usable
})

test('parseInstagramEmbed: a caption ending in hashtags does not bleed "View all N comments" from the nested CaptionComments block (real embed markup shape)', () => {
  // Reproduces the actual structure Instagram serves: CaptionComments is
  // nested INSIDE Caption, right after the last hashtag, with no separating
  // whitespace — exactly the case the old "stop at first </div>" logic got
  // wrong, verified against a real fetched reel.
  const html = `<div class="Caption"><a class="CaptionUsername">someuser</a><br /><br />A calm scene<br />` +
    `<a href="/explore/tags/peace/">#peace</a> <a href="/explore/tags/view/">#view</a>` +
    `<div class="CaptionComments"><a class="CaptionCommentsExpand">View all 99 comments</a></div></div>`
  const { caption } = parseInstagramEmbed(html)
  assert.equal(caption, 'someuser\n\nA calm scene\n#peace #view')
  assert.doesNotMatch(caption, /View all/)
})

test('parseInstagramEmbed: pulls the tagged location, exact structured text, when present', () => {
  const html = `<span class="LocationAndSponsor">` +
    `<a class="Location" href="https://www.instagram.com/explore/locations/123/masjid-al-haram-makkah/">Masjid Al Haram Makkah</a>` +
    `</span><div class="Caption">the caption</div>`
  const { location, caption } = parseInstagramEmbed(html)
  assert.equal(location, 'Masjid Al Haram Makkah')
  assert.equal(caption, 'the caption')
})

test('parseInstagramEmbed: no Location tag (the common case — most posts carry none) yields null, not a failure', () => {
  const { location } = parseInstagramEmbed('<div class="Caption">no location on this one</div>')
  assert.equal(location, null)
})

test('withLocation: prepends the location to siteDesc, re-capped at 2000 chars', () => {
  assert.deepEqual(
    withLocation({ siteTitle: 't', siteDesc: 'the caption', thumb: null }, 'Masjid Al Haram Makkah'),
    { siteTitle: 't', siteDesc: 'Masjid Al Haram Makkah\n\nthe caption', thumb: null },
  )
  // no location: meta passed through unchanged
  const meta = { siteTitle: 't', siteDesc: 'the caption', thumb: null }
  assert.equal(withLocation(meta, null), meta)
  // no caption either — the location alone is still worth keeping
  assert.deepEqual(withLocation({ siteTitle: null, siteDesc: null }, 'Somewhere'), { siteTitle: null, siteDesc: 'Somewhere' })
  const capped = withLocation({ siteDesc: 'y'.repeat(3000) }, 'Loc')
  assert.equal(capped.siteDesc.length, 2000)
})

test('mergeSiteDesc: real og:description wins position, oEmbed author still kept; either alone still works', () => {
  assert.equal(mergeSiteDesc('the real video description', 'by MrBeast'), 'the real video description\n\nby MrBeast')
  assert.equal(mergeSiteDesc('the real video description', null), 'the real video description')
  assert.equal(mergeSiteDesc(null, 'by MrBeast'), 'by MrBeast')
  assert.equal(mergeSiteDesc(null, null), null)
})

// Meta rewrites this markup often; a naive `class="EmbeddedMediaImage"`
// literal match (or a bare `class="Caption"` literal) breaks on any of
// these — all measured failure modes from a real review of this parser.
test('parseInstagramEmbed: thumbnail extraction tolerates markup variation', () => {
  const variants = [
    ['attribute order swapped', '<img src="https://cdn.example/x.jpg" class="EmbeddedMediaImage" alt="">'],
    ['extra class token', '<img class="EmbeddedMediaImage Fixed" src="https://cdn.example/x.jpg">'],
    ['single-quoted attributes', "<img class='EmbeddedMediaImage' src='https://cdn.example/x.jpg'>"],
    ['class not the first attribute', '<img alt="" class="EmbeddedMediaImage" src="https://cdn.example/x.jpg">'],
  ]
  for (const [name, imgTag] of variants) {
    const { thumbUrl } = parseInstagramEmbed(`<html><body>${imgTag}</body></html>`)
    assert.equal(thumbUrl, 'https://cdn.example/x.jpg', name)
  }
})

test('parseInstagramEmbed: caption extraction tolerates markup variation', () => {
  const variants = [
    ['trailing space in class', '<div class="Caption ">hello caption</div>'],
    ['extra class token', '<div class="Caption Expanded">hello caption</div>'],
    ['class not the first attribute', '<div id="foo" class="Caption">hello caption</div>'],
    ['single-quoted attributes', "<div class='Caption'>hello caption</div>"],
  ]
  for (const [name, html] of variants) {
    const { caption } = parseInstagramEmbed(html)
    assert.equal(caption, 'hello caption', name)
  }
})

test('parseInstagramEmbed: a "CaptionUsername" or "CaptionComments" class is not mistaken for the real Caption block', () => {
  const html1 = '<div class="CaptionUsername">not the caption</div><div class="Caption">the real caption</div>'
  assert.equal(parseInstagramEmbed(html1).caption, 'the real caption')
  const html2 = '<div class="CaptionComments">not the caption</div><div class="Caption">the real caption</div>'
  assert.equal(parseInstagramEmbed(html2).caption, 'the real caption')
})

test('instagramEmbedUrl: builds the /embed/captioned/ url (the variant that emits the Caption block) regardless of trailing slash or query string', () => {
  assert.equal(instagramEmbedUrl('https://www.instagram.com/p/ABC/'), 'https://www.instagram.com/p/ABC/embed/captioned/')
  assert.equal(instagramEmbedUrl('https://www.instagram.com/p/ABC'), 'https://www.instagram.com/p/ABC/embed/captioned/')
  assert.equal(
    instagramEmbedUrl('https://www.instagram.com/p/ABC/?igsh=xyz'),
    'https://www.instagram.com/p/ABC/embed/captioned/',
  ) // the naive `url.replace(/\/?$/, '/') + 'embed/'` produces `.../?igsh=xyz/embed/`, which 404s
})

test('instagramEmbedUrl: does not double up when the input is already an embed link', () => {
  assert.equal(
    instagramEmbedUrl('https://www.instagram.com/p/ABC/embed/'),
    'https://www.instagram.com/p/ABC/embed/captioned/',
  )
  assert.equal(
    instagramEmbedUrl('https://www.instagram.com/p/ABC/embed/captioned/'),
    'https://www.instagram.com/p/ABC/embed/captioned/',
  )
})

test('instagramEmbedUrl: returns null for non-URL input rather than throwing (exported, may see arbitrary strings)', () => {
  assert.equal(instagramEmbedUrl('not a url'), null)
})

test('instagramEmbedUrl: a shortcode that happens to end in "embed" is not mistaken for an /embed/ path segment', () => {
  // A naive `.replace(/embed\/(captioned\/)?$/, '')` (no leading `/` anchor)
  // would chop "embed/" out of the middle of "Cxyzembed/", corrupting the
  // shortcode into "Cxyz" and 404ing silently.
  assert.equal(
    instagramEmbedUrl('https://www.instagram.com/p/Cxyzembed/'),
    'https://www.instagram.com/p/Cxyzembed/embed/captioned/',
  )
})

test('captionToMeta: title is the first line capped at 120 chars, desc is the full caption capped at 2000', () => {
  const short = captionToMeta('short title\nrest of the caption')
  assert.equal(short.siteTitle, 'short title')
  assert.equal(short.siteDesc, 'short title\nrest of the caption')

  const longFirstLine = 'x'.repeat(200)
  const capped = captionToMeta(longFirstLine)
  assert.equal(capped.siteTitle, longFirstLine.slice(0, 120))
  assert.equal(capped.siteTitle.length, 120)

  const longCaption = 'y'.repeat(3000)
  const cappedDesc = captionToMeta(longCaption)
  assert.equal(cappedDesc.siteDesc.length, 2000)
})

test('describeMissingPieces: warns even when only the caption is missing (thumbnail found → looks like a partial success)', () => {
  // This is the `||` vs `&&` fix: a plain "both missing" check silently
  // passes when the thumbnail parses but the caption block is gone from
  // the markup — exactly the failure MUST FIX 1 was.
  assert.equal(describeMissingPieces(null, 'https://cdn.example/x.jpg'), 'caption')
})

test('describeMissingPieces: warns even when only the thumbnail is missing', () => {
  assert.equal(describeMissingPieces('a caption', null), 'thumbnail')
})

test('describeMissingPieces: names both when both are missing, null when both are present', () => {
  assert.equal(describeMissingPieces(null, null), 'caption and thumbnail')
  assert.equal(describeMissingPieces('a caption', 'https://cdn.example/x.jpg'), null)
})

test('nextIgFetchDelay: the first Instagram fetch of a session never waits', () => {
  assert.equal(nextIgFetchDelay(Date.now(), 0, 0), 0)
})

test('nextIgFetchDelay: waits out the remainder of the throttle window', () => {
  assert.equal(nextIgFetchDelay(1000, 1000, 0), 2500)
  assert.equal(nextIgFetchDelay(3000, 1000, 0), 500)
  assert.equal(nextIgFetchDelay(3600, 1000, 0), 0) // window already elapsed
})

test('isSafeFetchUrl: allows http(s), rejects data: URLs and malformed input (attacker-controlled thumb/og:image guard)', () => {
  assert.equal(isSafeFetchUrl('https://scontent.cdninstagram.com/x.jpg'), true)
  assert.equal(isSafeFetchUrl('http://example.com/x.jpg'), true)
  assert.equal(isSafeFetchUrl('data:image/jpeg;base64,/9j/xyz'), false)
  assert.equal(isSafeFetchUrl('file:///etc/passwd'), false)
  assert.equal(isSafeFetchUrl('not a url'), false)
})

test('get: rejects non-http(s) URLs before ever calling fetch (no network I/O — the guard throws first)', async () => {
  await assert.rejects(() => get('data:text/plain,hi', 'text/plain'), /unsupported URL scheme/)
})

// The scheme check alone never stopped these — http://169.254.169.254 is a
// perfectly valid http(s) URL. These assert get() actually routes through
// server/lib/ssrf.js (which owns the range rules and their own tests), rather
// than that the ranges themselves are right.
test('get: rejects internal and loopback addresses — the SSRF guard is wired into the real fetch path', async () => {
  await assert.rejects(() => get('http://169.254.169.254/latest/meta-data/', '*/*'), /blocked address/)
  await assert.rejects(() => get('http://127.0.0.1:5173/api/export', '*/*'), /blocked (address|port)/)
  await assert.rejects(() => get('http://[::1]/', '*/*'), /blocked address/)
})

test('get: rejects a non-web port, so a stashed link cannot probe internal services', async () => {
  await assert.rejects(() => get('http://example.com:6379/', '*/*'), /blocked port/)
})


// ---- carousel (sidecar) slides -------------------------------------------
// The embed page carries the sidecar JSON double-escaped: it is a JSON string
// nested inside another JSON string inside the HTML, so a slide URL appears as
// display_url\":\"https:\\\/\\\/host\/path. These fixtures reproduce that exact
// escaping rather than a cleaned-up version of it.
const slide = (n) => `display_url\\":\\"https:\\\\\\/\\\\\\/cdn.example.com\\\\\\/s${n}.jpg?a=1\\u00253D\\"`

test('unescapeEmbedUrl: undoes the double escaping, \\u0025 before the slashes', () => {
  assert.equal(
    unescapeEmbedUrl('https:\\\\\\/\\\\\\/cdn.example.com\\\\\\/s1.jpg?a=1\\u00253D'),
    'https://cdn.example.com/s1.jpg?a=1%3D',
  )
})

test('parseInstagramCarousel: returns sidecar slide urls in post order', () => {
  const html = `x edge_sidecar_to_children\\":{\\"edges\\":[{\\"node\\":{${slide(1)}}},{\\"node\\":{${slide(2)}}}]}`
  assert.deepEqual(parseInstagramCarousel(html), [
    'https://cdn.example.com/s1.jpg?a=1%3D',
    'https://cdn.example.com/s2.jpg?a=1%3D',
  ])
})

test('parseInstagramCarousel: a single-image post has no sidecar, so no deck', () => {
  const html = `<html><img class="EmbeddedMediaImage" src="https://cdn.example.com/only.jpg"></html>`
  assert.deepEqual(parseInstagramCarousel(html), [])
})

test('parseInstagramCarousel: ignores the cover display_url that precedes the sidecar', () => {
  // The top-level media node carries its own display_url before the sidecar
  // key. Anchoring past that key is what keeps the cover out of the deck.
  const html = `${slide(9)} ... edge_sidecar_to_children ${slide(1)} ${slide(2)}`
  assert.deepEqual(parseInstagramCarousel(html), [
    'https://cdn.example.com/s1.jpg?a=1%3D',
    'https://cdn.example.com/s2.jpg?a=1%3D',
  ])
})

test('parseInstagramCarousel: de-dupes a slide url repeated by the surrounding json', () => {
  const html = `edge_sidecar_to_children ${slide(1)} ${slide(1)} ${slide(2)}`
  assert.equal(parseInstagramCarousel(html).length, 2)
})

test('parseInstagramCarousel: caps a runaway deck at 20 slides', () => {
  const html = 'edge_sidecar_to_children ' + Array.from({ length: 40 }, (_, i) => slide(i)).join(' ')
  assert.equal(parseInstagramCarousel(html).length, 20)
})

test('parseInstagramCarousel: drops non-http slide urls', () => {
  const html = `edge_sidecar_to_children display_url\\":\\"data:image/png;base64,AAAA\\" ${slide(1)}`
  assert.deepEqual(parseInstagramCarousel(html), ['https://cdn.example.com/s1.jpg?a=1%3D'])
})
