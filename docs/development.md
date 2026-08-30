# Development

Setup, the commands you'll actually use, how the tests are laid out, and
recipes for the common extensions.

- [Setup](#setup)
- [Commands](#commands)
- [The two ports](#the-two-ports)
- [The test suite](#the-test-suite)
- [Conventions](#conventions)
- [Recipes](#recipes)
- [CI](#ci)

## Setup

```bash
git clone https://github.com/IbrahimTareq/kothai.git
cd kothai
corepack enable          # provides the pnpm version pinned in package.json
pnpm install
```

Node **22** — pinned in [`.nvmrc`](../.nvmrc), matched by CI and by the
Dockerfile's `ARG NODE_VERSION`, with a CI step that fails if those two drift.
They already did once: contributors on Node 24 while CI and the image ran 22,
which hid a `mock.module()` misuse that only fails on 22.

`pnpm install` is the slow step — `@qvac/sdk` ships large native prebuilds for
every OS and arch.

> [!TIP]
> Don't want ~3 GB of model weights on your dev box? Set
> `STASH_AI_PROVIDER=remote` and `STASH_AI_BASE_URL=http://localhost:11434/v1`
> and point it at Ollama. Or pick *"Skip for now"* in the first-run flow and
> develop against an AI-free install — most of the app doesn't need a model.

## Commands

| | |
|---|---|
| `pnpm dev` | Node server on `:5173` **and** Vite with HMR on `:5174`, concurrently. **This is the one you want.** |
| `pnpm start` | Full build, then serve on `:5173`. What production does. |
| `pnpm build` | Token lint → `tsc --noEmit` → Vite build. |
| `pnpm test` | Token lint → 789 tests. ~4s. |
| `pnpm typecheck` | `tsc --noEmit` alone. |
| `pnpm lint:tokens` | The design-token linter alone. |

Note that `build` runs the token lint and typecheck, which is why CI has no
separate typecheck step.

## The two ports

```
:5174  Vite    → HMR, serves client/ from source, proxies /api + /uploads ─┐
                                                                           │
:5173  Node    → owns /api, /uploads, and serves ./dist in production ←────┘
```

Develop against **5174**. Open **5173** to check what a production build
actually looks like.

> [!WARNING]
> If you configure a launch/preview target, point it at **5173**, not 5174.
> Hitting 5174 before Vite is ready leaves the app stuck on `BOOTING…`.

## The test suite

789 tests, `node:test`, about four seconds, no browser and no running server.

```bash
pnpm test                                     # everything
node --test test/server/ai/roles.test.js      # one file
node --test --test-name-pattern="residency"   # by name
```

`test/` mirrors the source tree exactly:

```
test/
├─ client/          pure client modules — layout, router, markdown, source, pager
└─ server/
   ├─ ai/           facade, enrich chain, prompts, normalise, backlog, circuit
   │  └─ providers/ local, remote, and the shared contract test
   ├─ data/         db columns, embedding blobs, migration, query, RRF
   ├─ import/       Instagram parsing
   ├─ lib/          auth, ssrf, zip, tags, http
   └─ routes/       each route's handler
```

### Why the tests are fast

Because the logic worth testing doesn't do I/O. Layout maths, tag
normalisation, residency policy, query filters, prompt construction, URL
classification, RRF — all pure modules. `RoleManager` takes its loader *and its
timers* as constructor arguments; `Circuit` takes its clock. Tests drive model
lifecycles and 60-second cooldowns without sleeping.

TypeScript test files run **natively** — Node strips types, there's no build
step. Two consequences:

- sibling imports in pure client modules need **explicit `.ts` extensions**
  (which is why `allowImportingTsExtensions` is on in `tsconfig.json`),
- and a pure module that imports React or the DOM stops being testable this
  way. Keep `domain/`, `layout/` and `util/` clean.

### Provider contract test

`test/server/ai/providers/provider-contract.test.js` asserts both providers
expose the same surface. If you add a method to one, add it to the other or the
test tells you.

## Conventions

**Comments explain *why*.** This codebase is unusually heavily commented on
purpose. A comment recording the bug a line prevents — the ARM SVE `SIGILL`, the
`Float32Array` byte-offset copy, the stale-load discard in `RoleManager` — is
worth far more than one restating what the line does. Match that density.

**Pure logic lives in pure modules.** If a new bit of logic has a decision in
it, it probably belongs in a file with no imports from `node:fs`, the network,
or React — where it can be tested directly.

**The server stays thin.** No framework, no ORM, no build step, five runtime
dependencies. Hand-rolling ZIP reading and session signing was cheaper than the
supply chain.

**One place per concern.** Every env var resolves in `server/config.js`. Every
route registers in `server/router.js`. Every model call goes through
`server/ai/index.js`. Every design token lives in
`client/styles/foundation/tokens.css`.

**CSS goes through tokens.** Every size, colour, radius, spacing step, duration
and z-index must come from a token — enforced by `scripts/lint-tokens.mjs`,
which runs in both `build` and `test`. There's an escape hatch for values that
genuinely can't be tokens:

```css
background: rgba(0, 0, 0, 0.45); /* token-lint-ignore: overlay on arbitrary imagery */
```

Always say why. Full rules in [design-system.md](design-system.md).

## Recipes

<details>
<summary><b>Add an API route</b></summary>

1. Write the handler in `server/routes/<domain>.js`. Take `(req, res)`, use
   `json(res, status, body)` and `readBody(req)` from `server/lib/http.js`.
2. Register it in `server/router.js`. Order matters — specific paths before
   the prefix matches, and everything after the auth gate.
3. Add a test in `test/server/routes/<domain>.test.js`.

Errors the client needs to *act* on get a stable `code` alongside the message
(`llm_off`, `import_in_progress`, `confirm_required`, `provider_unavailable`),
so the UI can render a real state instead of parsing prose.

</details>

<details>
<summary><b>Add an importer (TikTok, Pocket, bookmarks…)</b></summary>

`server/import/index.js` is a registry. An importer is a module exporting:

```js
export const name = 'tiktok'
export function sniff(files) { /* Map<entryName, Buffer> → boolean */ }
export function parse(files) { /* → items */ }
export function deriveNote(item) { /* → note record */ }
```

Add it to the `IMPORTERS` array. The route and the client's per-source Import
sections address importers by `name`, so nothing else needs touching.

Two things the Instagram importer learned the hard way, both worth copying:

- **Canonicalise URLs before deduping.** A manually saved link and the same
  post arriving via export almost never match byte-for-byte — tracking params,
  optional `www.`, cosmetic trailing slashes, and `/p/` vs `/reel/` for the
  same post.
- **Be defensive in `sniff()` and `parse()`.** Both run over an untrusted
  upload. `findImporter` wraps `sniff()` in a try/catch so one importer
  throwing on an unexpected shape can't break detection for the rest.

</details>

<details>
<summary><b>Add a model preset</b></summary>

`server/ai/presets.js` is pure data — no SDK import, because the settings store
needs `DEFAULTS` even in the lite image where no local provider exists.

```js
{ key: 'QWEN3_4B_INST_Q4_K_M', label: 'Qwen3 4B', desc: '…', best: ['m2'] }
```

`key` must exist in the QVAC registry. `best` marks the sweet spot per device
class (`pi`, `m2`). Byte sizes aren't here — they come from the registry via
the local provider's `presetInfo()`. Vision entries also carry `proj` for the
mmproj file.

</details>

<details>
<summary><b>Add a source platform (for filter chips and facets)</b></summary>

Platform predicates are duplicated in exactly two places — `client/domain/source.ts`
(client filtering) and `server/data/query.js` (server facet counts). Add to
both; a parity test fails if they drift.

</details>

<details>
<summary><b>Add a CSS token</b></summary>

Define it in `client/styles/foundation/tokens.css`, then use `var(--…)`.
Stylesheets are layered `foundation/` → `components/` → `views/` and imported
in that order by `client/style.css`. Run `pnpm lint:tokens`.

</details>

## CI

[`ci.yml`](../.github/workflows/ci.yml) runs on every push and PR to `main`:
install → assert `.nvmrc` and the Dockerfile agree on Node → **build** → test.

The build runs *before* the tests deliberately: `server/lib/http.js` serves
static assets from `./dist`, and the auth-gate tests drive a real listening
server to check the login page can fetch its font. With no `dist` that 404s. It
passed locally only because contributors have a stale build lying around, which
CI never does.

[`docker.yml`](../.github/workflows/docker.yml) publishes the multi-arch image
to GHCR on a `v*` tag, gated on `ci.yml`. It boot-tests the amd64 image on a
native x86 runner — the check that can't be done on Apple Silicon, where Rosetta
only emulates SSE4.2 and the AVX2 llama.cpp kernels `SIGILL`. See
[vps-verification.md](vps-verification.md).

```bash
git tag v1.0.2 && git push --tags
```
