---
name: split-module
description: Break an oversized module into focused ones without breaking tests. Use when paying down shape-baseline debt or when a file has grown past its budget.
---

# Split a module

A module is one noun. When a file has grown into several nouns wearing one
filename, split it — one noun per file.

`scripts/shape-baseline.json` is the debt register: every file over the flat
budget (400 lines / 12 export statements, set in `scripts/lint-shape.ts`) is
listed there with the size it's grandfathered at. As of this writing it holds
20 entries (9 client, 11 server) — read the file for the current count and
list, it changes as debt is paid down or newly incurred.

## Procedure

1. **Name the nouns.** List the file's exports (`grep -n '^export ' <file>`)
   and group them by what they serve, not by what type of thing they are.
   Worked example, done in 5d38056..55c88da — `server/ai/meta.ts` (780
   lines, 26 exports) was several integrations sharing a filename:
   - Fetching: `get`, `isSafeFetchUrl`, `decodeEntities`, `saveThumb`,
     `saveThumbSafe` — used by every other group, so carved out FIRST
     (`server/links/fetch.ts`) and neither later module imports the other
   - Instagram: `isInstagramPost`, `parseInstagramEmbed`,
     `fetchInstagramSlides` and the throttle → `server/links/instagram.ts`
   - What stayed: oEmbed, Reddit share links, YouTube captions, article
     extraction and `fetchLinkMeta` — 390 lines, 12 exports, off the register
2. **Carve one noun out per commit, never several.** One PR-sized change,
   one noun moved to its own file (e.g. `server/links/instagram.ts`). Doing
   two nouns in one commit is exactly the failure mode this guards against —
   it makes the diff hard to review and the bisect useless.
3. **Move its tests in the same commit.** Code and its tests land together
   so a `git bisect` never lands on a commit where the split is half done.
4. **Re-point importers.** Find every consumer of the old path before
   editing anything:
   ```
   grep -rn "links/meta.ts'" server client test
   ```
   Include tests that `mock.module()` the old path: a mock left pointing at
   the old file stops intercepting anything, and the test quietly reaches
   the real network instead.
   Update each import to the new file (or re-export a small shim only if a
   caller genuinely needs both nouns — prefer fixing the caller).
5. **Re-baseline with the real command:**
   ```
   mise exec node@22 -- pnpm lint:shape -- --update
   ```
6. **Verify:**
   ```
   mise exec node@22 -- pnpm test
   ```

## Important and non-obvious

`pnpm lint:shape -- --update` can only **tighten** a baseline entry, never
raise one (see `nextBaseline` in `scripts/lint-shape.ts`). If a file grew
instead of shrank, `--update` will not clear the failure — that is
deliberate, not a bug to work around. Raising a baseline requires
hand-editing `scripts/shape-baseline.json` directly — but `lint-shape.ts`
diffs that file against the last commit and fails on anything widened there,
so the hand-edit cannot pass `pnpm test` until it's committed to `main`
(there is no PR review here to catch it otherwise). Never do this to make a
check pass; it defeats the entire point of the ratchet.

**A baselined file cannot simply be moved.** The register keys entries by
path, so a moved file is a "new entry" and fails. Split it under the flat
budget first — then it has no entry, and the move is free.

**A split usually adds exports.** Helpers two new modules share must now be
exported, and the governance `exportTotal` has no headroom. Offset them by
un-exporting symbols used only inside their own file (grep each export for
callers outside it) rather than by editing the total.

## What not to do

- **No barrel file** re-exporting everything from the new files out of the
  old filename. That moves nothing — the old file still has every export
  passing through it, and the shape check still sees them there.
- **Do not split by technical layer** (`types.js`, `helpers.js`, `utils.js`).
  A file named for a layer accretes the same way the original did, just
  under a different name. Split by the noun each group of exports serves —
  see the `meta.ts` example above.
- **Never raise a baseline to make the check pass.** If a split is
  impossible without growing a file past its recorded number, that is a
  signal the split is wrong, not a reason to hand-edit the register.
