# Kothai design system

Everything visual comes from a token in `client/styles/foundation/tokens.css`. If a
value is not a token, it is either a documented exception or a bug —
`npm run lint:tokens` tells you which.

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

`client/ui/` holds the React primitives; `client/styles/components/primitives.css`
styles them. **Buttons are `<Button>`** (`client/ui/Button.tsx`), the only
writer of the `.btn` class list — `npm run lint:tokens` fails a hand-written
`className="btn …"` anywhere else. Its props compose freely:

| prop | values |
|---|---|
| `size` | `xs`, default, `lg`, `icon` (square, glyph centred) |
| `tone` | default, `solid`, `ghost` |
| `danger` | flag; with `tone="solid"` it is the filled confirm of an arm/confirm pair |
| `asChild` | puts the box on the child instead: an `<a download>`, a `<label>` round a file input |

The sizes were lifted from buttons that already existed rather than invented,
so the scale describes the app. There are no per-view aliases of `.btn` left —
`.row-btn` and `.spaces-new-btn` were grouped straight into these rules, and
`.conn-btn`/`.wizard-test`/`.chat-confirm`/`.onboarding-start`/`.space-form-go`
each hand-rolled the same box separately; all are gone now, and
`npm run lint:tokens` fails any new one. The other button-shaped classes —
`.rail-btn`, the composer's `.send-btn`/`.attach-btn` and the rest — are
distinct components with their own box, but each is still a raw `<button>` a
view drew. They sit on a ratchet
(below) until each becomes `<Button>` or its own primitive in `client/ui/`.

**Boxed text fields are `<Input>` and `<Textarea>`** (`client/ui/Input.tsx`):
Settings' field box, made the box for every surface. `compact` for fields that
list many short values (the model combobox, the rule-tag filter); `danger`
focuses red inside a destructive confirm. Seven boxed fields had drifted into
five backgrounds, three focus colours, three paddings and two radii, two with
no focus style at all; every one now reaches 44px on touch, not only the erase
confirm. In-place editors — a canvas note, a chat or space rename, a tag pill,
the composers, Everything's underline search — take the shape of what they edit
and stay raw fields on the ratchet below.

