# Auth

Only active when `STASH_PASSWORD` is set.

## POST /api/login

<TypeTable
  type={{
    password: {
      description: 'The password set via STASH_PASSWORD',
      type: 'string',
      required: true,
    },
  }}
/>

Sets a session cookie on success.

## POST /api/logout

Clears the session cookie. No body required.

## GET /api/health

Unauthenticated health check. Returns `{ ok: true }`.
