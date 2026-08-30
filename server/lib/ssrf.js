// Outbound-fetch guard for link previews and thumbnails.
//
// Every URL this app fetches from the open internet is attacker-influenced:
// og:image and twitter:image come from the page being previewed, oEmbed
// endpoints from its provider, Instagram slide URLs from a scraped JSON blob.
// Anyone who can get a link saved to a stash chooses them. Unguarded, that
// turns the server into a request proxy for whatever network it sits on —
// `http://169.254.169.254/latest/meta-data/` reads cloud instance credentials,
// `http://10.0.0.5:6379/` probes an internal service, and on shared hosting the
// blast radius is the provider's network rather than one user's box.
//
// Two things have to be true for a fetch to be safe, and a scheme check gives
// neither: the address actually connected to must be public, and that has to
// stay true across every redirect hop. So this module resolves the hostname and
// checks the ANSWERS, and follows redirects by hand so each hop is re-checked.
import dns from 'node:dns/promises'
import net from 'node:net'
import { ALLOW_PRIVATE_FETCH } from '../config.js'

// A link preview only ever needs to speak HTTP. Restricting the port keeps an
// attacker-supplied URL from reaching an admin panel, a database or an SSH
// banner on a host that is otherwise legitimately public.
const ALLOWED_PORTS = new Set([80, 443])
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])
const MAX_HOPS = 5

// ---- address classification --------------------------------------------

// Not just RFC1918. 169.254/16 is the metadata-service range every major cloud
// uses; 100.64/10 is CGNAT, which is also Tailscale's range — a link preview
// reaching into the tailnet is exactly the thing to prevent, so blocking it
// here is deliberate, not collateral. 0/8 matters because 0.0.0.0 routes to
// loopback on Linux, and 240/4 carries the 255.255.255.255 broadcast address.
const V4_BLOCKED = [
  ['0.0.0.0', 8],        // "this host on this network"
  ['10.0.0.0', 8],       // RFC1918
  ['100.64.0.0', 10],    // CGNAT / Tailscale
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local + cloud instance metadata
  ['172.16.0.0', 12],    // RFC1918
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.168.0.0', 16],   // RFC1918
  ['198.18.0.0', 15],    // benchmarking
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved, incl. 255.255.255.255
]

function v4ToInt(ip) {
  if (!net.isIPv4(ip)) return null
  const p = ip.split('.').map(Number)
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0
}

function v4Blocked(n) {
  if (n === null) return true
  return V4_BLOCKED.some(([base, bits]) => ((n ^ v4ToInt(base)) >>> (32 - bits)) === 0)
}

// IPv6 text → 16 bytes. Node validates the syntax (net.isIPv6) but exposes no
// parser, and the checks below need the actual bits: a prefix test on the
// string form would have to cope with every legal spelling of the same address.
// Handles the one "::" run and a trailing dotted-quad group.
function v6ToBytes(ip) {
  if (!net.isIPv6(ip)) return null
  const dbl = ip.indexOf('::')
  const head = dbl === -1 ? ip : ip.slice(0, dbl)
  const tail = dbl === -1 ? '' : ip.slice(dbl + 2)
  const toGroups = (s) => {
    if (!s) return []
    const out = []
    for (const part of s.split(':')) {
      if (part.includes('.')) {
        const n = v4ToInt(part) // ::ffff:127.0.0.1 spells its last 32 bits in dotted form
        if (n === null) return null
        out.push((n >>> 16) & 0xffff, n & 0xffff)
      } else {
        out.push(parseInt(part, 16))
      }
    }
    return out
  }
  const h = toGroups(head)
  const t = toGroups(tail)
  if (!h || !t) return null
  const fill = 8 - h.length - t.length
  if (fill < 0 || (dbl === -1 && fill !== 0)) return null
  const groups = [...h, ...Array(fill).fill(0), ...t]
  return groups.flatMap((g) => [(g >> 8) & 0xff, g & 0xff])
}

const startsWith = (bytes, prefix) => prefix.every((b, i) => bytes[i] === b)

// Two well-known prefixes carry a whole IPv4 address in their low 32 bits, so
// ::ffff:7f00:1 and 64:ff9b::7f00:1 are both just 127.0.0.1 wearing a hat. A
// checker that only knew the v6 rules would wave either straight through.
function embeddedV4(bytes) {
  const mapped = startsWith(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff])
  const nat64 = startsWith(bytes, [0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0])
  if (!mapped && !nat64) return null
  return (((bytes[12] << 24) | (bytes[13] << 16) | (bytes[14] << 8) | bytes[15]) >>> 0)
}

