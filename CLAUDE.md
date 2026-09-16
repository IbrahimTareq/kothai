# Working in this repo

@.claude/clean-code-rules.md

These rules bind everyone — human and agent alike. They hold only what no
checker can verify; everything mechanizable lives in `pnpm test`. Code rules
live in `.claude/clean-code-rules.md`, imported above so every session loads
them. Detail lives in `docs/`.

## Commands

| | |
|---|---|
| `pnpm dev` | Node `:5173` + Vite `:5174`. **Develop against 5174.** 5173 shows the production build. |
| `pnpm test` | Lint, token check, shape ratchet, then 1114 tests. ~5s. Run all of it; it is fast enough. |
| `pnpm build` | Lint, token check, both typechecks, then the Vite build. Not a superset of `test`, nor the reverse — it has no shape ratchet or test suite; `test` has neither typecheck. |
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

## Etiquette

- Commit straight to `main`. No feature branches — parallel sessions share this
  checkout and branching steals their commits.
- Never commit or push unless asked.

## Amending this file

A rule may be added only after a real violation, and must cite it. A rule is
deleted the moment a checker enforces it — prose duplicating a check is dead
weight that dilutes the rules still doing work. **This file is meant to
shrink.** Use `/amend`.
