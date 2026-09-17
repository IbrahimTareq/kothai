# Security

Kothai is a **single-user, local-first** app, built on the assumption that everyone who can reach the port is you.

## The password gate

Set `KOTHAI_PASSWORD` and the app requires login. Unset, there's no auth at all.

Sessions are 30-day tokens signed with a key derived from the password. Changing the password invalidates all sessions. Login is rate-limited.

## The SSRF guard

Every URL Kothai fetches for a link preview is attacker-influenced. The SSRF guard resolves the hostname and blocks private/loopback ranges.

`KOTHAI_ALLOW_PRIVATE_FETCH=1` disables the check for previewing intranet links on a trusted network.

## Secrets handling

`KOTHAI_PASSWORD` is env-only and never written to SQLite, so it can't leak via backup.

The inference endpoint and key go to `data/credentials.json`, never into the database.

## Deployment guidance

| Where it runs | What to do |
|---|---|
| **Localhost / LAN** | Nothing. |
| **Tailscale** | Recommended. Nothing exposed publicly. |
| **Public hostname** | Set `KOTHAI_PASSWORD` and put TLS in front. |

> [!CAUTION]
> Without `KOTHAI_PASSWORD` set, anyone who can reach the port can read, write, and delete everything.
