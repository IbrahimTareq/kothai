# Working in this repo

These rules bind everyone — human and agent alike. They hold only what no
checker can verify; everything mechanizable lives in `pnpm test`. Detail lives
in `docs/`.

## Commands

| | |
|---|---|
| `pnpm dev` | Node `:5173` + Vite `:5174`. **Develop against 5174.** 5173 shows the production build. |
| `pnpm test` | The full gate. 1101 tests, ~68s. Run all of it; it is fast enough. |
| `pnpm build` | The same checks, plus the Vite build. |
| `pnpm format` | Apply formatting. Biome decides style; do not argue with it. |

Node 22 (`.nvmrc`). Running the suite on Node 24 once hid a `mock.module()`
misuse that only fails on 22 — switch first.

## Architecture invariants

- `server/router.js` is the only place routes are registered. A new route is a
  `handleX` export in `server/routes/`, wired there. Never register from inside
  a handler module.
- The auth gate sits above every route in `router.js`, so handlers never check
  auth themselves. Only `/api/health` and `/up` sit in front of it, and they
  must stay silent about the install — the container healthcheck carries no
  credentials, and a 401 there restart-loops the container forever.
- `server/lib/` is the security floor (`auth.js`, `ssrf.js`, `http.js`). A
  change there needs a test that fails without it.

## Change discipline

AI-assisted changes fail in one direction: more surface area, presented as
thoroughness. These rules push back.

- Build the smallest thing that satisfies the request. No options, flags, or
  extension points nobody asked for.
- No abstraction with one caller. Wait for the third case.
- No defensive branches for states that cannot occur.
- Prefer deleting to adding. Total exports should trend down, not up.
- Fix the cause, never the symptom. Never widen a type, swallow an error, or
  add a retry to stop a failure being visible.
- No new dependencies without asking. Everything here ships in the Docker image.

## Comments

The comments in this codebase carry incident history. That is the most valuable
thing in it and the easiest thing to erode.

- Explain **why**, never what. A comment restating the code is deleted on sight.
- Every non-obvious guard, ordering constraint or workaround **names the failure
  that caused it**. See the header of `server/router.js`.
- Never delete an explanatory comment while editing around it. Update it if it
  has gone stale.

## Verification and etiquette

- Never claim something works without showing the command and its output.
  "Should work" is not a result.
- A behaviour change needs a test that fails before it and passes after.
- Commit straight to `main`. No feature branches — parallel sessions share this
  checkout and branching steals their commits.
- Never commit or push unless asked.

## Amending this file

A rule may be added only after a real violation, and must cite it. A rule is
deleted the moment a checker enforces it — prose duplicating a check is dead
weight that dilutes the rules still doing work. **This file is meant to
shrink.** Use `/amend`.
