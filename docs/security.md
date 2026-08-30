# Security

What Kothai defends against, how, and — just as importantly — what it doesn't.

- [Threat model](#threat-model)
- [The password gate](#the-password-gate)
- [The SSRF guard](#the-ssrf-guard)
- [Secrets handling](#secrets-handling)
- [Untrusted uploads](#untrusted-uploads)
- [What is deliberately not protected](#what-is-deliberately-not-protected)
- [Deployment guidance](#deployment-guidance)

## Threat model

Kothai is a **single-user, local-first** app. The design assumption is that it
runs on hardware you control, on a network you trust, and that everyone who can
reach the port is you.

Two things break that assumption, and both have guards:

| Threat | Guard |
|---|---|
| The app is reachable by someone who isn't you (public hostname, shared network) | `STASH_PASSWORD` — [the password gate](#the-password-gate) |
| A page you save contains URLs that make *your server* fetch things it shouldn't | [the SSRF guard](#the-ssrf-guard) |

Everything else — no per-user separation, no rate limiting outside login, no
audit log — follows from single-user and is intentional.

## The password gate

Set `STASH_PASSWORD` and the whole app requires a login. Unset, there's no auth
at all. That default is deliberate and stays: every LAN and Tailscale install
must be unaffected by an upgrade. The server states which mode it's in on
**every boot**, both ways round, because "no password" is exactly the thing you
want to notice before pointing a public hostname at it.

Implemented in [`server/lib/auth.js`](../server/lib/auth.js), enforced at a
single choke point in `router.js` — in front of every route *and* the
static/uploads fallthrough, which is why it lives there rather than being
repeated per handler.

### Sessions

Token is `<expiry>.<hmac-sha256>`, with the signing key **derived from the
password** via HKDF rather than being a separate random secret.

Two things fall out of that for free:

- there's no extra secret to generate, persist or lose — so a container restart
  doesn't log you out, which a server-side session table would;
- changing the password invalidates every outstanding session, with no
  revocation list.

The expiry travels in the clear; the signature is what stops it being edited.
30-day TTL.

### The careful bits

<details>
<summary><b>Timing-safe comparison, on hashes</b></summary>

`passwordMatches` hashes both sides first so the comparison is over two 32-byte
digests. `timingSafeEqual` requires equal lengths, and comparing raw strings
would throw on a wrong-length guess — leaking the password's length through the
error path, and only for that guess.

`verifySession` likewise rejects a wrong-length signature before calling
`timingSafeEqual`, and regex-validates the expiry before `Number()` so garbage
can't come back as `NaN`.

</details>

<details>
<summary><b>CSRF: two independent defences</b></summary>

`SameSite=Lax` is the primary one — a cross-site POST carries no cookie at all.
It isn't the only one: the router also requires a JSON content-type on
mutations, which covers **same-site-different-port**, a case `SameSite` does not
distinguish.

</details>

<details>
<summary><b>Why <code>Secure</code> is conditional</b></summary>

A `Secure` cookie is silently dropped over plain HTTP, which would make login
fail with no visible error on every LAN install without TLS. So it's set only
when the request is actually HTTPS.

That check trusts `x-forwarded-proto`, which is spoofable with no proxy in
front — but the worst a spoofer achieves is making *their own* cookie `Secure`.
A self-inflicted denial, not an escalation.

</details>

<details>
<summary><b>Login throttling</b></summary>

A single password on a public URL is exactly the shape brute force likes, and
there is no rate limiting anywhere else in this server. So login gets a sliding
window over failures per client IP, in memory, capped at 5000 tracked keys.

A restart forgives everyone — the right trade for a single-user app.

</details>

### The routes in front of the gate

`GET /api/health` and `GET /up` both return `{ ok: true }` and nothing else.
They are the same probe under two paths — `/up` is the one
[ONCE](https://github.com/basecamp/once) requires. A container healthcheck
carries no credentials, and a 401 there would have every orchestrator mark the
container unhealthy and restart-loop it forever. Both deliberately reveal
nothing about the install — `/api/status`, which reports model config and note
counts, stays behind the gate.

`POST /api/checkpoint` stays **behind** the gate despite also existing for
backup tooling. ONCE's `pre-backup` hook runs inside the container, so it reads
`STASH_PASSWORD` from its own environment and logs in like any other client;
exempting the endpoint to save it that step would hand an unauthenticated
stranger a repeatable write and disk flush.

## The SSRF guard

Every URL Kothai fetches from the open internet is **attacker-influenced**:
`og:image` and `twitter:image` come from the page being previewed, oEmbed
endpoints from its provider, Instagram slide URLs from a scraped JSON blob.
Anyone who can get a link saved chooses them.

Unguarded, that turns the server into a request proxy for whatever network it
sits on — `http://169.254.169.254/latest/meta-data/` reads cloud instance
credentials, `http://10.0.0.5:6379/` probes an internal service, and on shared
hosting the blast radius is the provider's network rather than one user's box.

[`server/lib/ssrf.js`](../server/lib/ssrf.js) takes the position that a scheme
check gives you nothing. Two things have to be true, so it checks both:

1. **The address actually connected to must be public.** It resolves the
   hostname and checks the *answers*, not the string.
2. **That must stay true across every redirect.** It follows redirects by hand,
   max 5 hops, re-checking each one.

Blocked v4 ranges, and why each is there:

| Range | |
|---|---|
| `0.0.0.0/8` | `0.0.0.0` routes to loopback on Linux |
| `10/8`, `172.16/12`, `192.168/16` | RFC1918 |
| `100.64/10` | CGNAT — **and Tailscale's range**. A link preview reaching into the tailnet is exactly the thing to prevent. |
| `127/8` | loopback |
| `169.254/16` | link-local + cloud instance metadata |
| `192.0.0/24` | IETF protocol assignments |
| `198.18/15` | benchmarking |
| `224/4` | multicast |
| `240/4` | reserved, incl. broadcast |

IPv6 is parsed to its 16 bytes rather than prefix-matched on the string, because
the same address has many legal spellings — including `::ffff:127.0.0.1`, which
writes its last 32 bits in dotted form.

Ports are restricted to **80 and 443**. A link preview only ever needs HTTP, and
restricting the port keeps an attacker-supplied URL from reaching an admin
panel, a database or an SSH banner on an otherwise legitimately public host.

### The escape hatch

`STASH_ALLOW_PRIVATE_FETCH=1` disables the address check, for previewing
intranet links on a network you trust. The accepted spellings are deliberately
narrow (`1` / `true`) so a typo **fails closed** — anything that silently
disables an SSRF guard is worse than no guard at all.

## Secrets handling

`STASH_PASSWORD`, `STASH_AI_BASE_URL` and `STASH_AI_API_KEY` are **env-only**.
None is written to SQLite, so none can leak through a backup or a JSON export.

`GET /api/settings` echoes only the endpoint's **hostname** — never the full URL
and never the key — because some providers carry credentials in the URL path,
so the whole string is treated as secret. Model *names* are the user's choice
and do live in the settings table.

## Untrusted uploads

Data-export imports arrive as ZIPs read by a hand-rolled parser
([`server/lib/zip.js`](../server/lib/zip.js)). Guards:

- request bodies capped — 25 MB by default, 64 MB for the import route — and
  at 20 files per import, so a request can't carry thousands of tiny uploads
  that each cost a base64 decode and a ZIP scan before the size limit notices;
- `findImporter` wraps each importer's `sniff()` in a try/catch, so one
  importer throwing on an unexpected shape can't break detection for the rest;
- `parse()` is per-file try/catch for the same reason;
- imports serialize against each other, so two can't dedup against stale
  snapshots and double-import.

Destructive endpoints need an exact confirmation token (`POST /api/wipe`), and
refuse while an import is mid-flight.

## What is deliberately not protected

Be clear-eyed about these:

- **No multi-user separation.** One password, one archive. `STASH_PASSWORD`
  exists to make a public URL safe to expose, not to model identity.
- **No rate limiting outside login.** Every other endpoint is unthrottled.
- **No CSP, no subresource integrity.** The client is first-party and bundled.
- **No encryption at rest.** `data/kothai.db` is a plain SQLite file. Anyone
  with filesystem access — or your backup tarball — has everything.
- **No audit log.**
- **Uploads are served back as files.** They're yours, but a shared install
  would be serving one user's images to another.
- **Model output is not sanitised for rendering** beyond markdown handling.
  It's summarising content you saved, which is content someone else wrote.

## Deployment guidance

| Where it runs | What to do |
|---|---|
| **Localhost** | Nothing. |
| **Your LAN** | Nothing, if you trust the LAN. |
| **Tailscale / WireGuard** | **The recommended way to get remote access.** Nothing is published to the public internet, so the single-user model holds. |
| **Public hostname** | Set `STASH_PASSWORD`, put TLS in front (Caddy is two lines), and consider a second auth layer — Authelia, Cloudflare Access, Caddy's `basic_auth`. |

> [!CAUTION]
> Kothai speaks plain HTTP. Without `STASH_PASSWORD` set, anyone who can reach
> the port can read, write and delete everything, and can use your server as a
> fetch proxy for any public URL. Never expose it directly to the internet
> unauthenticated.

Config, reverse-proxy snippets and backup procedure are in
[self-hosting.md](self-hosting.md).
