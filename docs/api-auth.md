# Auth

Only active when `KOTHAI_PASSWORD` is set.

## POST /api/login

<TypeTable
  type={{
    password: {
      description: 'The password set via KOTHAI_PASSWORD',
      type: 'string',
      required: true,
    },
  }}
/>

Sets a session cookie on success.

## POST /api/logout

Clears the session cookie. No body required.

## Capture token

A token for saving links without a session, from a script or an iOS Shortcut. Create it in **Settings → Capture token**. It is shown once; Kothai keeps only its hash.

The token works for `POST /api/save` and nothing else. It cannot read, export, change or delete anything, and it cannot create or revoke tokens. Regenerating it revokes the old one.

```bash
curl -X POST https://kothai.example.com/api/save \
  -H "Authorization: Bearer $KOTHAI_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"https://example.com/article"}'
```

The `Content-Type: application/json` header is required, the same as for every request that changes data (a restore's `application/octet-stream` is the one other type accepted).

### GET /api/capture-token

Returns `{ exists, gated }`. `gated` is whether `KOTHAI_PASSWORD` is set; without it, `/api/save` needs no token at all. Never returns the token.

### POST /api/capture-token

Creates a token, replacing any existing one. Returns `{ exists, gated, token }` — the only response that ever carries it.

### DELETE /api/capture-token

Revokes the token. Returns `{ exists, gated }`.

## GET /api/health

Unauthenticated health check. Returns `{ ok: true }`.
