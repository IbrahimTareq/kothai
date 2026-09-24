---
name: add-route
description: Add an HTTP route to the server. Use when adding an API endpoint, a new handler, or extending server/routes/.
---

# Add a route

Three things happen: write the handler, write a test that fails against the
unregistered route, then register it and watch that same test pass.

## 1. The handler

Add a named `handleX` export to `server/routes/<area>.ts` (create the file if
the area is new). The handler takes only what it needs, in this order:

- `req: IncomingMessage` — only if it reads a JSON body (then it is `async`)
- `res: ServerResponse` — always
- `url: URL`, `url.searchParams`, or a path param the router already extracted
- `viewer: string | null` — only if it reads or writes a visitor's own links
  or chats (see step 3)

Real examples: `handleNotes(res, url, viewer)` and
`handleGetNote(res, id, viewer)` in `server/routes/notes.ts`;
`handleSaveSettings(req, res)` in `server/routes/settings.ts`.

Reply with `json(res, code, obj)` from `server/lib/http.ts` — never call
`res.end` or `res.writeHead` directly from a handler. Other helpers there:
`readBody(req)` to parse a JSON body, `downloadJson(res, filename, obj)` for a
file-download response, `saveImage(dataUrl)` for pasted images.

## 2. Registration

`server/router.ts`'s `handleRequest` is the **only** place routes register.
Never register a route from inside a handler module — there is no route
table anywhere else to keep in sync.

Two edits:

- Add the import to the group at the top of `router.ts`, alongside the other
  imports from the same `server/routes/<area>.ts` file.
- Add one explicit `method + path` line inside `handleRequest`, matching the
  style already there:

```js
if (req.method === 'GET' && p === '/api/status') return handleStatus(res)
if (req.method === 'POST' && p === '/api/settings') return await handleSaveSettings(req, res)
```

A path segment (like a note id) is read off `p` with `p.split('/').pop()` or
a regex like `/^\/api\/notes\/[^/]+$/`, matching the neighboring routes for
the same resource — copy the nearest one rather than inventing a new style.

## 3. Auth and the demo

Auth: nothing to do. The gate sits above every route in `router.ts`
(`if (PASSWORD && (await authGate(...))) return`, before any route line), so
handlers never check auth themselves. If you find yourself writing an auth
check inside a handler, the gate was misread — remove it and register the
route normally.

The only route in front of the gate is `GET /api/health`, and it must stay
silent about the install (no note counts, no config, just `{ ok: true }`). It
exists there deliberately: the container healthcheck carries no credentials,
and if it sat behind the gate a healthcheck would get 401'd and the
orchestrator would restart-loop the container forever.
Do not add a second route in front of the gate without the same justification.

The demo gate sits just below auth and answers 403 to every `/api/` route not
in `ALLOWED` in `server/routes/demo.ts`. A new route is therefore off on the
demo by default — add it to `ALLOWED` only if a visitor should reach it, and
if it does, take `viewer` so each visitor sees only their own data.

## 4. The test

Add `test/server/routes/<area>-route.test.ts` (or extend the existing file
for that area) — `notes-route.test.ts` for `server/routes/notes.ts`,
`settings-route-remote.test.ts` for a remote-provider slice of
`server/routes/settings.ts`. Import the handler directly and call it with
`mockReq` / `mockRes` from `test/helpers/http.ts` — never a hand-rolled object
(that file's header says why):

```ts
const { res, sent } = mockRes()
handleNotes(res, new URL('http://x/api/notes?limit=3'), null)
assert.equal(sent.json().total, 3)
```

Write the test first and run it against the unregistered route — it should
fail (import error or wrong status) before you wire step 2, and pass after.
That gap is what proves the route is actually reachable, not just that the
handler function works in isolation.

## 5. Finish

```
pnpm test
```

## Worked examples

- `server/routes/notes.ts` + `test/server/routes/notes-route.test.ts` — sync
  handlers, URL search params, path-param extraction, `viewer`.
- `server/routes/settings.ts` + `test/server/routes/settings-route-remote.test.ts`
  — async handlers, `readBody`, multi-step validation before replying.
