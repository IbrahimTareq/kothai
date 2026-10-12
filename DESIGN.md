---
name: Kothai
description: A self-hosted archive for every thought, picture, link or file, and a way to ask it where things are.
colors:
  bg: "#0a0a0a"
  bg-2: "#0d0d0d"
  bg-raise: "#101010"
  panel: "rgba(255,255,255,.03)"
  panel-2: "rgba(255,255,255,.055)"
  panel-3: "rgba(255,255,255,.09)"
  ink: "#fff"
  ink-dim: "rgba(255,255,255,.60)"
  ink-mute: "rgba(255,255,255,.48)"
  ink-faint: "rgba(255,255,255,.32)"
  line: "rgba(255,255,255,.10)"
  line-2: "rgba(255,255,255,.06)"
  line-hover: "rgba(255,255,255,.22)"
  line-focus: "rgba(255,255,255,.40)"
  accent: "#fff"
  on-accent: "#0a0a0a"
  surface-modal: "#1e1e21"
  danger: "#ff6a7a"
  warn: "#ffcf5a"
  ok: "#8fe3b0"
  scrim: "rgba(0,0,0,.5)"
  scrim-hover: "rgba(0,0,0,.72)"
  backdrop: "rgba(0,0,0,.82)"
  letterbox: "#000"
  bg-light: "#ffffff"
  bg-2-light: "#f4f4f5"
  ink-light: "#0a0a0a"
  ink-dim-light: "rgba(10,10,10,.70)"
  ink-mute-light: "rgba(10,10,10,.58)"
  line-light: "rgba(0,0,0,.12)"
  accent-light: "#141414"
  danger-light: "#b91c1c"
  warn-light: "#92400e"
  ok-light: "#15803d"
typography:
  display:
    fontFamily: "Geist, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "clamp(24px, 3vw, 30px)"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-.025em"
  headline:
    fontFamily: "Geist, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-.03em"
  title:
    fontFamily: "Geist, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-.025em"
  body-reading:
    fontFamily: "Geist, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  body:
    fontFamily: "Geist, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "Geist, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: "normal"
  caption:
    fontFamily: "Geist, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  mono:
    fontFamily: "Geist Mono, ui-monospace, SFMono-Regular, Menlo, Monaco, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: ".06em"
rounded:
  xs: "2px"
  sm: "4px"
  base: "6px"
  md: "8px"
  lg: "10px"
  xl: "14px"
  2xl: "16px"
  full: "999px"
spacing:
  space-2: "2px"
  space-4: "4px"
  space-6: "6px"
  space-8: "8px"
  space-10: "10px"
  space-12: "12px"
  space-14: "14px"
  space-16: "16px"
  space-20: "20px"
  space-24: "24px"
  space-28: "28px"
  space-32: "32px"
  space-40: "40px"
  space-48: "48px"
components:
  button:
    backgroundColor: "{colors.panel-2}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "8px 14px"
  button-solid:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.md}"
    padding: "8px 14px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-mute}"
    rounded: "{rounded.md}"
    padding: "8px 14px"
  button-ghost-hover:
    backgroundColor: "{colors.panel-2}"
    textColor: "{colors.ink}"
  button-danger-solid:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.bg}"
    rounded: "{rounded.md}"
  button-lg:
    rounded: "{rounded.lg}"
    padding: "12px 20px"
  button-icon:
    size: "32px"
    rounded: "{rounded.md}"
  chip:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink-dim}"
    rounded: "{rounded.full}"
    height: "32px"
    padding: "0 14px"
  chip-on:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
  chip-compact:
    rounded: "{rounded.full}"
    height: "28px"
    padding: "0 12px"
  field:
    backgroundColor: "{colors.panel-3}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
    height: "32px"
  segmented:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "4px"
  segmented-option-on:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.base}"
  menu:
    backgroundColor: "{colors.bg-raise}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "6px"
  tooltip:
    backgroundColor: "{colors.bg-raise}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.base}"
    padding: "6px 10px"
  tile:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.md}"
  overlay-action:
    backgroundColor: "{colors.scrim}"
    textColor: "#fff"
    rounded: "{rounded.base}"
    size: "26px"
---

# Design System: Kothai

The source of truth is `client/styles/foundation/tokens.css`. `docs/design-system.md` carries the rules and the history behind them, and `pnpm test` enforces them (`lint:tokens`, the style-pairing contrast tests, the raw-control ratchet). This file describes the system for anyone generating new screens. Where it disagrees with those files, they win.

## Overview

**Creative North Star: "The Quiet Archive"**

Kothai is a private room for things you kept. The interface uses only black, white and opacity, so the colour on screen comes from what you saved: a video thumbnail, a photo, an article's lead image. Chrome recedes so the archive can be seen. The quiet is structural, not timid: every value on screen comes from a closed scale, so nothing looks improvised.

