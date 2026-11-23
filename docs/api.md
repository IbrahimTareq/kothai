# HTTP API

Kothai exposes a JSON API on the same port as the UI. All endpoints live in `server/router.ts`.

## Base URL

```
http://localhost:5173/api
```

## Authentication

When `KOTHAI_PASSWORD` is set, most endpoints require a session cookie obtained via `POST /api/login`. The exceptions are `/api/health` and `/api/login` itself.

## Errors

Errors return a JSON body with a `code` field:

```json
{ "code": "not_found" }
```

Common codes: `unauthorized`, `not_found`, `invalid_input`, `llm_off`, `import_in_progress`.

## Content types

Requests and responses use `application/json` unless noted otherwise. The one exception is `POST /api/restore`, which takes the backup file itself as `application/octet-stream`.

## Endpoints

<Cards>
  <Card title="Auth" href="/docs/reference/api/api-auth">
    Login, logout, health checks
  </Card>
  <Card title="Notes" href="/docs/reference/api/api-notes">
    Save, list, update, delete notes
  </Card>
  <Card title="Ask" href="/docs/reference/api/api-ask">
    Question answering with retrieval
  </Card>
  <Card title="Chats" href="/docs/reference/api/api-chats">
    Conversation history
  </Card>
  <Card title="Spaces" href="/docs/reference/api/api-spaces">
    Collections and canvas
  </Card>
  <Card title="Settings" href="/docs/reference/api/api-settings">
    Model selection and status
  </Card>
  <Card title="Backup" href="/docs/reference/api/api-backup">
    Export, backup, wipe
  </Card>
  <Card title="Import" href="/docs/reference/api/api-import">
    Data imports
  </Card>
</Cards>

## v1

The versioned contract for the mobile app, under `/api/v1`. The shared types live in `packages/api`.

### `GET /api/v1/info`

Needs no session, so an app can learn how to sign in before it does. It carries no counts or library data.

```json
{
  "apiVersion": 1,
  "minClientVersion": 1,
  "signIn": ["password"],
  "cloud": false
}
```

`signIn` is `["password"]` when the server has `KOTHAI_PASSWORD` set, otherwise `["none"]`. There is no build version: the route answers strangers, and the install's exact version is not theirs to learn.

Checking compatibility:

- Compare `minClientVersion` with the `API_VERSION` the client was built against. Below `minClientVersion`: tell the user to update the app.
- If the server's `apiVersion` is below what the client needs: tell the user to update their server.
- A server from before v1 has no `/api/v1/info`. With a password set it answers `401`; with none it answers `200` with HTML, which the typed client reports as code `network`. Treat both as "update your server".
- Ignore unknown fields, and unknown values of `signIn`, `Note.type` and error `code`: later versions add them without bumping `apiVersion`.

### Auth and errors

Every route below `info` needs a session (the cookie from `/api/login`); with no `KOTHAI_PASSWORD` set there is nothing to sign in to, and every route is open. When a password is set, the capture token, sent as `Authorization: Bearer <token>`, opens `POST /api/v1/save` and nothing else. A request without access gets `401`.

Known gap: native clients have no bearer session yet. Until device sessions land (cloud spec, point 3), a native app reads only from a server with no `KOTHAI_PASSWORD`, and uses the capture token for `save`.

Every failure is `{ "error": "<message>", "code": "<code>" }` (`ApiError`). Branch on `code`, never on the message.

| Status | `code` | When |
|---|---|---|
| 400 | `bad_cursor` | `cursor` or `since` is not a cursor this server issued |
| 400 | `links_only` | `save` was given something that is not a link |
| 400 | `bad_json` | `save` was given a body that is not valid JSON |
| 401 | `auth_required` | No session, and no capture token on `save` |
| 403 | `demo` | A demo install: every `/api/v1` route except `info` is refused, `save` included |
| 404 | `not_found` | A path under `/api/v1` this server has no route for (any method), or a `space` that does not exist or is not yours to see |
| 415 | `content_type_required` | Any mutation (`POST`, `PUT`, `PATCH`, `DELETE`) whose type is not `application/json` or `application/octet-stream` (checked before the session, so it can precede a `401`) |
| 429 | `demo_limit` | A demo visitor used the day's saves |
| 500 | `internal` | Anything the server did not expect |

A body over 25 MB gets no status at all: the server destroys the connection before it can answer, so a client sees a dropped connection, not a `413`. `createClient` reports a dropped connection, or any error body without a `code`, as `code: 'network'`.

### `GET /api/v1/notes`

Auth: session. Returns `NotesPage`: `{ notes: Note[], next: string | null }`, newest first. Pass `next` back as `cursor` for the following page; `next` is `null` on the last. Query: `cursor`, `limit` (default 100, max 200), `space` (a space id; only its notes). An unknown `space`, or one you cannot see, answers `404 not_found`. Notes the board hides as unavailable are left out.

### `GET /api/v1/spaces`

Auth: session. Returns `SpacesList`: `{ spaces: Space[] }`, each `{ id, name, parentId?, count, createdAt }`.

### `GET /api/v1/changes`

Auth: session. Returns `Changes`, the offline cache's sync feed. Build a consistent snapshot in this order:

1. Call `changes` with no `since` first and keep its `cursor`. Then page `notes` and fetch `spaces`. Anything that changes meanwhile arrives on the next `changes` call, possibly twice, so apply changes by id.
2. Call `changes` with the kept cursor afterwards:

- `{ cursor, notes, deleted, spaces? }` carries the notes changed since, the ids deleted since, and the full space list only when it changed. Keep the new `cursor`.
- `{ resync: true, cursor }` means the cursor cannot be trusted (the server restarted, or the deletion history no longer reaches back that far). Keep the cursor that came with it, refetch notes and spaces, and replace the cache only once the refetch is done, so the app stays usable offline meanwhile.

`changes` includes notes with `unavailable: true`, while `notes` pages leave them out. Hide them the same way.

### `POST /api/v1/save`

Auth: session, or the capture token. Body `SaveRequest`: `{ url: string, note?: string }`. Returns `SaveResponse`: `{ note: Note }`, the saved note, which may still be `pending` while it is enriched.

`save` is not idempotent: a retry after a timeout creates a second note (duplicates show in Settings → Duplicates). A client id for idempotency would be a later additive field.

### Client

`createClient` in `@kothai/api` wraps the five routes and throws `ApiRequestError` (`status`, `code`) on any non-2xx answer, or with `code: 'network'` when there is no usable body.

```ts
const api = createClient({ baseUrl: 'https://kothai.example.com', token, fetch })
```

`fetch` defaults to the global; the Expo app passes `expo/fetch`. `token` is sent as a bearer token, which today only `save` honours.
