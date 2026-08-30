// Unit tests for server/lib/ssrf.js — the outbound-fetch guard that stands in
// front of every link-preview / thumbnail fetch the app makes.
//
// The threat: og:image, oEmbed and Instagram embed URLs are all
// attacker-influenced (anyone who can get you to save a link chooses them), and
// they were passed straight to fetch(). On a shared host or a VPS that reaches
// a private network, `http://169.254.169.254/latest/meta-data/` is a cloud
// credential read and `http://10.0.0.5:6379/` is an internal service probe.
//
// Network is mocked because the whole point is what happens BEFORE a socket is
// opened — a real fetch would defeat the test. The resolver is injected for the
// same reason: DNS answers are the attacker's other lever.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isBlockedAddress, isAllowedPort, assertPublicUrl, safeFetch } from '../../../server/lib/ssrf.js'

// A resolver stub. Takes a hostname → address map; anything unmapped is NXDOMAIN.
const resolver = (map) => async (host) => {
  const addrs = map[host]
  if (!addrs) throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })
  return addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
}

// ---- the address predicate ---------------------------------------------

test('isBlockedAddress: the IPv4 ranges an SSRF actually targets', () => {
  for (const ip of [
    '127.0.0.1',        // loopback
    '127.1.2.3',        // …the whole /8, not just .0.1
    '0.0.0.0',          // "this host" — routes to loopback on Linux
    '10.0.0.5',         // RFC1918
    '172.16.0.1',       // RFC1918, bottom of the /12
    '172.31.255.255',   // RFC1918, top of the /12
    '192.168.1.1',      // RFC1918
    '169.254.169.254',  // AWS/GCP/Azure instance metadata — the crown jewel
    '100.64.0.1',       // CGNAT + Tailscale: a link preview must not reach the tailnet
    '198.18.0.1',       // benchmarking
    '192.0.0.1',        // IETF protocol assignments
    '224.0.0.1',        // multicast
    '255.255.255.255',  // broadcast (240/4)
  ]) {
    assert.equal(isBlockedAddress(ip), true, `${ip} should be blocked`)
  }
})

test('isBlockedAddress: ordinary public IPv4 is allowed, including the addresses just outside each private range', () => {
  for (const ip of [
    '8.8.8.8',
    '93.184.216.34',
    '172.15.255.255',  // one below 172.16/12
    '172.32.0.0',      // one above 172.16/12
    '100.63.255.255',  // one below 100.64/10
    '100.128.0.0',     // one above 100.64/10
    '223.255.255.255', // one below multicast
  ]) {
    assert.equal(isBlockedAddress(ip), false, `${ip} should be allowed`)
  }
})

test('isBlockedAddress: the IPv6 equivalents', () => {
  for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1']) {
    assert.equal(isBlockedAddress(ip), true, `${ip} should be blocked`)
  }
  assert.equal(isBlockedAddress('2606:4700:4700::1111'), false)
  assert.equal(isBlockedAddress('2001:4860:4860::8888'), false)
})

test('isBlockedAddress: IPv4-mapped IPv6 is unwrapped, so ::ffff:127.0.0.1 cannot smuggle loopback past a v6 check', () => {
  assert.equal(isBlockedAddress('::ffff:127.0.0.1'), true)
  // The form the URL parser and getaddrinfo actually hand back — same address,
  // written as hex groups. A checker that only understood the dotted spelling
  // would wave this through.
  assert.equal(isBlockedAddress('::ffff:7f00:1'), true)
  assert.equal(isBlockedAddress('::ffff:169.254.169.254'), true)
  assert.equal(isBlockedAddress('::ffff:8.8.8.8'), false)
})

test('isBlockedAddress: NAT64 (64:ff9b::/96) is unwrapped too — it embeds a v4 address the same way', () => {
  assert.equal(isBlockedAddress('64:ff9b::7f00:1'), true)       // → 127.0.0.1
  assert.equal(isBlockedAddress('64:ff9b::a9fe:a9fe'), true)    // → 169.254.169.254
  assert.equal(isBlockedAddress('64:ff9b::808:808'), false)     // → 8.8.8.8
})