Density is that of a working tool. Body text is 14px, controls are 32px tall (44px on touch), and a page opens with one title row and one toolbar row. Hierarchy comes from ink opacity, size and weight, never from a new hue or uppercase labels. Surfaces are white at low opacity over a near-black page, separated by hairlines. Both themes are first-class: every colour is defined twice and tested in both.

Two looks are ruled out. The first is **terminal costume**: mono type spread across labels, counts and hosts, tracked uppercase micro-labels, scanlines, grids and glow. The codebase spent a whole pass removing these, and the linter now fails `text-transform: uppercase`. The second is **branded SaaS colour**: a signature hue, gradient CTAs, tinted icon tiles. The only hues are the three status colours and whatever accent the user picks in Settings.

**Key Characteristics:**
- Monochrome by doctrine; colour comes from saved media and status alone.
- One sans (Geist) for everything a person reads, one mono (Geist Mono) for text a person might copy or type.
- Hairlines, not shadows, separate surfaces. The Ask surface is the documented exception.
- Closed token scales for every axis, enforced by `lint:tokens`.
- Dark and light themes defined together and tested together.
- One user-tintable accent that every filled control must follow.

## Colors

A monochrome palette: a near-black page (pure white in the light theme), white ink stepped down by opacity, and three functional status hues.

### Primary
- **Inverted Ink** (`accent`): the only fill a primary action gets: white on dark, near-black (`accent-light`) on light, so a CTA is a reversal of the page rather than a colour. It is user-tintable: Settings writes a custom `--accent` onto the document at runtime, so anything filled with it must use `--accent` / `--accent-hover` / `--on-accent`, never a literal. `--accent-hover` is derived with `color-mix` so it follows the tint.
- **Page Ink** (`on-accent`): the text colour on an accent fill.

### Neutral
- **Night Paper** (`bg`): the page. `bg-2` raises rows a step and `bg-raise` is the opaque floor for popovers, menus and tooltips (`--surface-popover`).
- **Breath Panels** (`panel`, `panel-2`, `panel-3`): white at 3%, 5.5% and 9%. Use them in order of how much something needs to stand apart: a tile at rest, a hovered tile or default button, a text field. They are translucent on purpose, so never use them for a floating layer; that is `bg-raise`.
- **Ink Ladder** (`ink` → `ink-dim` → `ink-mute` → `ink-faint`): all text hierarchy. `ink` for titles and values, `ink-dim` for secondary text, `ink-mute` for eyebrows, counts, timestamps, placeholders and quiet controls: the quietest ink anyone reads, held at WCAG AA in both themes. `ink-faint` is never text: disabled states, borders, and glyphs whose control is named another way.
- **Hairlines** (`line`, `line-2`, `line-hover`, `line-focus`): the borders that do the work shadows do elsewhere. `line-2` is the quietest (tile at rest), `line-hover` and `line-focus` are the brightening a border makes on interaction.
- **Modal Surface** (`surface-modal`): quick capture's opaque field, a step lighter than the page because it floats over the backdrop in both themes.

### Status
- **Alarm Coral** (`danger`), **Signal Amber** (`warn`), **Mint Confirm** (`ok`): the only hues in the system, and only for state. Each is darkened in the light theme (`*-light`) to clear 4.5:1 on white.

### Media overlays (theme-invariant)
- **Scrim** (`scrim`, `scrim-hover`): the dark glass a control or badge sits on when it floats over a photo or video, always with a white glyph. It does not follow the theme because its backdrop is the media.
- **Backdrop** (`backdrop`): the dim behind a dialog. **Letterbox** (`letterbox`): pure black behind media that does not fill its frame, matching the bars a video carries itself.

### Named Rules
**The No Brand Hue Rule.** Hierarchy comes from the ink ladder, never from a new colour. If you are reaching for a hue to make something stand out, use a step up the ladder or the accent fill instead.

**The Both Themes Rule.** Every colour you use must resolve under `:root` and `:root[data-theme="light"]`. A hard-coded white is a light-theme bug; that is how the send button once vanished.

**The Readable Ink Rule.** Anything a person reads is `ink-mute` or stronger, which clears 4.5:1 on the page and in a field in both themes. `ink-faint` is for what nobody has to read.

**The Follow The Tint Rule.** Anything filled with the accent uses `--accent` / `--accent-hover` / `--on-accent`, or it will ignore the user's chosen colour.

## Typography

**Display Font:** Geist (with ui-sans-serif, system-ui)
**Body Font:** Geist (with ui-sans-serif, system-ui)
**Label/Mono Font:** Geist Mono (with ui-monospace, SFMono-Regular, Menlo)

**Character:** A single humanist-geometric sans does all of the reading, set apart by weight and ink rather than by face. The mono is a tool, not a voice: it appears only where the text is literal.