function v6Blocked(b) {
  if (b.every((x) => x === 0)) return true                       // ::
  if (startsWith(b, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])) return true // ::1
  if ((b[0] & 0xfe) === 0xfc) return true                        // fc00::/7 unique-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true       // fe80::/10 link-local
  if (b[0] === 0xff) return true                                 // ff00::/8 multicast
  return false
}

// Fails closed: anything this cannot parse is treated as blocked, because an
// address it does not understand is an address it cannot vouch for.
//
// Not decoded: 6to4 (2002::/16) and Teredo (2001::/32), which also embed v4.
// getaddrinfo only returns those if a host publishes them, and reaching a
// private v4 through one needs a relay that will not forward to RFC1918 anyway.
export function isBlockedAddress(ip) {
  if (typeof ip !== 'string' || !ip) return true
  if (net.isIPv4(ip)) return v4Blocked(v4ToInt(ip))
  if (net.isIPv6(ip)) {
    const bytes = v6ToBytes(ip)
    if (!bytes) return true
    const embedded = embeddedV4(bytes)
    return embedded === null ? v6Blocked(bytes) : v4Blocked(embedded)
  }
  return true
}

export function isAllowedPort(url) {
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
  return ALLOWED_PORTS.has(port)
}

// ---- the check ----------------------------------------------------------

// Throws unless `url` is safe to fetch. `lookup` is injected so tests can drive
// DNS answers — the resolver is the attacker's other lever, and a test that
// used the real one would be testing the internet.
//
// Known and accepted: there is a TOCTOU window between resolving here and the
// connection undici opens, so a DNS record that flips between the two still
// gets through. Closing it means pinning the resolved IP on the socket, which
// means dropping fetch() for node:http with a custom agent lookup — a large
// rewrite of every call path for a much narrower attack than the ones above.
export async function assertPublicUrl(url, opts = {}) {
  const { lookup = dns.lookup, allowPrivate = ALLOW_PRIVATE_FETCH } = opts

  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`unsupported URL scheme: ${url}`)
  }
  // Checked even under allowPrivate: data: URLs are not a network-policy
  // question, they are a way to write an arbitrary payload to disk via
  // saveThumb without anything being hosted anywhere.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`unsupported URL scheme: ${parsed.protocol}`)
  }
  if (allowPrivate) return

  if (!isAllowedPort(parsed)) throw new Error(`blocked port: ${parsed.port}`)

  // URL keeps the brackets on an IPv6 literal; net.isIP does not want them.
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new Error(`blocked address: ${host}`)
    return
  }

  let answers
  try {
    answers = await lookup(host, { all: true, verbatim: true })
  } catch {
    throw new Error(`cannot resolve ${host}`)
  }
  if (!answers?.length) throw new Error(`cannot resolve ${host}`)
  // Every answer, not just the first: a host can publish a public A record
  // beside a private one and let the OS pick which to connect to.
  for (const { address } of answers) {
    if (isBlockedAddress(address)) throw new Error(`blocked address: ${address} (${host})`)
  }
}

// fetch() with the guard applied to the initial URL and to every redirect hop.
//
// `redirect: 'manual'` is the whole point. Under the default 'follow' the
// runtime chases the chain itself and this code only ever sees where it landed
// — so a URL that passes the check and then 302s to 169.254.169.254 defeats it
// entirely. Node's fetch (unlike a browser's) exposes the real status and
// Location on a manual redirect, so the chain can be walked here instead.
export async function safeFetch(url, init = {}, opts = {}) {
  const { fetchImpl = fetch, lookup, allowPrivate, maxHops = MAX_HOPS } = opts
  let current = String(url)

  for (let hop = 0; hop <= maxHops; hop++) {
    await assertPublicUrl(current, { lookup, allowPrivate })
    const res = await fetchImpl(current, { ...init, redirect: 'manual' })
    if (!REDIRECT_STATUS.has(res.status)) return res
    const location = res.headers.get('location')
    if (!location) return res // a 3xx that is not actually a redirect (304, or a broken server)
    // Nothing reads a redirect's body, and undici keeps the connection open
    // until it is consumed or cancelled.
    try {
      await res.body?.cancel?.()
    } catch {
      /* already closed */
    }
    current = new URL(location, current).href // relative Location resolves against the hop it came from
  }
  throw new Error(`too many redirects (>${maxHops})`)
}