test('isBlockedAddress: unparseable input is blocked, never waved through', () => {
  for (const junk of ['', 'not-an-ip', '999.1.1.1', 'zz::1', null, undefined]) {
    assert.equal(isBlockedAddress(junk), true)
  }
})

// ---- ports --------------------------------------------------------------

test('isAllowedPort: only the two web ports, whether implicit or written out', () => {
  assert.equal(isAllowedPort(new URL('https://example.com/a.jpg')), true)
  assert.equal(isAllowedPort(new URL('http://example.com/a.jpg')), true)
  assert.equal(isAllowedPort(new URL('https://example.com:443/a.jpg')), true)
  assert.equal(isAllowedPort(new URL('http://example.com:80/a.jpg')), true)
  // A link preview has no business speaking to Redis, SSH or an admin panel.
  assert.equal(isAllowedPort(new URL('http://example.com:6379/')), false)
  assert.equal(isAllowedPort(new URL('http://example.com:22/')), false)
  assert.equal(isAllowedPort(new URL('http://example.com:8080/')), false)
})

// ---- the resolving check ------------------------------------------------

test('assertPublicUrl: rejects a non-http(s) scheme before any lookup happens', async () => {
  let looked = false
  const lookup = async () => { looked = true; return [] }
  await assert.rejects(() => assertPublicUrl('data:text/plain,hi', { lookup }), /unsupported URL scheme/)
  assert.equal(looked, false)
})

test('assertPublicUrl: an IP literal is checked directly, without consulting DNS', async () => {
  let looked = false
  const lookup = async () => { looked = true; return [] }
  await assert.rejects(() => assertPublicUrl('http://169.254.169.254/latest/meta-data/', { lookup }), /blocked address/)
  assert.equal(looked, false)
})

test('assertPublicUrl: a bracketed IPv6 literal has its brackets stripped before checking', async () => {
  await assert.rejects(() => assertPublicUrl('http://[::1]/', { lookup: resolver({}) }), /blocked address/)
})

test('assertPublicUrl: a public-looking hostname that RESOLVES to a private address is rejected', async () => {
  // This is the case the scheme check never caught: nothing about the URL
  // "http://internal.evil.com/" looks dangerous until you resolve it.
  const lookup = resolver({ 'internal.evil.com': ['127.0.0.1'] })
  await assert.rejects(() => assertPublicUrl('http://internal.evil.com/', { lookup }), /blocked address/)
})

test('assertPublicUrl: rejects when ANY answer is private, not just the first', async () => {
  // A rebinding host can return a public A record alongside a private one and
  // let the OS pick. Checking only answers[0] would pass this.
  const lookup = resolver({ 'mixed.example.com': ['93.184.216.34', '10.0.0.5'] })
  await assert.rejects(() => assertPublicUrl('http://mixed.example.com/', { lookup }), /blocked address/)
})

test('assertPublicUrl: a hostname resolving only to public addresses passes', async () => {
  const lookup = resolver({ 'example.com': ['93.184.216.34', '2606:4700::1111'] })
  await assert.doesNotReject(() => assertPublicUrl('https://example.com/x.jpg', { lookup }))
})

test('assertPublicUrl: a name that does not resolve fails closed', async () => {
  await assert.rejects(() => assertPublicUrl('http://nope.invalid/', { lookup: resolver({}) }), /cannot resolve/)
})

test('assertPublicUrl: a non-web port is rejected even on a public host', async () => {
  const lookup = resolver({ 'example.com': ['93.184.216.34'] })
  await assert.rejects(() => assertPublicUrl('http://example.com:6379/', { lookup }), /blocked port/)
})

