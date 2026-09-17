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

## GET /api/health

Unauthenticated health check. Returns `{ ok: true }`.
