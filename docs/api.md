# HTTP API

Everything is JSON over one port. There's no versioning prefix — Kothai is
single-user and the client ships with the server, so the API and its only
consumer move together.

All routes are registered in [`server/router.js`](../server/router.js), which is
short enough to read as the authoritative index.

- [A worked example](#a-worked-example)
- [Auth](#auth)
- [Notes](#notes)
- [Ask](#ask)
- [Chats](#chats)
- [Spaces (collections)](#spaces-collections)
- [Settings & status](#settings--status)
- [Enrichment](#enrichment)
- [Import / export / backup / wipe](#import--export--backup--wipe)
- [Error codes](#error-codes)

## A worked example

Save something. This returns straight away, before any model runs:

```bash
curl -s localhost:5173/api/save \
  -H 'content-type: application/json' \
  -d '{"text":"https://arxiv.org/abs/2310.11511 self-RAG, worth reading"}'
```

```jsonc
{ "note": { "id": "a3f…", "type": "link", "title": "arxiv.org", "pending": true },
  "aiClassified": false }
```

Give it a moment and that same note has a real title, tags and an embedding.
Now ask about it:

```bash
curl -s localhost:5173/api/ask \
  -H 'content-type: application/json' \
  -d '{"question":"what was that retrieval paper I saved?"}'
```

```
Self-RAG, a framework where the model learns to retrieve on demand and
critique its own output using reflection tokens. [1]

  [1] arxiv.org/abs/2310.11511 · saved 4 minutes ago
```

Add `-H 'accept: text/event-stream'` if you'd rather stream the answer.

## Auth

Only active when `STASH_PASSWORD` is set. Unset, there's no gate at all and
everything below is open to anyone who can reach the port.

| | |
|---|---|
| `POST /api/login` | `{ password }` → sets a signed session cookie |
| `POST /api/logout` | clears it |
| `GET /api/health` | `{ ok: true }` — **in front of the gate** |
| `GET /up` | `{ ok: true }` — the same probe, at the path ONCE requires |

These two are deliberately outside the gate and deliberately say nothing about
the install: a container healthcheck carries no credentials, and a 401 would
have every orchestrator mark the container unhealthy and restart-loop it
forever. Anything that reveals state — `/api/status` included — stays behind it.

`/up` is routed explicitly rather than left to the SPA fallback. That fallback
does answer 200 for any unmatched path, but with an HTML login page rather than
a health signal, and it stops answering at all if `dist/` is missing.

Session tokens are `<expiry>.<hmac>`, signed with a key derived from the
password via HKDF. See [security.md](security.md#the-password-gate).

## Notes

### `POST /api/save`

```jsonc
// request — at least one of the two
{ "text": "https://example.com/article", "image": "data:image/png;base64,…" }

// response — returns immediately, before any model runs
{ "note": { "id": "…", "type": "link", "title": "…", "pending": true }, "aiClassified": false }
```

`400` if neither `text` nor `image` is supplied. Enrichment is queued in the
background — poll the delta endpoint for the enriched version.

### `GET /api/notes`

| Param | Default | |
|---|---|---|
| `q` | — | substring over content, titles, descriptions, tags, host |
| `type` | — | `link` · `image` · `video` · `code` · `note` |
| `source` | — | `github` · `reels` · `igposts` · `x` · `tiktok` · `reddit` · `web` |
| `collection` | — | Space id |
| `offset` | `0` | |
| `limit` | `120` | |

```jsonc
{
  "notes": [ … ],
  "total": 1686,
  "offset": 0,
  "facets": { … },      // counts ignore the active type/source chip
  "pendingTotal": 3,    // notes still awaiting enrichment
  "rev": 4210,          // change counter, for the delta endpoint
  "bootId": "…"         // regenerated every restart
}
```

### `GET /api/notes/delta?since=<rev>&boot=<bootId>`

```jsonc
{ "rev": 4213, "bootId": "…", "pendingTotal": 1,
  "notes": [ … ],        // changed since `since`
  "deleted": ["id", …] }

// or, when a delta can't be guaranteed:
{ "resync": true, "rev": 4213, "bootId": "…", "pendingTotal": 1 }
```

`resync` means the `bootId` didn't match (server restarted) or `since` predates
the tombstone window — refetch instead of applying a partial answer.

### The rest

| | |
|---|---|
| `GET /api/notes/:id` | `{ note }` · `404` |
| `PATCH /api/notes/:id` | `{ tags?, title?, mindNote? }` → `{ note }`. Tags normalised, max 40; `mindNote` clamped to 4000 chars. `400` if nothing updatable was sent. |
| `DELETE /api/notes/:id` | `{ ok }` |
| `POST /api/notes/:id/retag` | re-runs classification for one note |
| `POST /api/notes/:id/slides` | fetches Instagram carousel slides |

## Ask

### `POST /api/ask`

```jsonc
{ "question": "the pasta recipe with burnt butter",
  "image": "data:image/png;base64,…",   // optional
  "chatId": "…" }                        // optional — continues a conversation
```

Send `Accept: text/event-stream` for a streamed answer (SSE with
`X-Accel-Buffering: no`, so a reverse proxy won't buffer it). Otherwise you get
one JSON response.

The stream only opens once the request has cleared every gate — before that a
plain JSON error is still the right answer, and the headers haven't been
written yet.

| | |
|---|---|
| `400` | neither question nor image |
| `409` `llm_off` | Ask needs the language model |
| `409` `vision_off` | image questions need the vision model |

Retrieval is hybrid (cosine + keyword, fused by reciprocal rank) and the answer
cites its sources by number. Below the similarity floor it says it found
nothing rather than inventing.

## Chats

| | |
|---|---|
| `GET /api/chats?offset=&limit=` | paged list |
| `GET /api/chats/:id` | `{ chat }` · `404` |
| `PATCH /api/chats/:id` | `{ title }` → `{ chat: { id, title, updatedAt } }` |
| `DELETE /api/chats/:id` | `{ ok }` |

Chats float to the front on every touch, not just on creation.

## Spaces (collections)

| | |
|---|---|
| `GET /api/collections` | `{ collections }` |
| `POST /api/collections` | `{ name, tags? }` → `{ collection }`. Name max 120, tags max 40. |
| `PATCH /api/collections/:id` | `{ name?, tags?, canvas? }`. `canvas` is the space's board (JSON Canvas-style `{ nodes, edges }`; `null` clears it); malformed docs are `400`, oversized ones (over 2000 nodes or edges) too. |
| `DELETE /api/collections/:id` | `{ ok }` |
| `POST /api/collections/:id/items` | `{ itemId }` → `{ collection }` · `404` if the note doesn't exist |
| `DELETE /api/collections/:id/items/:itemId` | `{ collection }` |

A Space with `tags` auto-files anything matching the rule.

## Settings & status

### `GET /api/status`

```jsonc
{ "…": "per-role load state and progress",
  "configured": true,      // false = show the first-run model picker
  "count": 1686,
  "capabilities": { "kind": "local", "downloadsWeights": true, "managesResidency": true } }
```

The healthcheck is `/api/health`; this one reports **model readiness** and is
behind the auth gate.

### `GET /api/settings`

```jsonc
{ "current":  { "llm": "…", "embed": "…", "vision": "…" },
  "remote":   { "llm": "…", "embed": "…", "vision": "…" },   // model names only
  "residency":{ "llm": "ondemand", "embed": "always", "vision": "ondemand" },
  "presets":  { … },
  "capabilities": { … },
  "endpoint": { "configured": true, "host": "ollama" } }     // hostname only, never the URL or key
```

### `POST /api/settings`

Model selection and/or `{ residency: { llm, embed, vision } }`. `400` on an
invalid value or if nothing would change.

### `POST /api/setup`

First-run only. `{ skip: true }` for AI-free mode, otherwise the model
selection — which commits it and kicks off the download. `409` if already
configured, or if the provider has no weights to download.

## Enrichment

| | |
|---|---|
| `GET /api/enrich/backlog` | `{ count }` — notes with steps still owed under the current residency |
| `POST /api/enrich/backlog` | `{ ok, queued }` — work the backlog |
| `POST /api/enrich/prioritize` | `{ ids: [] }` (max 200) — jump the queue |
| `POST /api/enrich/retag-all` | re-classify everything · `409` `llm_off` |

`503` `provider_unavailable` when a remote endpoint is down or its circuit is
open.

## Import / export / backup / wipe

### `POST /api/import`

Multi-file upload, each tagged with its source. `server/import/index.js` selects
the importer by name, so an unrecognised file gets *"that isn't an Instagram
export"* rather than a generic dead end. Max 20 uploads per request.

Imports serialize against each other — `409` `import_in_progress` — because two
overlapping imports would each dedup against a stale snapshot and double-import
the same post.

### `GET /api/export`

One JSON file: notes, Spaces, chats and model settings. Embeddings and the tag
registry are left out — both are derived and regenerate on restore, and
including them would multiply the file size for no recoverable information.

### `GET /api/backup`

A hot database snapshot via SQLite's `VACUUM INTO` — one consistent read
including WAL, written as a fresh compacted file. No downtime.

> [!WARNING]
> This is **the database only**. `data/uploads/` is not in it. Thumbnails
> regenerate from source URLs, but images you pasted or dropped exist nowhere
> else — back that directory up separately.

Needs free disk equal to the database size, and refuses while an import or
another backup is running.

### `POST /api/checkpoint`

```jsonc
→ { "ok": true }
```

The sibling of `/api/backup`, for the other kind of backup tool: the ones that
archive the data directory from **outside** the process and cannot ask the app
to settle first. `docker/hooks/pre-backup` calls this for ONCE; a cron job
running `restic` or `borg` against `data/` wants it too.

It flushes writes still queued in memory by the enrichment sweeps, then runs
`PRAGMA wal_checkpoint(TRUNCATE)`. Afterwards `kothai.db` **on its own** is the
complete database, so a snapshot that catches the three WAL files at slightly
different moments still restores correctly.

Unlike `/api/backup` it writes no second copy, so it needs no spare disk. It
returns `409` `import_in_progress` for the same reason a wipe does: flushing
mid-import would commit half a batch and put those rows beyond the import's own
rollback.

### `POST /api/wipe`

```jsonc
{ "confirm": "<exact token>" }
→ { "cleared": { "notes": 1686, "collections": 12, "chats": 40, "tags": 2663 } }
```

`400` `confirm_required` without the exact token. `409` `import_in_progress`
while an import is mid-flight — an import holds unflushed notes in memory, so a
wipe landing between its insert loop and its flush would be undone by that
flush. Model settings survive a wipe; the install stays configured.

## Error codes

Errors the client must *act* on carry a stable `code` alongside the human
message, so the UI can render a real state instead of parsing prose.

| Code | Status | |
|---|---|---|
| `auth_required` | 401 | no valid session, and `STASH_PASSWORD` is set |
| `bad_password` | 401 | wrong password at login |
| `rate_limited` | 429 | login throttle tripped; carries `Retry-After` |
| `content_type_required` | 415 | mutations must be `application/json` (part of the CSRF defence) |
| `llm_off` | 409 | language model disabled in Settings |
| `vision_off` | 409 | vision model disabled |
| `circuit_open` | — | remote endpoint's circuit breaker is open |
| `provider_unavailable` | 503 | remote endpoint unreachable |
| `import_in_progress` | 409 | another import is running |
| `import_source_mismatch` | 400 | the upload doesn't match the source it was tagged with |
| `import_rolled_back` | 500 | saving imported notes failed; nothing was imported |
| `backup_in_progress` | 409 | a backup is already being prepared |
| `backup_failed` | 500 | snapshot couldn't be written |
| `confirm_required` | 400 | destructive action needs its exact token |

`FeatureDisabledError` defaults its code to `` `${role}_off` ``, so `embed_off`
is possible too — it just isn't raised by any route today. The remote provider
reuses the same class for config-fixable causes (bad key, unknown model) with an
overridden code, so routes and the client have one error shape to handle
whether a feature is off by policy or broken by configuration.

Anything unhandled becomes `500 { error }` and is logged server-side.
