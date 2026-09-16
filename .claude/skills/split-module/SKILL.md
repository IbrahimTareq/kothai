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
23 entries (11 client, 12 server) — read the file for the current count and
list, it changes as debt is paid down or newly incurred.

## Procedure

1. **Name the nouns.** List the file's exports (`grep -n '^export ' <file>`)
   and group them by what they serve, not by what type of thing they are.
   Worked example — `server/ai/meta.ts` (25 exports, 818 lines) is six
   integrations sharing a filename:
   - Instagram: `isInstagramPost`, `instagramEmbedUrl`, `parseInstagramEmbed`,
     `unescapeEmbedUrl`, `parseInstagramCarousel`, `fetchInstagramSlides`,
     `captionToMeta`, `describeMissingPieces`
   - Reddit: `isRedditPost`, `isRedditShare`, `resolveRedditShare`,
     `redditJsonUrl`, `parseRedditPost`
   - YouTube: `youtubeVideoId`, `isYouTubeVideo`, `joinCaptions`,
     `fetchYouTubeCaptions`
   - Article extraction: `extractArticle`, `mergeSiteDesc`, `fetchLinkMeta`
   - oEmbed: `oembedEndpoint`
   - SSRF checks: `isSafeFetchUrl`, `get`
2. **Carve one noun out per commit, never several.** One PR-sized change,
   one noun moved to its own file (e.g. `server/ai/meta-reddit.js`). Doing
   two nouns in one commit is exactly the failure mode this guards against —
   it makes the diff hard to review and the bisect useless.
3. **Move its tests in the same commit.** Code and its tests land together
   so a `git bisect` never lands on a commit where the split is half done.
4. **Re-point importers.** Find every consumer of the old path before
   editing anything:
   ```
   grep -rn "from '.*/ai/meta.js'" server client test
   ```
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

## What not to do

- **No barrel file** re-exporting everything from the new files out of the
  old filename. That moves nothing — the old file still has every export
  passing through it, and the shape check still sees them there.
- **Do not split by technical layer** (`types.js`, `helpers.js`, `utils.js`).
  A file named for a layer accretes the same way the original did, just
  under a different name. Split by the noun each group of exports serves —
  see the `meta.js` example above.
- **Never raise a baseline to make the check pass.** If a split is
  impossible without growing a file past its recorded number, that is a
  signal the split is wrong, not a reason to hand-edit the register.