### Hierarchy
- **Display** (600, clamp(24px, 3vw, 30px), 1.2, -.025em): the Ask landing headline only. It is the prompt, not a page title.
- **Headline** (600, 28px, 1.2, -.03em): an article's headline in the expanded item.
- **Title** (600, 20px, 1.2, -.025em): every page title, the item panel and onboarding, all at the same size and height.
- **Body (reading)** (400, 16px, 1.5): a tile's headline, an article's standfirst: text meant to be read rather than scanned.
- **Body** (400, 14px, 1.5): the page default: rows, buttons, the Ask thread. Ask uses `--leading-chat` (1.65).
- **Label** (500, 12px, sentence case, `ink-mute`): the eyebrow over a section or beside a field, plus descriptions and small controls.
- **Caption** (400, 11px, `ink-mute`, tabular numerals where counting): counts, badges, timestamps, tile meta.
- **Mono** (400, 12–14px, +.06em): code, file names, tokens, endpoints, a model id in its field. It arrives only through `<code>` or `.mono`.

### Named Rules
**The Two Faces, Two Jobs Rule.** Geist for everything a person reads; Geist Mono only for text they might copy or type. Never hand-write a `font-family`. Never set a label, count or host in mono.

**The Never Bold Rule.** The heaviest reading weight is 600 for headings. `<b>` and `<strong>` are 500. 700 exists for one third-party brand tag and does not spread.

**The Sentence Case Rule.** Labels are sentence case. Hierarchy comes from size, weight and ink, not caps; `lint:tokens` fails `text-transform: uppercase`.

**The Inverse Tracking Rule.** Body tracks neutral. Tracking tightens only as type grows: -.02em for small UI text, -.025em for headings, -.03em at 28px and up. Positive tracking belongs to mono alone.

## Layout

A fixed 74px icon rail on the left, the page to its right. On phones (below 640px) the rail becomes a floating 60px tab-bar pill at the bottom, paired with the capture button so they read as one cluster. Every page opens with the same two-row header: identity (title, count, actions) over a toolbar (filters on the left, display controls on the right), with a 20px/28px gutter and no rule underneath. Under it, the scroller's 24px top padding stays open as a clear band and fades content in as it scrolls up.

Spacing is a closed scale named by pixel value: a 2px grid up to 24, then 4px steps to 48. Above 48px is layout (hero padding, composer clearance) and stays literal. Breakpoints are 560, 640, 720 and 820px. Control heights are 28, 32, 40 and 46px, and every control and menu row reaches 44px on touch.

Item grids are image-led masonry: cards are frameless, media bleeds edge to edge at its own height and captions sit beneath. The flat tile (Ask citations, the Spaces landing) is the aligned row instead: its media slot is a fixed 16:10 ratio whatever it holds.

**The Closed Scale Rule.** If the value you want is not on a scale, use the nearest step. Do not add one.

## Elevation & Depth

Flat by default. Depth comes from opacity layering (`panel` → `panel-2` → `panel-3`) and hairlines, not shadows. The page carries one near-invisible top vignette and nothing else: no grid, glow or scanlines. Shadows appear in two places only. Floating layers (menus, popovers, detail tooltips) get one soft drop so they read over content. The Ask surface is a documented exception that keeps soft one-pixel shadows and a 16px radius ported from the ai-sdk chatbot reference.

### Shadow Vocabulary
- **Popover** (`box-shadow: 0 8px 28px rgba(0,0,0,.28)`): menus, popovers and detail tooltips, always on the opaque `bg-raise`.
- **Card / Float / Composer** (`--shadow-card`, `--shadow-float`, `--shadow-composer`, `--shadow-composer-focus`): the Ask surface only. Defined per theme in `tokens.css`.

### Named Rules
**The Hairline Not Shadow Rule.** Separate surfaces with `line` or `line-2`. A shadow means "this floats above the page". If it doesn't float, it doesn't get one.

**The Opaque Float Rule.** Anything that floats over content (menus, popovers, tooltips) sits on `bg-raise`, never a translucent panel. Three popovers on `--panel` once rendered unreadable over content.

## Shapes

