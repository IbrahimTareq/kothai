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
  "serverVersion": "1.4.0",
  "signIn": ["password"],
  "cloud": false
}
```

`signIn` is `["password"]` when the server has `KOTHAI_PASSWORD` set, otherwise `["none"]`.

### Auth and errors

Every route below `info` needs a session (the cookie from `/api/login`); with no `KOTHAI_PASSWORD` set there is nothing to sign in to, and every route is open. The capture token, sent as `Authorization: Bearer <token>`, opens `POST /api/v1/save` and nothing else. A request without access gets `401`.

Every failure is `{ "error": "<message>", "code": "<code>" }` (`ApiError`). Branch on `code`, never on the message.

| Status | `code` | When |
|---|---|---|
| 400 | `bad_cursor` | `cursor` or `since` is not a cursor this server issued |
| 400 | `links_only` | `save` was given something that is not a link |
| 401 | `auth_required` | No session, and no capture token on `save` |
| 429 | `demo_limit` | A demo visitor used the day's saves |

### `GET /api/v1/notes`

Auth: session. Returns `NotesPage`: `{ notes: Note[], next: string | null }`, newest first. Pass `next` back as `cursor` for the following page; `next` is `null` on the last. Query: `cursor`, `limit` (default 100, max 200), `space` (a space id; only its notes). An unknown `space` answers an empty page. Notes the board hides as unavailable are left out.

### `GET /api/v1/spaces`

Auth: session. Returns `SpacesList`: `{ spaces: Space[] }`, each `{ id, name, parentId?, count, createdAt }`.

### `GET /api/v1/changes`

Auth: session. Returns `Changes`, the offline cache's sync feed. Call it with no `since` to get a first `cursor` with `resync: true`; refetch the library with `notes`. Call it with that cursor afterwards:

- `{ cursor, notes, deleted, spaces? }` carries the notes changed since, the ids deleted since, and the full space list only when it changed. Keep the new `cursor`.
- `{ resync: true, cursor }` means the cursor cannot be trusted (the server restarted, or the deletion history no longer reaches back that far). Discard the cache and refetch.

### `POST /api/v1/save`

Auth: session, or the capture token. Body `SaveRequest`: `{ url: string, note?: string }`. Returns `SaveResponse`: `{ note: Note }`, the saved note, which may still be `pending` while it is enriched.

### Client

`createClient` in `@kothai/api` wraps the five routes and throws `ApiRequestError` (`status`, `code`) on any non-2xx answer, or with `code: 'network'` when there is no usable body.

```ts
const api = createClient({ baseUrl: 'https://kothai.example.com', token, fetch })
```

`fetch` defaults to the global; the Expo app passes `expo/fetch`. `token` is sent as a bearer token, which today only `save` honours.
