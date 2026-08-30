# Kothai design system

A monochrome, restrained language adapted from [trybehold.com](https://trybehold.com).
Everything visual comes from a token in `client/styles/tokens.css`. If a value is
not a token, it is either a documented exception or a bug — `npm run lint:tokens`
tells you which.

## The rules

1. **Colour carries no brand.** The palette is black, white, and opacity.
   Hierarchy comes from `--ink` → `--ink-dim` → `--ink-mute` → `--ink-faint`,
   never from a new hue. The only colours in the system are the functional
   status hues `--danger`, `--warn`, `--ok`.
2. **Headings are semibold and lightly tightened.** `--fw-heading` (600) with
   `--tracking-heading` (-.025em). This comes from the Ask landing headline,
   which the whole app was aligned to.
3. **Body text tracks neutral.** `--tracking-normal`. Tracking tightens only as
   type gets larger — `--tracking-tight` for small UI text, `--tracking-tighter`
   at 28px+, `--tracking-tightest` for display.
4. **Type is never bold.** `--fw-bold` exists for one third-party brand tag and
   should not spread.
5. **Surfaces are white at low opacity** (`--panel`, `--panel-2`, `--panel-3`)
   over `--bg`, separated by hairlines (`--line`, `--line-2`), not by shadows.
6. **Both themes always.** Every colour must resolve sensibly under
   `:root` and `:root[data-theme="light"]`. A hardcoded white is a light-theme
   bug waiting to happen — this is how the send button once became invisible.
7. **The accent is tintable.** Users can set a custom `--accent` in Settings,
   written onto `documentElement` at runtime (`App.tsx`). Anything that fills
   with the accent must use `--accent` / `--accent-hover` / `--on-accent`, never
   a literal, or it will not follow their choice.

## Choosing a value

Pick by role. The scales are closed sets — if the value you want is not there,
the right move is to use the nearest step, not to add one.

| Axis | Tokens | Notes |
|---|---|---|
| Type size | `--text-3xs` (9px) → `--text-display-lg` (40px) | `--text-display-fluid` for hero headings |
| Weight | `--fw-light` `--fw-normal` `--fw-medium` `--fw-heading` `--fw-bold` | headings use `--fw-heading` |
| Tracking | `--tracking-normal` `--tracking-heading` `--tracking-tight` `--tracking-tighter` `--tracking-tightest` `--tracking-mono` `--tracking-label` | tightens as size grows |
| Leading | `--leading-none` → `--leading-normal`, plus `--leading-chat` | |
| Spacing | `--space-0` → `--space-48` | named by px on purpose: `--space-12` is 12px, so two people pick the same one |
| Radius | `--radius-xs` (2px) → `--radius-2xl` (16px), `--radius-full`, `--radius-circle` | `--radius-md` (8px) is the most common |
| Control size | `--control-sm` (28) `--control-md` (32) `--control-lg` (40) `--control-xl` (46) | button and input footprints |
| Motion | `--dur-fast` `--dur-mid` `--dur-slow` `--dur-slower`, `--ease-out` `--ease-entrance` `--ease-in-out`, `--delay-sm` | |
| Stacking | `--z-base` → `--z-modal` | named by job; never pick a number |

**Spacing above 48px is layout, not rhythm** — mobile composer clearance, hero
padding. Those stay literal and the linter ignores them.

**Motion at or above .5s is choreography, not feedback** — the thinking dots,
caret blink, skeleton sheen, fab ring. Those stay bespoke in their `@keyframes`
and are deliberately off the duration scale.

## Components

`client/styles/components.css` holds the shared primitives. **New buttons should
use `.btn` plus a modifier** (`.btn--solid`, `.btn--ghost`, `.btn--icon`,
`.btn--danger`) and nothing else.

The older per-view button names (`.row-btn`, `.spaces-new-btn`, `.coll-menu-btn`,
`.seg-btn`, `.residency-btn`, `.rail-btn`, `.send-btn`, `.attach-btn`) are grouped
into the same rules rather than redefining them, so a change in `components.css`
reaches all of them. Treat them as legacy aliases: don't add more.

## Deliberate exceptions

Three things sit outside the system on purpose. Don't "fix" them.

- **The Ask surface.** `.core` uses chat-specific tokens (`--text-chat`,
  `--leading-chat`, `--chat-*`, `--shadow-*`) ported from the ai-sdk chatbot
  reference — 13px at 1.65 with soft shadows instead of hairlines. Its *type*
  treatment was promoted to the app-wide default; its *surfaces* remain local.
- **Content overlays.** Controls and badges that float over user imagery or
  video use literal black scrims and white glyphs, because their backdrop is the
  media, not a themed surface. Same for letterbox backgrounds and the dark code
  block. Each is annotated with `token-lint-ignore` and a reason.
- **The Tweaks panel.** `Tweaks.tsx` injects its own stylesheet with a foreign
  design language and a `--dc-inv-zoom` token; `tweaks.css` only overrides it.
  Both are excluded from the linter.

## The guardrail

```bash
npm run lint:tokens
```

Runs automatically as part of `npm run build` and `npm test`, and covers two
surfaces.

In `client/styles/*.css` it fails on raw font sizes, colours, radii, spacing
under 48px, z-index values, durations under .5s, and on any `var(--x)` with no
definition and no fallback — that last one silently drops the property, which is
how an undefined `--fg` once made the "Create space" button render
white-on-transparent.

In `client/**/*.tsx` it fails on `style={{...}}` objects containing literal
colours, literal px, or literal numbers for layout properties, because a
component can otherwise bypass the whole system in one line. Genuinely dynamic
inline styles are the legitimate use and still pass — interpolations are
stripped before the literals are examined, so
``style={{ transform: `translate3d(${x}px, 0, 0)` }}`` is fine while
`style={{ padding: 9 }}` is not.

To allow a value that genuinely cannot be a token, annotate the line and say why:

```css
color:#ff4500;  /* token-lint-ignore: Reddit brand orange, not ours */
```

## Testing

Two automated layers, and one that is still human.

`npm run lint:tokens` proves every value comes from a token.
`test/design-tokens.test.ts` proves the resolved colours are *usable*: body-text
tokens clear WCAG AA in both themes, popover surfaces are opaque, the accent
hover stays visible against the page, and no colour token is defined for dark
only. It reads the stylesheet rather than a browser, so it is deterministic
across machines — unlike pixel screenshots, whose baselines differ between macOS
and CI.

Together those cover the bug class that produced every defect found during the
sweep: a value that was correct in one theme and broken in the other.

What is still **not** covered is composition — layout, overlap, whether spacing
reads well. There are no visual regression tests. Any change to spacing, size or
layout needs checking in a browser in **both themes**, and on mobile if it
touches the composer or rail.