**A glyph is named by `<Tooltip>`** (`client/ui/`, on Radix): a mono `label`,
or a `label` over a `detail` sentence in the text face for a tip that explains.
It shows on hover and on keyboard focus, closes on Escape, and is portaled on
`--z-portal`. It is never the accessible name — the trigger carries its own
`aria-label`, which the rail's buttons need on a phone, where they are tabs and
no tip shows. It replaced three hand-rolled tips (the rail's, Expanded's actions,
a smart space's spark) that answered to the mouse only.

**Pills are `<Chip>`** (`client/ui/`): Everything's filters, a space's rule
tags, an item's tags. `on` for an applied filter (it sets `aria-pressed`),
`compact` in a list rather than on a toolbar, `add` for the dashed "+ …", and
`removable` for a pill whose click takes it away — an ×, red on hover. It
absorbed Expanded's own tag pills, whose annotation had deferred exactly this,
and settled "add one" on the dashed, quiet pill: "+ Add tag" had been a filled
accent in the same sidebar as a dashed "Add to space".

**A modal is `<Dialog>`** (`client/ui/`, on Radix): the item view and quick
capture. It traps focus, hides the page behind it from a screen reader, names
itself with a `title` it reads out but does not show, opens on the panel (or on
`initialFocus`), closes on Escape or an outside press through Radix's layer
stack, and returns focus to what opened it. Both were plain divs with none of
that: Tab walked out of the item view into the board, and closing one dropped
focus on `<body>`.

**The second step of an irreversible action is `<Confirm>`** (`client/ui/`): a
question, a filled confirm, and Cancel — boxed under a settings row, or
`inline` in a row or header; `danger` when it destroys something, `guard` for a
word to type first. It moves focus to the decision when it appears, and Escape
cancels. It replaced six hand-built confirms, of which two answered Escape, one
moved focus, and one — the chat row's — confirmed with an outline button.

**The small caps name over a section or beside a field is `.eyebrow`**: mono
10px, label tracking, faint — the role Settings already called the eyebrow.
Ask's chat history, Settings' groups, Expanded's sections and field labels, a
menu's title and a code block's language all carry it, and keep only layout in
their own rule. It had been written thirteen times in three sizes, two
trackings and three greys; `lint:tokens` now fails small text set in caps
anywhere but `primitives.css`.

**Every page opens with `<PageHeader>`** (`client/ui/`). Two rows: identity
(`lead`, `title`, a mono `meta` count, `actions` on the right) over a toolbar
of `filters` on the left — what is shown — and `display` on the right — how
it is shown. One title size (`--text-xl`), one gutter, the title at the same
height on every page, and no rule under it: the toolbar row is the edge.
Before, Everything had no title, Settings set its own at `--text-2xl` in an
icon tile, and a space drew a hairline no other page had. The Ask landing is
the exception — its headline is the prompt, not a page title.

**Pick-one-of-a-few is `<Segmented>`** (`client/ui/`), on Radix's toggle
group: a `label`, a `value`, an `onChange` and `options` of `{ value, label,
title? }`, where `title` is also the accessible name of an icon-only option.
It is a radiogroup with arrow-key movement, and a click on the chosen option
does not clear it. Five were hand-drawn before, in two boxes and four
accessibility patterns; the model residency picker's flush, hairline-split box
is gone, so Settings no longer shows two kinds of segment on one page.

**Menus and popovers are `<Menu>` and `<Popover>`** (`client/ui/`), on Radix,
which owns focus, arrow keys, Escape and outside clicks. `<Menu>` is a list of
actions and takes its items as data (`label`, `trailing`, `checked`,
`onSelect`), so every row is drawn the same way; a checkable item keeps the
menu open to toggle several in a row. `<Popover>` is for anything else: a
field, a hint, a list you filter. Given a `trigger` it is modal; given an
`anchor` instead it is a combobox's list, which leaves focus in the field —
the endpoint model field's list was an absolute `ul` its accordion clipped to
one row and the next accordion painted over, each patched by a workaround. Both are portaled to `<body>` on `--z-portal`,
above the expanded item, and styled by `.menu`/`.pop` in `primitives.css`. They
replaced three hand-built pickers that had two surfaces, two radii, three row
fills and a z-index that put one of them under its neighbours.

A view may still pass a `className` for genuine layout, the way `.mf-delete`
pins itself right. What it may not do is rebuild the box. (`.chat-more`,
`.remote-model-toggle` and Expanded's `.del` restyle it today — debt, not
precedent.)

## Deliberate exceptions

Three things sit outside the system on purpose. Don't "fix" them.

- **The Ask surface.** `.core` uses chat-specific tokens (`--text-chat`,
  `--leading-chat`, `--chat-*`, `--shadow-*`) ported from the ai-sdk chatbot
  reference — 13px at 1.65 with soft shadows instead of hairlines. Its *type*
  treatment was promoted to the app-wide default; its *surfaces* remain local.
- **Content overlays.** Controls, badges and labels that float over user
  imagery or video sit on `--scrim` (`--scrim-hover` when pressed) with a
  `--color-white` glyph — tokens that are the same in both themes, because
  their backdrop is the media, not a themed surface. They were literals that
  had drifted across four alphas, and one used a themed overlay token and paled
  on light. Letterbox backgrounds and the dark code block are still literal,
  each annotated with `token-lint-ignore` and a reason.

## The guardrail

```bash
npm run lint:tokens
```

Runs automatically as part of `npm run build` and `npm test`, and covers two
surfaces.

Across every sheet under `client/styles/` it fails on raw font sizes, colours, radii, spacing
under 48px, line-heights, z-index values, durations under .5s, and on any `var(--x)` with no
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

It also fails any rule outside `primitives.css` that declares a whole button box
— `cursor:pointer` with `padding`, `border-radius` and `font-size`. This is the
rule that keeps `.btn` the default. It keys on the chrome rather than the class
name, because a name-shaped rule would be satisfied by calling the next
hand-rolled button `.wizard-test`, which is precisely how the last one happened.
Seven controls are annotated exceptions: a floating action circle, a segment,
an inline citation ref, a scroll affordance, two combobox list rows, and a
dashed add affordance.

The markup half of the same rule: outside `client/ui/`, any `className`
carrying `btn` or `btn--*` fails. It has no escape hatch — use `<Button>`.

And a raw `<button>` or raw field (`<input>`, `<textarea>`, `<select>`)
outside `client/ui/`, or a fixed pixel width or height in a stylesheet, is debt
on a ratchet. `scripts/raw-baseline.json` records each file's counts (65
buttons across 14 files when it landed; fields joined at 11, pixel sizes at
140 — many of those legitimate, a thumbnail or an icon box, which is why they
are counted rather than banned), and a count must match it exactly: one above is new debt, one
below means the baseline has to be lowered to record the payment. A new control
is a `<Button>` or a new primitive in `client/ui/`, never a fresh box in a view.
The baseline is diffed against `HEAD` like the shape ratchet's, so raising a
number by hand fails until it is committed.

To allow a value that genuinely cannot be a token, annotate the line and say why:

```css
color:#ff4500;  /* token-lint-ignore: Reddit brand orange, not ours */
```

## Testing

Two automated layers, and one that is still human.

`npm run lint:tokens` proves every value comes from a token.

`test/client/design-tokens.test.ts` proves the resolved colours are *usable*:
body-text tokens clear WCAG AA in both themes, popover surfaces are opaque, the
accent hover stays visible against the page, and no colour token is defined for
dark only.

`test/client/style-pairings.test.ts` proves the stylesheets *pair* them
correctly. A token being individually fine says nothing about the rule that puts
it on top of another one: `.conn-btn.primary` filled with `--accent` and inked
with `--accent-ink` — a legacy alias that resolved to the accent itself — and rendered white
on white in dark, near-black on near-black in light, passing both other layers.
Every rule declaring `color` and `background` as plain `var()` references is now
checked in both themes, at 3:1 for controls and a bare perceptibility floor for
the deliberately recessive ones (`--ink-faint` inks, `--scrim` backdrops).

All three read the stylesheets rather than a browser, so they are deterministic
across machines — unlike pixel screenshots, whose baselines differ between macOS
and CI.

Together those cover the bug class that produced every defect found during the
sweep: a value that was correct in one theme and broken in the other.

What is still **not** covered is composition — layout, overlap, whether spacing
reads well. There are no visual regression tests. Any change to spacing, size or
layout needs checking in a browser in **both themes**, and on mobile if it
touches the composer or rail.