Gently rounded and consistent. 8px (`rounded.md`) is the default for buttons, fields, tiles, segmented troughs and menu rows. 10px marks a larger container: menus, popovers, confirms, the large button and link tiles. 6px is for small inner pieces (a segment's pill, a tooltip, an overlay glyph button). Chips are full pills. The Ask composer and bubbles use 16px. Borders are one pixel. Dashed borders mean one thing only: "add one" (the add chip).

## Components

Restrained and precise. A control is a hairline box on a faint fill that brightens its border when touched; only the single primary action on a surface is filled. Every component lives in `client/ui/` and is styled in `client/styles/components/primitives.css`. A view composes them and must not rebuild their boxes.

### Buttons
- **Shape:** gently rounded (8px); the large size goes to 10px.
- **Default:** `panel-2` fill, `line` hairline, `ink` text at 14px, 8px × 14px padding.
- **Solid:** the accent fill with `on-accent` text: the one primary action. When disabled it drops the fill to an outline rather than greying it.
- **Ghost:** no fill or border, `ink-mute` text; it gains a `panel-2` fill on hover. For chrome that should recede until touched.
- **Danger:** `danger` text and a `danger` border on hover. Danger + solid is the filled confirm of an arm/confirm pair.
- **Sizes:** xs (4px × 10px, 12px type), default, lg (12px × 20px), icon (32px square).
- **Hover / Focus:** hover brightens the border to `line-hover` over 0.16s. Keyboard focus is the one monochrome ring, a 2px `ink` outline offset 2px.

### Chips
- **Style:** full pill, 32px tall (28px compact), `panel` fill, `line` hairline, `ink-dim` text.
- **State:** `on` inverts to the accent fill. `add` is dashed and `ink-mute`. `removable` reddens its border and × on hover.

### Cards / Containers
- **Item card:** chromeless. Media bleeds to the 10px-rounded edge, the caption sits beneath, and hover lifts it 3px. Overlay controls are 26px scrim squares with a 4px blur, white glyphs, and `scrim-danger` on a destructive hover.
- **Link tile:** headline-led links get the `panel` + `line` shell with 14px padding, the title anchored to the bottom so a row's headlines line up.
- **Tile:** the flat cover-and-caption primitive (Ask citations, Spaces): `panel` fill, `line-2` hairline, 8px corners, 16:10 media slot.
- **Confirm:** `panel` box with 10px corners and a `line` border, turning `danger` when it destroys something.

### Inputs / Fields
- **Style:** `panel-3` fill, `line` hairline, 8px corners, 8px × 12px padding, 32px minimum height (44px on touch). Placeholder in `ink-mute`.
- **Focus:** the border brightens to `line-focus`. No ring, because a field matches `:focus-visible` on click too.
- **Danger / Disabled:** `danger` focus border inside a destructive confirm; disabled drops to 50% opacity.

### Segmented control
A 32px `panel` trough with a hairline and 4px inset, holding 6px-rounded options in `ink-mute`. The chosen option fills with the accent. This is the one box for every "pick one of a few".

### Menus, popovers and tooltips
`bg-raise` surface, `line` hairline, 10px corners, popover shadow, portaled above everything. Menu rows are 8px-rounded and highlight with an 8% ink wash; the highlight is the focus indicator. Tooltips are 12px labels in a 6px box, or a label over a sentence in a 10px box.

### Navigation
The rail holds 46px glyph buttons in `ink-mute`. Hover and active both get a `panel-2` fill and `ink`; active adds a short bar on the rail's left edge. Groups are separated by a hairline. On phones it becomes the bottom tab-bar pill. Every rail glyph carries its own `aria-label`, and its `<Tooltip>` is supplementary.

### Page header (signature)
A 20px semibold title, an 11–12px `ink-mute` count beside it, actions on the right. Underneath is a toolbar of chips (what is shown) and segmented controls (how it is shown). Nested pages add a small-print breadcrumb trail above the title. There is no rule under it: the toolbar row is the edge.

## Do's and Don'ts

### Do:
- **Do** take every value from a token in `client/styles/foundation/tokens.css`, and annotate a genuine exception with `token-lint-ignore` and its reason.
- **Do** step hierarchy through `ink` → `ink-dim` → `ink-mute` → `ink-faint` and `panel` → `panel-2` → `panel-3`.
- **Do** use `<Button>`, `<Input>`, `<Chip>`, `<Segmented>`, `<Menu>`, `<Popover>`, `<Tooltip>`, `<Dialog>`, `<Confirm>` and `<PageHeader>` from `client/ui/`, rather than drawing a box in a view.
- **Do** check every change in both themes at `/ui` on the dev server (port 5174), and on mobile if it touches the composer or rail.
- **Do** keep the state change and drop the movement under `prefers-reduced-motion`: a fade stays; a slide, scale or sweep does not.
- **Do** put controls that float over media on `scrim` with a white glyph.

### Don't:
- **Don't** introduce a brand hue, a gradient CTA or a tinted icon tile. Colour is the user's media, the status hues and the user's own accent.
- **Don't** dress the app as a terminal: no mono labels, counts or hosts, no tracked uppercase, no scanlines, grids or glow.
- **Don't** set type at 700, or write `<b>` expecting bold.
- **Don't** separate surfaces with shadows outside the Ask surface and floating layers.
- **Don't** fill anything with a literal white or black where it should follow `--accent` or the theme.
- **Don't** hide the focus ring with a bare `outline: none`. Name what shows focus instead.
- **Don't** add a step to a closed scale. Use the nearest one.
