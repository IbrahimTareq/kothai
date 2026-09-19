---
name: add-route
description: Add an HTTP route to the server. Use when adding an API endpoint, a new handler, or extending server/routes/.
---

# Add a route

Three things happen: write the handler, write a test that fails against the
unregistered route, then register it and watch that same test pass.

## 1. The handler

Add a named `handleX` export to `server/routes/<area>.ts` (create the file if
the area is new). Signature convention, by what the handler needs:

- Sync, no body needed: `export function handleX(res) { ... }`
- Sync, reads the URL: `export function handleX(res, url) { ... }` (or
  `url.searchParams`, or a path param the router already extracted)
- Async, reads a JSON body: `export async function handleX(req, res) { ... }`

Real examples: `handleNotes(res, url)` and `handleGetNote(res, id)` in
`server/routes/notes.ts`; `handleSaveSettings(req, res)` in
`server/routes/settings.ts`.

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

## 3. Auth

Nothing to do. The gate sits above every route in `router.ts`
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

## 4. The test

Add `test/server/routes/<area>.test.js` (or extend the existing file for that
area) mirroring the source layout — `notes-route.test.js` for
`server/routes/notes.ts`, `settings-route-remote.test.js` for a
remote-provider slice of `server/routes/settings.ts`. Import the handler
directly and call it with a mock `res`:

```js
function mockRes() {
  const r = { code: 0, body: null }
  r.writeHead = c => { r.code = c; return r }
  r.end = s => { r.body = JSON.parse(s) }
  r.setHeader = () => {}
  return r
}
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

- `server/routes/notes.ts` + `test/server/routes/notes-route.test.js` — sync
  handlers, URL search params, path-param extraction.
- `server/routes/settings.ts` + `test/server/routes/settings-route-remote.test.js`
  — async handlers, `readBody`, multi-step validation before replying.
