# HTTP API

Kothai exposes a JSON API on the same port as the UI. All endpoints live in `server/router.ts`.

## Base URL

```
http://localhost:5173/api
```

## Authentication

When `STASH_PASSWORD` is set, most endpoints require a session cookie obtained via `POST /api/login`. The exceptions are `/api/health` and `/api/login` itself.

## Errors

Errors return a JSON body with a `code` field:

```json
{ "code": "not_found" }
```

Common codes: `unauthorized`, `not_found`, `invalid_input`, `llm_off`, `import_in_progress`.

## Content types

Requests and responses use `application/json` unless noted otherwise. File uploads use `multipart/form-data`.

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
