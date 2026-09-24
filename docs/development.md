# Development

Setup, commands, tests, and recipes for common extensions.

## Setup

```bash
git clone https://github.com/IbrahimTareq/kothai.git
cd kothai
corepack enable          # provides the pnpm version pinned in package.json
pnpm install
git config --local core.hooksPath .githooks   # commit-msg runs commitlint
```

Node **22** is pinned in [`.nvmrc`](../.nvmrc) and matched by CI and the Dockerfile.

`pnpm install` is the slow step. `@qvac/sdk` ships large native prebuilds for every OS and arch.

## Commands

| | |
|---|---|
| `pnpm dev` | Node server on `:5173` **and** Vite with HMR on `:5174`, concurrently. **This is the one you want.** |
| `pnpm start` | Full build, then serve on `:5173`. What production does. |
| `pnpm dev:site` | The docs site alone on `:5175`. |
| `pnpm build` | Biome → token lint → typecheck → Vite build. |
| `pnpm test` | Biome → token lint → shape lint → the test suite. ~5s. |
| `pnpm typecheck` | `tsc --noEmit` over both projects. |
| `pnpm lint` | Biome check alone. |
| `pnpm format` | Apply formatting. Biome decides style. |

`build` runs Biome, the token lint, and both typechecks. `test` runs that same pass plus the shape ratchet before the suite, so a red `pnpm test` can mean a lint or shape failure, not just a failing test.

## The two ports

```
:5174  Vite    → HMR, serves client/ from source, proxies /api + /uploads ─┐
                                                                           │
:5173  Node    → owns /api, /uploads, and serves ./dist in production ←────┘
```

Develop against **5174**. Open **5173** to check what a production build actually looks like.

## TypeScript

There is **no build step on the server**. `node server/index.ts` runs the source directly. Node strips the types at load and never checks them. The compiler is a separate gate (`pnpm typecheck`) over two projects:

| | |
|---|---|
| `tsconfig.json` | `client/` with DOM libs, JSX, `moduleResolution: bundler`. Vite owns the bundle. |
| `tsconfig.server.json` | `server/`, `test/server/`, `scripts/`, `docker/` with node libs, `moduleResolution: nodenext`. Nothing here is ever compiled. |

## The test suite

Plain `node:test`, about five seconds, no browser and no running server.

```bash
pnpm test                                     # everything
node --test test/server/ai/roles.test.ts      # one file
node --test --test-name-pattern="residency"   # by name
```

`test/` mirrors the source tree exactly:

```
test/
├─ client/          pure client modules: layout, router, markdown, source, pager
└─ server/
   ├─ ai/           facade, enrich chain, prompts, normalise, backlog, circuit
   │  └─ providers/ local, remote, and the shared contract test
   ├─ data/         db columns, embedding blobs, migration, query, RRF
   ├─ import/       Instagram parsing
   ├─ lib/          auth, ssrf, zip, tags, http
   └─ routes/       each route's handler
```