test('assertPublicUrl: allowPrivate re-opens everything except the scheme check (the intranet escape hatch)', async () => {
  const lookup = resolver({ 'nas.local': ['192.168.1.10'] })
  await assert.doesNotReject(() => assertPublicUrl('http://nas.local:8080/', { lookup, allowPrivate: true }))
  await assert.doesNotReject(() => assertPublicUrl('http://127.0.0.1:5173/', { lookup, allowPrivate: true }))
  // Scheme is not part of the escape hatch: data: URLs smuggle a payload onto
  // disk via saveThumb regardless of what the network policy is.
  await assert.rejects(() => assertPublicUrl('data:text/plain,hi', { lookup, allowPrivate: true }), /unsupported URL scheme/)
})

// ---- redirects ----------------------------------------------------------

// Minimal Response-alikes; safeFetch only ever touches status/headers/body.
const redirectTo = (location, status = 302) => ({
  status,
  headers: new Headers({ location }),
  body: { cancel: async () => {} },
})
const ok = (marker) => ({ status: 200, headers: new Headers(), body: null, marker })

test('safeFetch: follows a redirect to another public host', async () => {
  const lookup = resolver({ 'a.example.com': ['93.184.216.34'], 'b.example.com': ['8.8.8.8'] })
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push([url, init.redirect])
    return url === 'http://a.example.com/' ? redirectTo('http://b.example.com/final') : ok('landed')
  }
  const res = await safeFetch('http://a.example.com/', {}, { fetchImpl, lookup })
  assert.equal(res.marker, 'landed')
  assert.deepEqual(seen.map(([u]) => u), ['http://a.example.com/', 'http://b.example.com/final'])
  // Every hop must be manual, or the runtime follows the chain itself and the
  // guard never sees the intermediate hops at all.
  assert.deepEqual(seen.map(([, r]) => r), ['manual', 'manual'])
})

test('safeFetch: refuses a redirect that lands on a private address (the gap redirect:follow left open)', async () => {
  const lookup = resolver({ 'harmless.example.com': ['93.184.216.34'] })
  const fetchImpl = async () => redirectTo('http://169.254.169.254/latest/meta-data/')
  await assert.rejects(
    () => safeFetch('http://harmless.example.com/', {}, { fetchImpl, lookup }),
    /blocked address/,
  )
})

test('safeFetch: a relative Location is resolved against the hop it came from, then re-checked', async () => {
  const lookup = resolver({ 'a.example.com': ['93.184.216.34'] })
  const seen = []
  const fetchImpl = async (url) => {
    seen.push(url)
    return url === 'http://a.example.com/one' ? redirectTo('/two') : ok('landed')
  }
  const res = await safeFetch('http://a.example.com/one', {}, { fetchImpl, lookup })
  assert.equal(res.marker, 'landed')
  assert.deepEqual(seen, ['http://a.example.com/one', 'http://a.example.com/two'])
})

test('safeFetch: gives up on a redirect loop rather than spinning forever', async () => {
  const lookup = resolver({ 'loop.example.com': ['93.184.216.34'] })
  const fetchImpl = async () => redirectTo('http://loop.example.com/again')
  await assert.rejects(() => safeFetch('http://loop.example.com/', {}, { fetchImpl, lookup }), /too many redirects/)
})

test('safeFetch: drains each redirect response body so the connection is not left hanging', async () => {
  const lookup = resolver({ 'a.example.com': ['93.184.216.34'] })
  let cancelled = 0
  const fetchImpl = async (url) =>
    url === 'http://a.example.com/'
      ? { status: 302, headers: new Headers({ location: 'http://a.example.com/final' }), body: { cancel: async () => { cancelled++ } } }
      : ok('landed')
  await safeFetch('http://a.example.com/', {}, { fetchImpl, lookup })
  assert.equal(cancelled, 1)
})

test('safeFetch: a 3xx with no Location is returned as-is rather than treated as a hop', async () => {
  const lookup = resolver({ 'a.example.com': ['93.184.216.34'] })
  const fetchImpl = async () => ({ status: 304, headers: new Headers(), body: null, marker: 'not-modified' })
  const res = await safeFetch('http://a.example.com/', {}, { fetchImpl, lookup })
  assert.equal(res.marker, 'not-modified')
})
