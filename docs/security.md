# Security

What Kothai defends against, how, and what it doesn't.

- [Threat model](#threat-model)
- [The password gate](#the-password-gate)
- [The SSRF guard](#the-ssrf-guard)
- [Secrets handling](#secrets-handling)
- [Untrusted uploads](#untrusted-uploads)
- [What is deliberately not protected](#what-is-deliberately-not-protected)
- [Deployment guidance](#deployment-guidance)

## Threat model

Kothai is a **single-user, local-first** app, built on the assumption that
everyone who can reach the port is you. Two guards exist for when that
assumption breaks:

| Threat | Guard |
|---|---|
| The app is reachable by someone who isn't you | `STASH_PASSWORD` — [the password gate](#the-password-gate) |
| A saved page's URLs make *your server* fetch things it shouldn't | [the SSRF guard](#the-ssrf-guard) |

No per-user separation, no rate limiting outside login, no audit log —
all intentional for a single-user app.

## The password gate

Set `STASH_PASSWORD` and the app requires login. Unset, there's no auth at
all — that default stays so every LAN/Tailscale install is unaffected by
upgrades. The server logs which mode it's in on every boot.

Implemented in [`server/lib/auth.js`](../server/lib/auth.js), enforced once
in `router.js` in front of every route and the static/uploads fallthrough.

**Sessions**: token is `<expiry>.<hmac-sha256>`, signing key derived from the
password via HKDF (no separate secret to lose, and changing the password
invalidates all sessions). 30-day TTL.

**Hardening details:**
- Password/signature comparisons run on fixed-length hashes with
  `timingSafeEqual`, avoiding length-based error leaks.
- CSRF: `SameSite=Lax` cookies plus a required JSON content-type on
  mutations (covers same-site-different-port, which `SameSite` alone
  doesn't).
- `Secure` cookie flag is set only when the request is actually HTTPS
  (via `x-forwarded-proto`), so login doesn't silently fail on plain-HTTP
  LAN installs.
- Login is rate-limited (sliding window per client IP, in-memory, capped
  at 5000 keys); everything else is unthrottled.

**Routes in front of the gate:**
- `GET /api/health` / `GET /up` — unauthenticated health probes (`/up` is
  what [ONCE](https://github.com/basecamp/once) requires), return nothing
  but `{ ok: true }`.
- `POST /api/checkpoint` stays **behind** the gate. ONCE's `pre-backup`
  hook authenticates with `STASH_PASSWORD` like any other client.

## The SSRF guard

Every URL Kothai fetches for a link preview (`og:image`, oEmbed, scraped
JSON) is attacker-influenced — anyone who can get a link saved chooses it.
Unguarded, the server becomes a request proxy for its own network.

[`server/lib/ssrf.js`](../server/lib/ssrf.js) resolves the hostname and
checks the resolved address (not the string), and re-checks on every
redirect (max 5 hops, by hand).

Blocked ranges:

| Range | |
|---|---|
| `0.0.0.0/8`, `127/8` | loopback |
| `10/8`, `172.16/12`, `192.168/16` | RFC1918 private |
| `100.64/10` | CGNAT + Tailscale's range |
| `169.254/16` | link-local + cloud instance metadata |
| `192.0.0/24`, `198.18/15`, `224/4`, `240/4` | IETF/benchmark/multicast/reserved |

IPv6 is parsed to raw bytes, not string-matched, to catch spellings like
`::ffff:127.0.0.1`. Ports are restricted to **80 and 443**.

**Escape hatch**: `STASH_ALLOW_PRIVATE_FETCH=1` disables the address check,
for previewing intranet links on a trusted network. Only `1`/`true` are
accepted, so a typo fails closed.

## Secrets handling

`STASH_PASSWORD`, `STASH_AI_BASE_URL`, `STASH_AI_API_KEY` are env-only —
never written to SQLite, so never leak via backup or export.

`GET /api/settings` echoes only the endpoint's hostname, never the full URL
or key (some providers put credentials in the URL path). Model names are
stored in the settings table.

## Untrusted uploads

Data-export imports are ZIPs read by a hand-rolled parser
([`server/lib/zip.js`](../server/lib/zip.js)):

- request bodies capped at 25 MB (64 MB for imports), 20 files per import
- each importer's `sniff()` and `parse()` run in their own try/catch, so
  one bad importer/file can't break the rest
- imports serialize against each other to prevent double-import
- `POST /api/wipe` needs an exact confirmation token, and refuses mid-import

## What is deliberately not protected

- **No multi-user separation.** One password, one archive.
- **No rate limiting outside login.**
- **No CSP, no subresource integrity.** Client is first-party and bundled.
- **No encryption at rest.** `data/kothai.db` is a plain SQLite file.
- **No audit log.**
- **Uploads are served back as files** — fine for one user, not for a
  shared install.
- **Model output isn't sanitised** beyond markdown handling.

## Deployment guidance

| Where it runs | What to do |
|---|---|
| **Localhost** | Nothing. |
| **Your LAN** | Nothing, if you trust the LAN. |
| **Tailscale / WireGuard** | **Recommended for remote access.** Nothing is exposed to the public internet. |
| **Public hostname** | Set `STASH_PASSWORD`, put TLS in front, and consider a second auth layer (Authelia, Cloudflare Access, Caddy `basic_auth`). |

> [!CAUTION]
> Kothai speaks plain HTTP. Without `STASH_PASSWORD` set, anyone who can
> reach the port can read, write, and delete everything, and use your
> server as a fetch proxy. Never expose it unauthenticated.

Config, reverse-proxy snippets, and backup procedure are in
[self-hosting.md](self-hosting.md).
