# Working in this repo

These rules, and how code is written in `.claude/rules/clean-code.md`, bind
everyone — human and agent alike. They hold only what no checker can verify;
everything mechanizable lives in `pnpm test`. See `docs/`.

## Commands

| | |
|---|---|
| `pnpm dev` | Node `:5173` + Vite `:5174`. **Develop against 5174.** 5173 shows the production build. |
| `pnpm dev:site` | Docs site alone on `:5175` (Next + Fumadocs). Installs `site/` first — it is a separate package and root `pnpm install` skips it. |
| `pnpm test` | Lint, token check, shape ratchet, then the test suite. ~5s. Run all of it; it is fast enough. |
| `pnpm build` | Lint, token check, both typechecks, then the Vite build. Not a superset of `test`, nor the reverse — it has no shape ratchet or test suite; `test` has no typecheck. |
| `pnpm format` | Apply formatting. Biome decides style; do not argue with it. |

Node 22 (`.nvmrc`). Running the suite on Node 24 once hid a `mock.module()`
misuse that only fails on 22 — switch first.

## Architecture invariants

- `server/router.ts` is the only place routes are registered. A new route is a
  `handleX` export in `server/routes/`, wired there. Never register from inside
  a handler module.
- The auth gate sits above every route in `router.ts`, so handlers never check
  auth themselves. Only `/api/health` sits in front of it, and it must stay
  silent about the install — the container healthcheck carries no credentials,
  and a 401 there restart-loops the container forever.
- `server/lib/` is the security floor: auth, SSRF, and every guard untrusted
  input passes through (zip caps, canvas limits, model-cache paths). A change
  there needs a test that fails without it; code that guards nothing lives
  elsewhere.
- `client/ui/` is the component layer (`docs/design-system.md`). A menu,
  popover, tooltip or page header comes from there, never from a view's own
  `div`s — three pickers, three tips and four headers were hand-built that way
  (b54dd71, 4b0109e, 5c4b91a). `lint:tokens` holds buttons and fields itself.

## Etiquette

- Commit straight to `main`. No feature branches — parallel sessions share this
  checkout and branching steals their commits.
- Never commit or push unless asked.

## Amending this file

A rule may be added only after a real violation, and must cite it. A rule is
deleted the moment a checker enforces it — prose duplicating a check is dead
weight that dilutes the rules still doing work. **This file is meant to
shrink.** Use `/amend`.
