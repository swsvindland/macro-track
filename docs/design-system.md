# Vector Design System

**Kit 1.2.2 · lineage: SIBYL · applies to Vector Body, Vector Lift, Vector Macros, Vector Hydration**

This file ships byte-identical in every repo as `docs/design-system.md`. It replaces `water-track/SIBYL_Design_System.md`, which moves to `docs/history/`. Canonical copy: `vector-design/kit/docs/design-system.md`. `KIT.md` explains the files and the drift check. `MIGRATION.md` lists the work.

It is written for the owner and for agents. **Rules are normative.** Where a platform behaviour can only be checked on a device, the rule names the **shipped default** and the **flag** that turns on the fuller behaviour after that check (§12).

---

## 1. Principles

When two rules conflict, the lower number wins.

1. **Sterile before beautiful.** The canvas is white; at night it is near-black. Structure comes from 1pt rules and alignment, never from shadows, gradients, tinted blocks, illustration or emoji. Test: grey out every cyan pixel and the screenshot should still read as Vector.
2. **Cyan is a signal, not paint.** `#22D3EE` is only ever a fill with `#071017` on it (the app icon). It has four uses: the primary action, a selected option, a live state, and progress toward the screen's goal. Cyan that has to be read (text, links, lines, focus, native tint) is the ink `#007088`, or `#22D3EE` at night.
3. **Language in Inter, measurement in Plex Mono.** Sentences are Inter. Anything measured, timed, counted or coded is IBM Plex Mono with fixed-width digits. Small uppercase mono eyebrows are the identity. They appear only for scripts that have case.
4. **Apple builds the hardware; Vector prints the readout.** Vector draws only rectangles: 4pt for controls and panels, 2pt for marks. Anything the system draws keeps Apple's own capsule, concentric or glass shape: tab bar, bar items, sheets, alerts, menus, watch buttons, widget and Live Activity platters. Vector never imitates glass, never paints system chrome, and never nests one of its rectangles in a system corner.
5. **One action, no ceremony.** A screen has one primary action. Secondary actions go in the `···` menu. Undo replaces confirmation. The only confirms left are for irreversible actions (erase all data, restore over existing data).
6. **Every value is stated in text.** A meter, chart, colour or dot never carries meaning alone. A readout sits beside it, and a status always has a word.
7. **Locale first.** Layout is logical (start and end). Numbers, dates and units go through `Intl`. Strings are never concatenated, and uppercase is never typed into a string. The kit handles script differences, so individual screens don't have to.
8. **Luxury is precision.** Precision here means:
   - a strict 4pt grid;
   - three weights;
   - fixed-width digits;
   - units smaller and muted;
   - identical hairlines;
   - no loading flashes;
   - one motion curve and one haptic vocabulary;
   - copy with no wasted word.

   White space is the only material.

---

## 2. Color

### 2.1 Primitives

These are the only hex values allowed anywhere, Swift included. They live in `src/vector/tokens.json`, and generated code carries them everywhere else. App code never writes a hex value.

| family | values |
|---|---|
| ink (light → dark) | `#FFFFFF` `#F7F9FA` `#F1F5F7` `#E9EEF1` `#D9E1E6` `#AAB5BC` `#7A8791` `#5F6D78` `#4E5D68` `#3E4D57` `#15212B` · dark structure `#F3F6F7` `#C8D1D6` `#93A0A8` `#8A979F` `#687B86` `#40515B` `#263640` `#1B2931` `#15232C` `#111D25` `#0D171E` `#071017` · `#000000` (on-signal under Increase Contrast only) |
| cyan | **signal `#22D3EE`** · ink `#007088` · ink HC `#00566B` · night HC `#A5F3FC` · soft `#ECFEFF` / `#083344` · soft-fg night `#67E8F9` · single-hex fallback `#0891B2` |
| status light | success `#177245` · warning `#8A6212` · danger `#9F3039` · softs `#EEF8F1` `#FFF7E6` `#FDF2F3` · HC `#0F5E37` `#6B4700` `#8A1F28` |
| status dark | success `#5AD58A` · warning `#D9A441` · danger `#F08A93` · softs `#0E2418` `#2A2212` `#2E171B` · HC `#8BEBBE` `#F6D27F` `#FFC9CE` |

HeroUI-derived colours are computed from these, not primitives. The pressed signal is `--color-accent-hover` (≈`#1FC0D9`: Uniwind lerps 90% `#22D3EE` + 10% `#071017` in sRGB), used as `bg-accent-hover`, never as a hex. The kit overrides two derived keys (§2.2).

These colors are removed:

- lift effort red, orange and green;
- water's 24 favourite hues and the watch `Palette`;
- macro's orange, amber and green macros;
- the Gemini gradient;
- the unused `--chart-calories/protein/fat/carbs` tokens;
- Android `colorPrimary #023C69`, which becomes `#007088`.

### 2.2 Semantic tokens (every HeroUI variable plus Vector extras)

Values are in `tokens.css` (`@layer theme :root { @variant light | dark }`). A `→` means the token references another one and follows it, including under Increase Contrast.

| token | light | dark | use |
|---|---|---|---|
| `--background` | `#FFFFFF` | `#071017` | canvas |
| `--foreground` | `#15212B` | `#F3F6F7` | text |
| `--surface` | `#FFFFFF` | `#0D171E` | Panel (white on white, separated by a 1pt border) |
| `--surface-secondary` | `#F7F9FA` | `#111D25` | pressed rows, table header band |
| `--surface-tertiary` | `#F1F5F7` | `#15232C` | meter tracks, swipe panels, skeletons |
| `--overlay` | `#FFFFFF` | `#111D25` | Menu, Select, Popover, Dialog, Toast, always with a 1pt border |
| `--backdrop` | `rgba(7,16,23,.24)` | `rgba(0,0,0,.5)` | dialog scrim |
| `--muted` | `#5F6D78` | `#93A0A8` | secondary text, placeholders, axis ticks |
| `--default` | `#F1F5F7` | `#15232C` | HeroUI default fills. The kit never shows a grey button. |
| `--accent` | **`#22D3EE`** | **`#22D3EE`** | signal fill |
| `--accent-foreground` | `#071017` | `#071017` | content on signal |
| `--accent-soft` / `-foreground` | `#ECFEFF` / `#007088` | `#083344` / `#67E8F9` | only as the picked row in a picker list |
| `--field-background` | `#FFFFFF` | `#0D171E` | |
| `--field-border` | `#7A8791` | `#687B86` | control edge, at least 3:1 on every surface |
| `--field-placeholder` | → muted | → muted | never used as a label |
| `--success` / `-foreground` / `-soft` | `#177245` / `#FFF` / `#EEF8F1` | `#5AD58A` / `#071017` / `#0E2418` | |
| `--warning` / `-foreground` / `-soft` | `#8A6212` / `#FFF` / `#FFF7E6` | `#D9A441` / `#071017` / `#2A2212` | |
| `--danger` / `-foreground` / `-soft` | `#9F3039` / `#FFF` / `#FDF2F3` | `#F08A93` / `#071017` / `#2E171B` | |
| `--*-soft-foreground` | → status | → status | |
| `--segment` / `-foreground` | → accent / → accent-foreground | same | Pro Segment selection looks like the icon. It is the signal under another name, so app code never paints it (`bg-segment` counts under the `accent` rule, §11): a selected app cell is a SignalCell. HeroUI Tabs are banned (`raw-heroui`, no baseline): every Tabs variant colours its selected label with `--segment-foreground`, which is invisible on the dark `secondary` underline tabs (1.00:1). |
| `--border` | `#D9E1E6` | `#263640` | panel outlines (decorative containment) |
| `--separator` | `#E9EEF1` | `#1B2931` | rules inside panels, chart grid |
| `--focus`, `--link` | → tint | → tint | |
| `--surface-shadow`, `--field-shadow` | `none` | `none` | |
| `--overlay-shadow` | `0 16px 48px rgba(20,40,50,.14)` | `0 16px 48px rgba(0,0,0,.5)` | overlays only |
| **`--tint`** | `#007088` | `#22D3EE` | text-safe cyan: links, native tint, chart subject line, focus |
| `--tint-foreground` | `#FFFFFF` | `#071017` | content on a tint fill |
| `--foreground-secondary` | `#3E4D57` | `#C8D1D6` | field labels, table headers |
| `--border-strong` | `#7A8791` | `#687B86` | any line that identifies a control or state |
| `--cat-1` / `-2` / `-3` | → foreground / `#4E5D68` / → border-strong | → foreground / `#AAB5BC` / → border-strong | categories (P · C · F) |
| `--chart-1…5` | → tint, muted, foreground-secondary, separator, warning | same | subject, reference, target, grid, over. Overrides Pro's accent ramp. |

Static values in `@theme`:

- `--border-width: 1px`
- `--field-border-width: 1px`
- `--opacity-disabled: 0.4`

HeroUI still computes its derived tokens (`-hover`, `default-soft`, `border-secondary`, and so on). `--color-field-border-focus` maps to `--focus`. The kit's `@theme inline static` block (static, like HeroUI's own, so `useThemeColor('tint')` and `useCSSVariable('--color-tint')` resolve at runtime) overrides two derived keys, because Uniwind's `colorMix` lerps in sRGB and ignores HeroUI's second weight:

- `--color-warning-hover: color-mix(in oklab, var(--warning) 90%, black)`: a white label on it is 6.44:1 in light (HeroUI's mix would give `#96722A`, 4.43:1) and `#071017` is 6.95:1 in dark;
- `--color-field-hover: var(--surface-secondary)`: muted text 5.04:1 (HeroUI's mix would give `#E8E9EA`, 4.38:1).

### 2.3 Contrast (WCAG 2.x, computed)

**Light**

| text or mark | `#FFFFFF` | `#F7F9FA` | `#F1F5F7` | `#ECFEFF` |
|---|---|---|---|---|
| foreground `#15212B` | 16.35 | 15.48 | 14.91 | 15.72 |
| foreground-secondary `#3E4D57` | 8.74 | 8.27 | 7.96 | 8.40 |
| muted `#5F6D78` | 5.32 | 5.04 | 4.85 | 5.12 |
| tint `#007088` | 5.72 | 5.41 | 5.21 | 5.50 |
| success `#177245` | 5.95 | 5.63 | 5.42 | 5.72 |
| warning `#8A6212` | 5.47 | 5.18 | 4.99 | 5.26 |
| danger `#9F3039` | 7.10 | 6.73 | 6.48 | 6.83 |
| border-strong / field-border `#7A8791` (UI) | 3.68 | 3.49 | 3.36 | 3.54 |
| cat-2 `#4E5D68` (UI) | 6.80 | 6.44 | 6.20 | 6.53 |
| border `#D9E1E6` / separator `#E9EEF1` (decorative only) | 1.32 / 1.17 | | | |
| **signal `#22D3EE` (fill only)** | **1.81** | 1.71 | 1.65 | 1.74 |

**Dark**

| text or mark | `#071017` | `#0D171E` | `#111D25` | `#15232C` | `#083344` |
|---|---|---|---|---|---|
| foreground `#F3F6F7` | 17.65 | 16.69 | 15.77 | 14.78 | 12.34 |
| foreground-secondary `#C8D1D6` | 12.37 | 11.69 | 11.05 | 10.35 | 8.64 |
| muted `#93A0A8` | 7.15 | 6.76 | 6.39 | 5.99 | 5.00 |
| tint `#22D3EE` | 10.61 | 10.03 | 9.48 | 8.88 | 7.41 |
| accent-soft-fg `#67E8F9` | 13.22 | 12.51 | 11.81 | 11.07 | 9.24 |
| success / warning / danger | 10.33 / 8.52 / 8.00 | 9.77 / 8.06 / 7.56 | 9.23 / 7.61 / 7.14 | 8.65 / 7.13 / 6.70 | |
| border-strong / field-border `#687B86` (UI) | 4.35 | 4.11 | 3.89 | 3.64 | 3.04 |
| cat-2 `#AAB5BC` | 9.17 | 8.67 | 8.19 | | |

**Fill pairs**

| pair | ratio |
|---|---|
| `#071017` on signal (primary, selected, switch-on, live), both modes | **10.61** |
| `#000000` on signal (Increase Contrast) | 11.62 |
| `#071017` on pressed signal = `--color-accent-hover` (HeroUI-derived ≈`#1FC0D9`, not a primitive) | 8.76 |
| white on success / warning / danger (light) | 5.95 / 5.47 / 7.10 |
| white on `--color-warning-hover` (light) / `#071017` on it (dark) | 6.44 / 6.95 |
| status on its soft (light) | 5.48 / 5.13 / 6.49 |
| `#071017` on success / warning / danger (dark) | 10.33 / 8.52 / 8.00 |
| status on its soft (dark) | 8.81 / 6.99 / 6.98 |
| white on tint `#007088` | 5.72 |
| tint on signal (meter tick option) / foreground tick on signal | 3.16 / 9.05 (light). Dark: the `#F3F6F7` tick is 1.66 on signal, which is redundant because fill vs track is 8.88 there |
| watch: `#22D3EE` on black / `#93A0A8` on black | 11.62 / 7.83 |
| single-hex `#0891B2` on white / on `#071017` (fallback only, §8.4) | 3.68 / 5.21 |
| tint ring on accent-soft (Pro Timeline current): light / dark / HC light / HC dark | 5.50 / 7.41 / 7.94 / 10.74 |

### 2.4 Brand cyan vs ink cyan

| `#22D3EE` allowed | never |
|---|---|
| primary Button fill with `#071017` label and glyph | text or glyph in `#22D3EE` on a light surface (1.81:1) |
| selected Choices cell, ChipRow chip, SignalCell or Calendar day with `#071017` content **and** a check glyph (a SignalCell without `check` carries the state in its content: a check or play glyph) | white on cyan (1.81:1) |
| Toggle-on track | cyan borders, underlines, rings or chart lines in light mode (use `--tint`). HeroUI's own cyan lines are re-pointed in COMPONENTS: the Pro Timeline `current` ring and the Tabs `secondary` underline use `--tint`. |
| live state: `ScreenFooter tone="live"` strip, Panel `tone="live"` 3pt start rule, Status `live` dot | washes, headers, panel backgrounds, splash-like blocks |
| hero Meter fill, inside a 1pt `border-strong` outline, with an ink index tick | more than one hero meter per screen; category data |
| widget action plate (full colour), Live Activity glyph plate, Dynamic Island glyph | tinting a native `prominent` header item cyan |
| dark mode: also as text, line and tint (10.61:1) | |

**A signal bar at least 3pt wide is a fill** (the Panel `live` start rule, the `ScreenFooter` strip, the meter). A 1–2pt cyan line is banned in light mode; use `--tint`.

**Ink cyan** (`--tint`): links, LinkButton, native tab and header tint, focus rings, the text caret and selection, chart subject line, heatmap hue, and the Live Activity meter on system material.

**Signal budget:**

- **Enforced:** exactly **1** primary per screen. A second `Button variant="primary"` (or `IconButton variant="primary"`) mounting on the same Screen logs a `__DEV__` warning.
- **Guideline:** at most 3 signal fills at rest for actions, live state and the hero meter.
- **Exempt:** selection states (Choices, ChipRow, SignalCell, Toggle, Calendar). A settings screen with four selected Choices and a Health Toggle is fine.

### 2.5 Data and chart palette

| data | rule |
|---|---|
| subject series (weight trend, calories history, volume) | 2pt `chart-1` (tint) line, round joins, no area fill |
| reference, raw points, previous period | `chart-2` (muted) dots r2.5 or a dashed `4 3` line |
| target or goal | 1pt `chart-3` dashed `2 3`, with a label at the end ("GOAL" label + readout). It is not green: a target is a reference. |
| over or out of range | `chart-5` (warning) plus the `over` glyph and text |
| categories (macros, set kinds) | ink ramp `cat-1` protein · `cat-2` carbs · `cat-3` fat, always **P · C · F** order, square segments with 2pt gaps, direct letter + value labels. No hues. |
| calories | the signal hero Meter on Today; a `chart-1` line in history |
| heatmap (lift muscles) | `--tint` at opacity 0.16 / 0.36 / 0.58 / 0.80 / 1.0; empty cells get a 1pt `border` outline; legend reads "LESS ▢▢▢▢▢ MORE" |
| effort (lift) | **EffortMark**: 1, 2 or 3 ascending bars (3pt wide, 6/9/12pt tall, 2pt gap) filled in `foreground`; empty bars have a 1pt `border-strong` outline. No colour. The same mark appears on the watch. |
| water favourites | neutral tiles: drink-kind glyph + name + mono volume. The colour picker is deleted once the owner approves (MIGRATION sign-off); the stored `color` column, `favoriteColor()` and the watch payload field are kept, so the change reverts cheaply. |
| band | `tint` at 10% opacity, flat. No gradients anywhere. |

### 2.6 Status

Status colour appears only with a word or glyph. The mapping:

- `success` means done or engaged;
- `warning` means caution or over target;
- `danger` means failure or destructive;
- `live` means signal.

A status dot is 6pt with a label (`● UP TO DATE · 14:02`). It is never a pill badge and never pulses. Heart rate on the watch keeps system red (the one semantic exception).

### 2.7 Increased contrast

| token | light → HC | dark → HC |
|---|---|---|
| foreground | `#15212B` → `#071017` | `#F3F6F7` → `#FFFFFF` |
| foreground-secondary | `#3E4D57` → `#071017` | `#C8D1D6` → `#FFFFFF` |
| muted | `#5F6D78` → `#3E4D57` (8.74) | `#93A0A8` → `#C8D1D6` (12.37) |
| tint / focus / link / accent-soft-fg | `#007088` → `#00566B` (8.26) | `#22D3EE` → `#A5F3FC` (15.36) |
| border | `#D9E1E6` → `#AAB5BC` | `#263640` → `#40515B` |
| separator | `#E9EEF1` → `#D9E1E6` | `#1B2931` → `#263640` |
| border-strong / field-border | `#7A8791` → `#5F6D78` (5.32) | `#687B86` → `#8A979F` (6.40 on `#071017`; 6.05 on `#0D171E`) |
| success / warning / danger | → `#0F5E37` / `#6B4700` / `#8A1F28` (7.85 / 8.31 / 9.10) | → `#8BEBBE` / `#F6D27F` / `#FFC9CE` (13.44 / 13.18 / 13.23) |
| accent-foreground / segment-foreground | `#071017` → `#000000` | same |
| signal `#22D3EE` | unchanged | unchanged |

**How HC is applied:**

- **Native chrome** (tab tint, header tint, switches) gets it now: `DynamicColorIOS({light, dark, highContrastLight, highContrastDark})` from `src/vector/native.ts`.
- **Swift** gets it now: `UITraitCollection.accessibilityContrast` inside `Color(vector:)`.
- **RN content** swaps at runtime through `Uniwind.updateCSSVariables` behind flag `runtimeContrastSwap`, which is **off** in the shipped default. The base tokens already pass AA everywhere: every text token is at least 4.5:1 and every UI token at least 3:1 on every surface in both modes, accent-soft included (computed from `tokens.json`).

---

## 3. Typography

### 3.1 Families and files

**Shipped default: only the bundled files.** No new font files ship in 1.0.

| `useFonts` key (family string) | file | faces used |
|---|---|---|
| `Inter` | `assets/fonts/Inter.ttf` (variable, `wght` axis; PostScript `Inter-Regular`) | 400, 500, 600 through numeric `fontWeight` |
| `IBMPlexMono` | `assets/fonts/IBMPlexMono-Regular.ttf` | 400 only |

- Every app registers both at runtime with `useFonts({ Inter, IBMPlexMono })`. Water gains the two files (copied byte-identical from the other repos) and loads them for the first time.
- Fonts are **not** embedded through the expo-font config plugin in 1.0: iOS registers the family or PostScript name, but Android registers the file name, and Android is not built in the Phase 1 simulator pass. Embedding comes later.
- **Weights are numbers set by the kit.** Uniwind registers every `--font-*` in `@theme`, so Tailwind's `font-medium` / `font-semibold` / `font-bold` emit only `font-family` (verified by compile). Kit `Text` sets `fontWeight` itself. `tokens.css` sets explicit weights on HeroUI slots such as `.button__label` (500) and `.card__label` (600). App code never uses `font-*` weight utilities.
- **Substitutions in the shipped default:** Inter Display → Inter 600; Plex Mono Light and Medium → Plex Mono Regular.
- **Device check:** does iOS or Android apply variable-instance weights (500/600) to `Inter.ttf`? If not, the fallback is the optional static faces below. The layout already holds without weight contrast, because hierarchy also comes from size and colour.

**Optional upgrades.** The owner supplies these files, and switching them on is one `fonts.families` edit in `tokens.json` plus a kit bump:

- static `Inter-Regular`, `Inter-Medium`, `Inter-SemiBold` and `Inter-Bold`;
- `IBMPlexMono-Light` (hero numeral 56/60);
- `IBMPlexMono-Medium`;
- IBM Plex Sans Arabic and Hebrew, when an RTL locale ships.

Native surfaces use **SF** for words and **SF Mono with `.monospacedDigit()`** for readouts (`VectorFont`). They bundle no fonts.

### 3.2 Scale

Sizes are pt at the default Dynamic Type size. Tracking is in em (the kit converts it to points). `cap` is `maxFontSizeMultiplier`. `ramp` is the iOS `dynamicTypeRamp`.

| role (`Text variant=`) | family | size/line | weight | tracking | case | cap | ramp | use |
|---|---|---|---|---|---|---|---|---|
| `display` | Inter | 40/44 | 600 | −0.03 | sentence | 1.3 | largeTitle | wordmark only (onboarding, About) |
| `readoutXL` | Plex Mono | 48/52 | 400 | −0.02 | — | 1.25 | largeTitle | the one hero value per screen |
| `h1` | Inter | 28/34 | 600 | −0.02 | sentence | 1.6 | title1 | tab-root title |
| `h2` | Inter | 22/28 | 600 | −0.01 | sentence | 1.6 | title2 | Editor title |
| `h3` | Inter | 17/22 | 600 | 0 | sentence | 1.6 | headline | panel title, section heading |
| `h4` | Inter | 15/20 | 500 | 0 | sentence | 1.8 | subheadline | group title |
| `body` | Inter | 16/24 | 400 | 0 | | 2.0 | body | default |
| `bodyStrong` | Inter | 16/24 | 500 | 0 | | 2.0 | body | row titles |
| `small` | Inter | 14/20 | 400 | 0 | | 2.0 | subheadline | notes, descriptions (muted) |
| `caption` | Inter | 12/16 | 400 | 0 | | 2.0 | caption1 | hints, footnotes |
| `fieldLabel` | Inter | 14/20 | 500 | 0 | sentence | 1.8 | subheadline | the label above every Field |
| `label` | Plex Mono | 11/16 | 400 | +0.08 | UPPERCASE (cased scripts only) | 1.8 | caption2 | eyebrows, table headers, status words, panel meta |
| `readoutL` | Plex Mono | 34/40 | 400 | −0.01 | — | 1.4 | largeTitle | stat tiles, rest clock |
| `readoutM` | Plex Mono | 22/28 | 400 | 0 | — | 1.6 | title2 | secondary stats |
| `readoutS` | Plex Mono | 16/24 | 400 | 0 | — | 2.0 | body | list values, numeric inputs, set rows |
| `readoutXS` | Plex Mono | 12/16 | 400 | 0 | — | 2.0 (1.3 in charts) | caption1 | timestamps, axis ticks, meta |
| Button label | Inter | 15/20 | 500 | 0 | sentence | 1.6 | | |

Tailwind sizes in `@theme` (read by HeroUI slots):

| class | size/line |
|---|---|
| `xs` | 12/16 |
| `sm` | 14/20 |
| `base` | 16/24 |
| `lg` | 17/22 |
| `xl` | 20/26 |
| `2xl` | 22/28 |
| `3xl` | 28/34 |
| `4xl` | 34/40 |
| `5xl` | 48/52 |

`--tracking-tight` is 0 (script-safe) and `--tracking-label` is 0.08em. App code never writes size, `uppercase` or `tracking-*` classes.

**Units** are set at about 45% of the value size in `muted`, as a separate run from `Intl` parts. The locale decides the order and spacing. Units are sans (Inter), and the digits are mono.

### 3.3 Mono or sans

| Plex Mono | Inter |
|---|---|
| numbers with units, counts, percentages, times, durations, numeric dates in data, IDs, versions, eyebrows, table headers, status words, numeric input text | titles, body, buttons, row titles, errors, notifications, empty-state sentences, anything with a verb, units, month names |

- `Value` runs **`isMonoSafe(s)`** (`/^[\d\s.,:;%+\-−–/()'  ]+$/`) on its formatted output. It uses Plex Mono only when the string passes, and otherwise falls back to Inter with `tabular-nums`. That fallback covers dates with ideographs ("3月12日"), locale letters, and future Arabic-Indic digits, with no special cases.
- A number inside a sentence stays Inter. Any number that updates live or aligns in a column must be a `Value`.

### 3.4 Script-aware rules

The script class comes from the active app language (`scriptOf(language)`), never from sniffing strings.

| class | languages | rules |
|---|---|---|
| `cased` | en es fr de it pt nl sv (and future Latin, Cyrillic, Greek) | as §3.2 |
| `cjk` | ja ko zh | `label` becomes sans 12/18 500 with no uppercase and 0 tracking. Titles use 0 tracking. Sans line height is at least 1.6× size (body 16/26, small 14/22, caption 12/19). The family stays Inter with system CJK fallback; explicit Hiragino Sans / PingFang SC / Apple SD Gothic Neo waits behind flag `cjkSystemFamilies` (off). |
| `arabic` (future ar/fa/ur) | | no uppercase, **0 tracking everywhere** (letter-spacing breaks joining), line heights ×1.15. Readouts fall back to sans automatically (isMonoSafe). Plex Sans Arabic is an optional face. |
| `hebrew` (future he) | | no uppercase, 0 tracking on labels. Plex Sans Hebrew is an optional face. |

Uppercase is only ever `textTransform` applied by the kit for `cased`. Translation files never contain words in capitals.

### 3.5 Dynamic Type

- Every app passes `<HeroUINativeProvider config={vectorHeroConfig}>` with `textProps.maxFontSizeMultiplier: 2` and `textInputProps: 1.6`.
- Kit `Text` applies the per-role `cap` and `dynamicTypeRamp` itself, because RN Text doesn't read the provider.
- At accessibility sizes (`fontScale ≥ 1.6`, `useKit().largeType`):
  - ListRow stacks the value under the title;
  - Choices with more than 3 options becomes a Select;
  - Panel headers stack;
  - chart ticks stay capped at 1.3.
- Nothing has a fixed height except marks. Buttons are `min-h-11 h-auto`, so labels wrap. `fit` (one line, `minimumFontScale 0.8`, cap 1.3) is only for genuinely fixed slots such as the dock strip.
- Icons scale: size × `min(fontScale, 1.5)`.
- Banned in app code: `allowFontScaling={false}` and `numberOfLines` on content text. `vector-kit check` counts both (`scale`, `lines`). `lines` skips `numberOfLines={0}` and Label (an eyebrow is one line by design) and counts props objects spread into Text (`fitted = { numberOfLines: 1, … }`); a genuinely fixed slot (a dock strip, a grid cell that shrinks before it clips) is baselined in `vector.allow.json` with its reason.

### 3.6 Bold Text

`VectorProvider` reads `AccessibilityInfo.isBoldTextEnabled()` and listens for `boldTextChanged`. When it is on, every Inter role steps up 100 (400→500, 500→600, 600→700). Mono stays 400 because only Regular ships. On native surfaces SF handles Bold Text itself.

---

## 4. Space, size, shape

### 4.1 Spacing (base 4pt, Tailwind `--spacing` unchanged)

The scale is 0, 2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64.

| token | value |
|---|---|
| screen gutter | 16 (<600pt wide), 24 (600–1023), 32 (≥1024) |
| section gap | 24 |
| stack gap | 16 form fields · 12 inside a panel · 8 label→control and eyebrow→content |
| panel padding | 16 (24 at ≥600) |
| row padding | 12 vertical · 16 horizontal |
| icon ↔ text | 8 |
| screen header | 16 top, title→subtitle 4, header→rule 16, rule→first section 24 |

### 4.2 Widths

| width | used for |
|---|---|
| `form` 640 | settings, editors, sheets |
| `data` 1040 | dashboards and history. At ≥900pt this becomes a 2-column panel grid with a 24 gap. |

### 4.3 Control sizes (no interactive element under 44pt)

| control | visual height |
|---|---|
| Button md | 44 |
| Button lg (pinned footer primary) | 52 |
| IconButton | 44×44 |
| Field, Select trigger, SearchInput, DateInput | 44 min; multiline 88 min |
| Choices | 44 |
| ListRow | 44 (56 with a description) |
| Menu and Select items | 44 min (set in the COMPONENTS block) |
| Toggle | native UISwitch or Material switch; the row is the target |
| Slider thumb | 22 visual + `hitSlop` 11 |
| **Exception 1:** chart range chips (`Choices size="sm" mono`) in a chart header | 36 + `hitSlop` 4 |
| **Exception 2:** `ChipRow` cells in a horizontal filter scroller | 36 + `hitSlop` 4 |

### 4.4 Radius: one value, flattened

The HeroUI ramp is flat, so nothing HeroUI draws from the ramp can become a pill (3xl = 4, below half of any control height). The remaining hard-coded HeroUI `9999px` shapes are the radio indicator and thumb (body and water RadioGroup, replaced by Choices in Phase 1), `.avatar__fallback-container`, and the input-otp caret and separator, besides the allowed ripple and calendar dot. This works the same on heroui-native 1.0.8 and 1.0.9.

| token | px | HeroUI puts it on |
|---|---|---|
| `--radius` | 4 | base |
| `--radius-xs` | 1 | hairline marks |
| `--radius-sm` | 2 | marks |
| `--radius-md` … `--radius-4xl` | 4 | Button sm/md/lg, Card/Surface, Dialog, Popover, Menu, Select, Toast, Alert, Tabs, Chip, Calendar cell, BottomSheet, Avatar |
| `--field-radius` | 4 | Input, TextField, Select trigger, InputOTP |
| `--radius-mark` / `--radius-control` / `--radius-panel` | 2 / 4 / 4 | **the only radius utilities app code may use**: `rounded-mark`, `rounded-control`, `rounded-panel` |

**Hard-coded HeroUI shapes, overridden in the COMPONENTS block** (slot names confirmed in `node_modules` for both versions; plain rules, not wrapped in `@layer`, so they win by source order in any renderer and resolve identically on native):

- `.switch__root` → 4 and `.switch__thumb` → 2 (the kit uses the native switch, so this is only a safety net);
- `.slider__track`, `__track-background`, `__fill`, `__thumb-container`, `__thumb-knob` → 2;
- `.checkbox__root` → 2;
- Pro `.segment__item--size-lg` and `.segment__indicator--size-lg` → 4.

**Exhaustive table of allowed shapes that aren't 4pt:**

| shape | where | owner |
|---|---|---|
| 2pt | marks: meter track and fill, ticks, chart bars, heatmap cells, legend swatches, skeleton, slider, checkbox, EffortMark (1pt corners) | Vector |
| circle | 6pt status dot; Calendar `cell-indicator` dot; chart points; Android ripple | Vector / HeroUI |
| capsule | tab bar, nav-bar items, sheet grabber, native UISwitch, watch system buttons, watch floating undo, watch fill buttons (`VectorFillButtonStyle`), watch effort capsules | Apple |
| concentric / system sheet radius | sheets (never set `sheetCornerRadius`), alerts, context menus, BottomAccessory | Apple |
| `ContainerRelativeShape()` | widget and Live Activity plates | Apple geometry |
| `.buttonBorderShape(.roundedRectangle)` | interactive watch tiles (water favourites) | Apple |
| 1pt keyline | photo thumbnails (white photos on the white canvas) | Vector |

Nothing Vector draws touches a system corner. Sheet headers hold only text, and the first bordered element starts below them, inset by the gutter.

### 4.5 Borders

- **1pt:** panels, fields, Choices, meter outline, overlays, and rules inside panels.
- **2pt:** focus ring (`tint`, offset 2), Callout start rule, chart series and target ticks.
- **3pt:** Panel `tone="live"` start rule (a signal fill, §2.4).

There are no 0.33pt hairlines; they vanish on 1x Android.

### 4.6 Elevation: none

Content never casts a shadow. `--overlay-shadow` exists only for HeroUI overlays, always together with a 1pt `border`. There are no floating cards and no fake glass in the content layer.

---

## 5. Components

Everything is imported from `@/vector`. HeroUI supplies behaviour and accessibility; the kit supplies the look. Components take **semantic props only**: callers never pass a hex, a size class or a radius. Full TypeScript signatures are in `KIT.md §6`; props added after 1.1.0 are listed in the tables below and in the changelog.

**Provider order** (every app's `src/app/_layout.tsx`; KIT.md §5 shows the same):

```tsx
<GestureHandlerRootView style={{ flex: 1 }}>
  <StoreProvider /* water: DatabaseProvider + AppProvider */>
    <VectorAdapter>
      <HeroUINativeProvider config={vectorHeroConfig}>
        <NavigationTheme>
          <Stack …/>
        </NavigationTheme>
        <StatusBar style="auto" />
      </HeroUINativeProvider>
    </VectorAdapter>
  </StoreProvider>
</GestureHandlerRootView>
```

`VectorAdapter` sits **outside** `HeroUINativeProvider`: HeroUI renders menus, selects, date dialogs and toasts at a portal host beside its own children, so anything drawn there must already be inside the kit. Kit components also re-provide the kit inside their own HeroUI portals (ActionMenu, Select, DateInput, TimeInput), so they no longer throw with the providers reversed, but app content in a HeroUI Popover or Dialog still needs this order. A pre-store fatal screen (lift's MigrationError) nests `VectorProvider` outside `HeroUINativeProvider` the same way.

### 5.1 Scaffold

| component | purpose · anatomy · states | do / don't |
|---|---|---|
| **Screen** `{title, eyebrow?, subtitle?, action?, header?, footer?, width?, scroll?, nativeHeader?, compact?, loading?, scrollRef?, refreshControl?}` | Tab roots: `SafeAreaView edges={['top']}` (flag `scrollUnderStatusBar` off), then **the ScrollView as first descendant** (`contentInsetAdjustmentBehavior="automatic"`), then a centred column, then the ScreenHeader (optional eyebrow `label`, `h1` title, subtitle `small` muted, one trailing action, 1pt `border` rule). On tab roots the eyebrow is optional and only carries live context in mono (the date on Today, the range on Progress), never a restatement of the title. `header` renders inside the ScrollView (`stickyHeaderIndices=[0]`). `footer` is **docked** (below). `nativeHeader` drops the in-content title for pushed screens. `loading` shows skeleton rows after 300ms. `scroll={false}` is a static column: it always clears the status bar, and on iOS tab roots without a dock it pads by the bottom inset so the floating tab bar never covers it. The static column fills the height left under the title (`flex: 1`, `minHeight: 0`), so a `flex-1` child (water Today's favourite grid) takes the rest and the docked strip and Undo still show below it. Keyboard: iOS insets the ScrollView natively (`automaticallyAdjustKeyboardInsets`); on Android (edge to edge, no window resize) the Screen sits in a `KeyboardAvoidingView behavior="height"`, so the column and dock shrink above the keyboard. | Do keep one trailing action. Don't render content before the ScrollView (it breaks iOS 26 scroll-edge detection). |
| **DetailScreen** `{title, action?: {icon, accessibilityLabel, onPress, disabled?, prominent?}, menu?: {accessibilityLabel, sections}, children, scroll?, footer?, compact?}` | A pushed screen: `Stack.Screen options={detailHeaderOptions(...)}` (§6.2) plus Screen `nativeHeader`. `footer` docks a ScreenFooter at the bottom edge (lift's live rest strip, the session preview's Start) and `compact` is Screen's tighter rhythm, so no app rebuilds the header mapping around Screen. On iOS `action` and `menu` become native bar items (`unstable_headerRightItems`: a button and a `more` menu), so iOS 26 hosts them in its own glass; on Android they render as a kit IconButton and ActionMenu in `headerRight`. | Don't add an in-content title. Don't pass a custom view: a kit IconButton inside the iOS 26 bar capsule nests a 4pt rectangle in a system corner (§1.4). |
| **ScreenFooter** `{children, tone?: 'default'\|'live'}` | Docked, non-floating bar: `bg-surface`, 1pt top `border`, content max 560, one `lg` primary (plus an optional ghost at start). `tone="live"` is a full-bleed signal strip with `#071017` content, e.g. `REST 01:32   Skip`. | One live strip at a time. |
| **Dock** (Screen `footer` / `useDock`) | Tab-screen tools (macro quick log, lift start). Shipped default: a docked 56pt strip above the tab bar on every platform. Flag `bottomAccessoryDock` is reserved for hosting it in `NativeTabs.BottomAccessory` on iOS 26 after a device check; it is **not wired in 1.0.0** (the accessory is a child of the app-owned `<NativeTabs>`), so flipping it changes nothing until a kit minor adds the slot. On glass, text uses `PlatformColor('label')` / `('secondaryLabel')`. | No floating pills or shadows (macro's quick-log pill goes away). |
| **useUndo()** `show({message, onUndo, durationMs?, undoneMessage?})`, `dismiss()` | Inside a `DockProvider` the Undo strip (a default ScreenFooter) **stacks above** the dock or the screen's `footer` for 6s, so live controls (a rest strip, Save, the quick-log bar) never disappear. Outside one it falls back to a HeroUI Toast (`overlay`, 1pt border, radius 4) at the **top** edge: the root toast host knows nothing of the tab bar, a docked footer or the keyboard, and the top is always clear of them. It stays while a screen reader runs and is announced on **both** platforms, once: the strip through `announceForAccessibility` (it is not also a live region, so TalkBack says it once); the toast through `announceForAccessibility` on iOS only, since HeroUI's toast root (`role="status"`, `aria-live="polite"`) is already an Android live region. A new `show` makes the previous action final. `undoneMessage` is spoken, not shown, after Undo runs ("Log undone"). `useScreenReader()` (exported) is the live VoiceOver / TalkBack state the kit uses for these rules. | Don't use a toast for an event that has no action. For a docked Undo, wrap `(tabs)/_layout` in `DockProvider` (or the root `<Stack>`, so pushed screens such as lift's workout dock it above their footer too) and use the kit Screen, static or scrolling. |
| **Panel** `{tone?: 'default'\|'live'\|'critical', inset?: 'md'\|'none', onPress?, accessibilityLabel?, accessibilityHint?}` + `.Header {eyebrow, meta?, title?, action?, wrap?}` `.Title` `.Description` `.Body` `.Footer` | `bg-surface border border-border rounded-panel p-4 gap-3`, no shadow. The Header puts the eyebrow at start and meta (`readoutXS` muted) at end, over a full-bleed 1pt `separator`; without a title the eyebrow is the panel's accessibility heading. Header `action` is one 44pt IconButton or ActionMenu at the end of the eyebrow row; it overhangs into the panel padding (`-my-3 -me-3`), so the row keeps its text height and the glyph lines up with the content edge. Header `wrap` lets a long translated eyebrow wrap instead of ending in an ellipsis (§9.3 still asks for ≤ 3 words). A pressable panel takes `accessibilityHint` ("Edits your program"). In a row panel the Header is not counted as a row, so the first row draws no second rule under it. `live` adds a 3pt signal start rule. `critical` gives a danger border and a danger eyebrow. Pressed is `surface-secondary`. `inset="none"` is for row lists. | Always use `.Body`. No tinted, "hero" or grey panels. |

### 5.2 Text

| component | spec |
|---|---|
| **Text** `{variant?: RoleName, tone?: 'default'\|'secondary'\|'muted'\|'tint'\|'success'\|'warning'\|'danger'\|'onSignal'}` | The only Text in app code. It resolves the §3.2 role for the script, applies cap, ramp, Bold Text and `text-left` (which means start). The prop is named `variant` because RN Text already has an ARIA `role`. Inside a selected SignalCell, Text (and so Value, Label, Heading, Note) and Icon draw signal ink whatever `tone` or text class they are given. |
| **Heading** `{level: 1\|2\|3\|4}` | `h1`–`h4` with `accessibilityRole="header"`. It replaces ad hoc `text-xl font-semibold` and heading-style labels. |
| **Note** `{tone?}` | `small` muted. It replaces `text-sm text-muted` (72× lift, 85× macro). |
| **Label** `{numberOfLines?}` | `label` role, muted, one line by default; `numberOfLines={0}` (or 2) lets a long translation wrap where the slot can grow (Panel.Header `wrap` does this for eyebrows). **Only for** eyebrows, table headers, status words and panel meta. It is never a section heading: lift's 64 SystemLabel headings become Heading 3 or SettingsSection eyebrows. |
| **Value** `{value: string, unit?, unitFirst?, space?, size?: 'xl'\|'l'\|'m'\|'s'\|'xs', tone?, pulseKey?}` | Readout roles. Spread `useKitFormat().unitParts(...)` into it: `space` is the locale's value–unit spacing (none in ko `72.5mL` or zh `2升`; a no-break space when Intl gives none or a plain space, so a unit never wraps away from its number). `isMonoSafe` picks the family. `pulseKey` runs the signal pulse (§7). It is **the only way to show a measured number.** Negative values arrive from `format` with the typographic minus (U+2212); Value renders the string it is given. |
| **Meta** `{items: string[]}` | Facets separated by a drawn 3pt dot View, never a typed `' · '`. VoiceOver reads the facets as a list. |

### 5.3 Actions

| component | spec | do / don't |
|---|---|---|
| **Button** `{variant?: 'primary'\|'secondary'\|'ghost'\|'destructive', size?: 'md'\|'lg', icon?, iconPosition?, fit?, loading?, loadingLabel?, disabled?, onPress, children: string}` + pass-through `accessibilityLabel/Hint/Role/State/Value`, `hitSlop`, `onLongPress` | See the variant rows below. **Shared:** radius 4, px-4 (lg px-5), `min-h-11 h-auto`, Inter 500 15/20 (set on `.button__label--size-md/lg`, which is where HeroUI's size lives), icon 17 in the variant colour. Press is a colour or opacity change only (`feedbackVariant="none"`, no scale). Focus is a 2pt `tint` outline. Disabled is 0.4 opacity. Loading disables the button and swaps the label for `loadingLabel ?? strings.processing`, with no spinner. `buttonLook(variant, {size?, onSignal?})` and `iconButtonLook(variant, {tone?, onSignal?})` return this look as data (`variant`, `feedbackVariant`, `className`, `labelClassName`, `iconTone`) for a migration shim's HeroUI fallback path, so shims never copy the classes. | Labels are verb + object in sentence case. One primary per screen. |
| ↳ `primary` | signal fill, `#071017` label; pressed `bg-accent-hover` (HeroUI-derived ≈`#1FC0D9`, 8.76:1). | |
| ↳ `secondary` | `surface` fill with a 1pt `border-strong` edge. | Never a grey fill. |
| ↳ `ghost` | `tint` label, pressed `surface-secondary`. | |
| ↳ `destructive` | `danger` label, no fill: delete at the end of an Editor, "Erase all data". | |
| **IconButton** `{icon, accessibilityLabel (required), variant?: 'ghost'\|'secondary'\|'primary'}` + the same pass-through props | 44×44 square, radius 4. `ghost` is a 20pt glyph in `foreground` (or `tint` when it is the screen's action). `secondary` has a 1pt `border-strong` edge. `primary` is a signal square with a `#071017` glyph (counts as the primary). | Round icon buttons belong to the system. |
| **LinkButton** `{icon?, onPress, accessibilityRole?: 'button'\|'link', accessibilityLabel?, accessibilityHint?, accessibilityState?, disabled?, children}` | Inline text action in `tint` 15/20 500, optional trailing `forward` glyph (mirrors). Pressed opacity 0.6. `accessibilityRole="link"` when it leaves the app (a cited source, a web page); `accessibilityLabel` when the words need context ("Back to today"); `accessibilityState` merges with `disabled` (e.g. `{expanded}` on a Why? / Less toggle). | It replaces the ghost-link idioms. |
| **ActionMenu** `{accessibilityLabel, sections: {title?, actions: MenuAction[]}[], trigger?}` | HeroUI Menu popover, `placement="bottom" align="end"` (RTL-safe), `overlay`, 1pt border, radius 4. Width is `clamp(200, content, min(320, window − 32))`. Items are 44, with a leading glyph 17 muted, a trailing check in `tint` for `selected`, and destructive items last in `danger`. | Every row action also exists here and as an `accessibilityAction`. |
| **SwipeRow** `{leadingAction?, trailingAction?, enabled?, ref?}` (`SwipeAction = {label, icon, onAction(close), destructive?}`) | Replaces `swipeLeft`/`swipeRight`. It flips under RTL: trailing is revealed by swiping toward start. Destructive panels are `danger` with a `danger-foreground` label and glyph (white 7.10:1 light; `#071017` 8.00:1 dark; HC 9.10 / 13.23); others are `surface-tertiary`. The threshold is 72 with a `commit` haptic. A destructive swipe calls the app's delete handler: `useUndo` where the store can restore (macro food, lift set), otherwise the existing confirm until undo lands (L4). A destructive row stays open expecting to disappear, so `onAction(close)` receives `close`: call it when the row stays (a cancelled confirm). `ref` (`SwipeRowHandle`) exposes the same `close()`. | |

### 5.4 Icon

**Icon** `{name: IconName, size?: 12|16|17|20|24, tone?: 'foreground'|'muted'|'tint'|'onSignal'|'danger'|'warning'|'success'}`. 12 is the Choices check slot, 17 the Button and ActionMenu glyph, 20 the default. The registry is `src/vector/icons.ts` (`{sf, md, ion, mirrors}` per semantic key) and it is the only place glyph names exist.

- **Shipped renderer:** `@expo/vector-icons` Ionicons (installed in all four).
- **Optional adapter:** the app passes `renderIcon` to render `expo-symbols` `SymbolView` with `{sf, md}` where that package is installed (lift, macro).
- `mirrors: true` glyphs flip with `scaleX(-1)` when `I18nManager.isRTL`.
- Size × `min(fontScale, 1.5)`.
- Style is outline by default, and filled only for *selected* and *done*. It is never bold.
- No emoji (macro FoodIcon is deleted), no text glyphs used as icons (`✓ ★ › ↑ ½ ●`), and no multicolour marks (the Gemini mark becomes `analysis`).
- Keys added in 1.2.0 for the glyphs the migrations fell back to Ionicons for: `swap`, `link` (superset), `warmUp`, `moveUp` / `moveDown` (reorder; `move` stays "move to"), `repeat`, `tools`, `document`, `travel`, `stop`, `mic`, `copy`, `bookmark`, `today`, `flag`, `options`, `refresh`, `download`, `retake`, `photoLibrary`, `scanText` (a label; `scan` is the barcode), `unselected` (the empty selection circle beside `done`), `scale` and `help`. Their `ion` names are the ones the apps used, so the shims' `resolveIcon` now finds them. `milk` renders a glass (`pint-outline`, `glass_cup`), distinct from `coffee`'s cup in every renderer. A missing glyph is a kit bump, not an Ionicons fallback.

### 5.5 Inputs

| component | spec |
|---|---|
| **Field** `{label, value, onChange, numeric?, unit?, hint?, error?, placeholder?, secure?, multiline?, disabled?, autoFocus?, selectTextOnFocus?, onSubmit?, onDone?, onBlur?, onFocus?, maxLength?, selection?, onSelectionChange?, accessory?, ref?}` | `ref` is the TextInput (focus the next field); `selection` / `onSelectionChange` control the caret, e.g. keeping a prefilled or stepped amount selected so the next key replaces it (macro's amount picker). The label (`fieldLabel`, `foreground-secondary`, sentence case) sits above, never as a placeholder. The input is 44 min, `bg-field`, 1pt `field-border`, radius 4, px-3. `numeric` gives `readoutS` mono with a decimal pad and the `unit` suffix inside the field at the end; the text is parsed with `parseDecimal` (locale decimal, Latin or Arabic-Indic digits) and seeded with `format.editable` (no grouping, so a backspace in "2000" never reads back as 2). The hint is a caption below. An error gives a danger border plus ErrorText. TextInput uses `rtl:text-right`. **HeroUI Input's own base is `ios:outline-transparent ios:focus:outline-accent android:border-transparent android:focus:border-accent` with `selectionColorClassName="accent-accent"`**: a boundary-less white field on Android (1.0:1), a 1.81:1 cyan focus border, and a 1.81:1 cyan caret and selection on iOS. So Field, SearchInput and the Select trigger always pass `className="border border-field-border android:border android:border-field-border ios:focus:outline-focus android:focus:border-focus"` and `selectionColorClassName="accent-tint"`; HeroUI's `cn` (tailwind-merge) resolves the conflicts. Focus is then a 2pt `tint` outline on iOS and a `tint` border on Android. Raw HeroUI `Input`, `TextField`, `TextArea`, `SearchField` and `InputOTP` in app code are counted by the `raw-heroui` rule. |
| **DateInput / TimeInput** `{label, value, onChange, min?, max?, disabled?, accessibilityLabel?}` (TimeInput also `minuteInterval?`) | `accessibilityLabel` names the control when the visible label needs context (water's per-day reminders: "Wake up, Monday"); the TimeInput trigger reads its time as the value. The trigger looks like a Field, with the value in `readoutS` (sans when not mono-safe). The Pro DateField or DateTimePicker opens as a dialog in the Editor PortalHost. The selected day is a signal fill with a `#071017` number and a 12pt `check` in the cell's top end corner (the §2.4 non-colour cue), and today has a 1pt `tint` outline. The locale comes from `useKitFormat().tag` and the 24-hour setting from expo-localization. TimeInput replaces water's `time-picker.tsx`. |
| **Select** `{title, values, value, onChange, label, showTitle?, disabled?, accessibilityHint?}` | A Field-look trigger with a trailing `down` glyph. Screen readers hear `title` as the name and the current `label(value)` as the value ("Units, Metric"). `showTitle` draws `title` above the trigger as a Field label (a Select in a form; settings rows keep their SettingsSection eyebrow). `disabled` dims it, blocks opening and reports disabled. The HeroUI Select popover is trigger-width, `overlay`, 1pt border, `max-h` = min(400, 60% of the window), with 44 items and a trailing `check`. Use it for more than 4 options (language, units, rest time). |
| **Choices** `{values, value, onChange, label, accessibilityLabel, size?: 'md'\|'sm', mono?, optionLabel?, disabled?}` | The one segmented control. `disabled` dims it, blocks every cell and reports each option as disabled (it carries through to the Select it becomes at large type). It replaces body's underline tabs, lift/macro pills used as a setting, water outline buttons, HeroUI Tabs and RadioGroup. The container has a 1pt `border-strong` edge and radius 4, with 1pt dividers and equal cells. **Selected** is a signal fill, a `#071017` label at 600, and a 12pt `check` in a reserved leading slot (opacity 0 when unselected, so widths never shift). Unselected is `surface` with a `foreground` label at 500. It changes instantly with a `selection` haptic. Roles are `radiogroup` / `radio`. Limit: 4 options (6 when `mono`); more becomes a Select. The limit does not apply to ChipRow. |
| **ChipRow** `{values, value: T \| null, onChange: (v: T \| null) => void, label, accessibilityLabel, groups?, toggle?}`, or `{required: true, value: T, onChange: (v: T) => void, …}`, or `{multiple: true, value: T[], onChange: (v: T[]) => void, required?, …}` | Three modes. **Clearable** (default): single-select or none. **`required`**: single-select that always keeps a choice; tapping the selected chip does nothing, so `onChange` never sees null (macro's amount units). **`multiple`**: any number on at once, `checkbox` chips, the value kept in the chips' order (lift equipment and plates, macro calorie-shift weekdays); with `required` the last chip stays on. Horizontal filter and quick-pick chips: lift's muscle filters (with Favorites as the `toggle` cell) and macro's amount-picker units (`groups=[measures, own]`). A horizontal ScrollView that starts at the start edge and mirrors in RTL. Cells have the `Choices size="sm"` look: 36pt + `hitSlop` 4, radius 4, 1pt `border-strong`, 8 gap; selected = signal fill, `#071017` label, 12pt check slot. Tapping the selected cell clears it (`onChange(null)`), so "none" needs no extra chip. `groups` draws a 1pt `separator` between groups. `toggle` is an independent first cell (role `checkbox`, optional glyph such as `favorite`) followed by a separator. Any number of cells; selection is exempt from the signal budget. |
| **SignalCell** `{selected, onPress?, disabled?, accessibilityLabel, accessibilityHint?, accessibilityRole?: 'button'\|'checkbox'\|'radio', size?: 'md'\|'sm', check?, className?, children?}` · `useSignalInk()` | The one signal-filled cell for app code that is neither a Choices segment nor a ChipRow chip: lift's set-done check, plan-grid next session and effort picker, macro's calorie-shift weekdays. It is the one place the rule "a `#22D3EE` fill always carries `#071017` content" lives, so app code never paints `bg-accent`, `bg-segment` or `bg-accent-hover` itself (`accent` rule, no baseline, §11). **Selected** is a signal fill with a 1pt edge in the same colour (pressed `bg-accent-hover`, 8.76:1) and signal-ink content; **unselected** is `surface` with a 1pt `border-strong` edge (pressed `surface-secondary`) and `foreground` content. Radius 4. `md` is 44pt tall minimum; `sm` is 36pt + `hitSlop` 4 (§4.3). Width is layout: at least the height by default, and a row of seven weekday cells may pass `min-w-0 flex-1`, as Choices cells share their row. A string child gets the Choices label (`h4`, `small` at `sm`; 500, 600 when selected). Any other child is laid out as given, and while the cell is selected every kit Text, Value and Icon in it draws signal ink whatever tone it passes; an app mark drawn in the cell (lift's effort bars) reads `useSignalInk()`. `check` shows the 12pt `check` in a reserved leading slot (opacity 0 when unselected, so selecting never shifts content); without it the content must carry the state (§2.4: a check or play glyph). `accessibilityLabel` is required and names the cell (its content is not read separately). The role is `button` (default, reports `selected`), `checkbox` or `radio` (also `checked`; wrap radios in a `radiogroup`). `disabled` dims it (0.4), blocks the press and reports it. Without `onPress` it is a static mark with no press state. `className` is layout only (flex, size, padding, direction such as `flex-col` for a narrow weekday cell): the fill, edge, radius, ink and minimum height come after it and always win. It fires no haptic, because the press means different things (a set done is `commit`, a toggle `selection`, §7): `onPress` fires the event. ChipRow chips are small SignalCells. |
| **Toggle** `{value, onChange, accessibilityLabel}` | Wraps **RN `Switch`** (native UISwitch or Material): `trackColor.true` is `#22D3EE`, `ios_backgroundColor` is system. The thumb is `#071017` on Android. On iOS it stays the system thumb until flag `switchInkThumb` is verified. It always sits inside a ListRow that owns the label. This gives Increase Contrast on/off labels, Liquid Glass and RTL for free. |
| **Slider** `{value, onChange, onChangeEnd?, min, max, step?, stops?, accessibilityLabel, accessibilityHint?, valueText}` | A 4pt `surface-tertiary` rail at radius 2, a `tint` fill, and a 22pt square `foreground` thumb at radius 2. Discrete stops fire a `selection` haptic, with no animation. It is `adjustable`; `accessibilityHint` carries guidance the visible text gives ("Recommended: 0.5–1% of body weight a week"). `sliderMetrics = {thumb: 22, inset: 11, rail: 4}`: the thumb's centre travels from `inset` to width − `inset`, so an app mark under the slider (macro's recommended band) lays out in a row padded by `inset`. It replaces macro's pace slider. |
| **Stepper** `{value, onChange, min, max, step?, label, format}` | IconButton `secondary` minus, a `Value s` cell (min 48 wide), then IconButton plus. It is adjustable with increment/decrement actions labelled from kit strings. It replaces lift's `program-editor` and `travel` steppers. |
| **SearchInput** `{value, onChange, placeholder, accessibilityLabel, autoFocus?, onFocus?}` | Field look, a leading `search` glyph, and a clear button (44 target) labelled from kit strings. **Only inside sheets.** Top-level list search is native header search (later, §6.2). |
| **SearchTrigger** `{label, onPress, accessibilityHint?}` | The SearchInput look as a **button** that opens search elsewhere (macro's quick-log bar opens the logger): Field edge, leading `search` glyph, the prompt in muted `body`. Role `button`, so nothing pretends to take typing; the search itself is a SearchInput in the sheet it opens. |

### 5.6 Lists

| component | spec |
|---|---|
| **ListRow** `{title, description?: string \| element, icon?, value?, trailing?: 'chevron'\|'check'\|'toggle'\|ReactNode, control?, onPress?, destructive?, disabled?, toggleValue?, onToggle?, accessibilityLabel?, accessibilityHint?, accessibilityActions?, onAccessibilityAction?}` | 44 min (56 with a description), px-4 py-3, gap 12. It has an optional leading icon (20, muted), a title (`body`, or `bodyStrong` without a description), and a description in `small` muted (an element, such as a `Meta` or a second line, renders as given). The value at the end is `readoutS` muted for data or `small` for words. The trailing slot holds a `forward` glyph (mirrors), a `tint` check (reported as `selected`), or a Toggle; a node there is decoration read with the row. **`control`** is for an interactive control at the end (Button, IconButton, ActionMenu, Toggle, or a row of them): it stays its own touch target and screen-reader element, the row's text becomes a separate element beside it (an accessible row would swallow it for VoiceOver), and `onPress` covers the text only. **`disabled`** dims the row (0.4), blocks the press and the toggle, and reports `disabled` (a Health sync toggle while a sync runs); pass `disabled` to a `control` yourself. `accessibilityHint` says what activating does ("Edits Push day") without overriding the title. Separators are 1pt `separator`, inset 16 (48 with an icon). It stacks at large type. |
| **RowRule** `{icon?, visible?}` · `useRowIndex()` | The ListRow separator for **app rows** inside `Panel inset="none"` (a history row with two lines, macro's diary rows): draw `<RowRule />` first and the row rules like a ListRow, never above the first row. `visible` overrides the position for rows nested below a panel child (a group under its own header). `useRowIndex()` is the row's position (undefined outside a row panel). |
| **SettingsSection** `{eyebrow, footnote?, children}` | A Label eyebrow (an accessibility heading, so the VoiceOver rotor reaches it), then `Panel inset="none"` of ListRows, then an optional caption footnote. This is the one settings anatomy for all four apps. |
| **RecordRow** `{time, title, description?: string \| element, value, leading?: IconName \| element, control?, onPress?, onLongPress?, accessibilityLabel?, accessibilityHint?, accessibilityState?, accessibilityActions?, onAccessibilityAction?}` | History row: a 56pt start column with the time in `readoutXS` muted, then the title and description, then the value `Value s` at the end. Used for water drinks, measurements, lift sets and the macro timeline. `leading` sits before the time column: a glyph (20 muted) or an element such as a selection mark. `control` is an ActionMenu (or another 44pt control) after the value, kept its own screen-reader element; it overhangs to 4pt from the edge so its glyph lines up with the content edge. `onLongPress` + `accessibilityState={{selected}}` carry macro's multi-select diary. Edit and delete go through SwipeRow, the row's `accessibilityActions` and the ActionMenu. |

### 5.7 Feedback

| component | spec |
|---|---|
| **Callout** `{tone: 'info'\|'success'\|'warning'\|'danger', title?, children}` | A 2pt start rule in the tone colour (`border-s-2 ps-3`). The title is a Label in the soft foreground, the body is `small` foreground, and the surface stays white. Children with any text in them (`{label} {value}`) render as one `small` Text; elements alone render as given. Danger and warning use `accessibilityRole="alert"`; the rest use a polite live region. It is placed directly under the control that caused it. |
| **ErrorText** `{message}` | Callout danger with no title. Renders nothing when `message` is empty. |
| **Status** `{state: 'live'\|'ok'\|'attention'\|'error'\|'idle'\|'off', label, meta?}` | A 6pt dot (signal, success, warning, danger, or a 1pt `border-strong` / `muted` outline), then the label in the Label style, then optional `readoutXS` meta. It is never a pill and never pulses. |
| **Meter** `{value, max, target?, projected?, over?: 'warning'\|'danger'\|'none', tone?: 'signal'\|'neutral', size?: 'md'\|'sm', accessibilityLabel, valueText}` | `over="none"`: past `max` is fine (water past the day's goal), so the fill stays full in its normal colour. **signal** (the screen's hero goal only): 8pt, a 1pt `border-strong` outline around a `surface-tertiary` track, a signal fill, and a 2pt `foreground` **index tick** (track + 4) at the value. **neutral:** 4pt, `surface-tertiary` track, `foreground-secondary` fill. `target` draws a 2pt tick. `projected` is the same fill at 40%. **Over** caps the fill, turns it to `warning` (or `danger`), and the text must say so ("120 kcal over"). The fill is flex from the start edge (mirrors), with no `left:`. It changes over 300ms standard, and the index tick rides the same animated value, so tick and fill never disagree mid-change. Role is `progressbar` with `accessibilityValue`. A meter is never shown without an adjacent readout. |
| **SystemState** `{kind: 'empty'\|'loading'\|'error', code?, message?, action?}` | Start-aligned where the data would be, with no illustration. It shows the code as a Label ("NO RECORDS"), the message in `body`, and one LinkButton. **Loading** shows skeleton rows shaped like the result after 300ms, radius 2, static at 60%, no shimmer. **Error** is ErrorText plus the code plus a secondary "Retry". A **fatal** error (migration) is a full-screen SystemState in the `form` column. |
| **ProcessLine** `{label, done?, total?}` | For AI analysis, import, backup and first health sync only. It shows `Status live` + label; with a count, a Meter plus `RECORD 04 / 07` in `readoutXS`. The 1pt `tint` scan sweep (900ms; a 1pt line, so ink cyan per §2.4, which is `#22D3EE` in dark mode) **stops after 5s** (WCAG 2.2.2) and is off under Reduce Motion. |
| **EffortMark** (lift, app-owned) | §2.5. The a11y label reads "Effort: Hard, 0–1 reps left". |

### 5.8 Editor (sheet)

**Editor** `{title, eyebrow?, open, close, busy?, dirty?, guarded?, onDismissed?, footer?, primary?: {label, onPress, disabled?, loading?, loadingLabel?}, destructive?: {label, onPress}, compact?, scrollRef?, children}`, with **EditorScreen** (`EditorScreenProps`: the same minus `open`, `close`, `onDismissed`, plus `onClose`) as the same thing for existing `presentation:'modal'` routes (water `drink`, `favorites`).

- **Presentation:** RN `Modal presentationStyle="pageSheet"` with the **default slide** (`animationType="none"` is removed). Inside are a GestureHandlerRootView and a per-sheet **PortalHost**, so DateInput and Select open above the sheet. It keeps `useCloseForAppAction`.
- **Header (56):** an `h2` title at the start, optionally with an eyebrow, and **Cancel** as a ghost LinkButton at the end, with its label from kit strings. The header holds text only, so nothing touches the sheet corner.
- **Body:** ScrollView, `form` column, 16 gap, inside a `KeyboardAvoidingView` (padding, offset by the top inset) that shrinks it above the keyboard. The ScrollView does **not** also set `automaticallyAdjustKeyboardInsets`: the native inset lands before the resize, which leaves a keyboard-high blank overscroll under every form.
- **Footer:** ScreenFooter with the primary `lg` at full width, riding the keyboard. `destructive` renders at the end of the scroll as a `destructive` Button.
- **Dirty state:** the Editor takes `dirty` (call sites pass it from their existing state comparison). `<Modal presentationStyle="pageSheet" allowSwipeDismissal={!busy && !dirty} onRequestClose={() => !busy && !dirty && close()}>`: a clean sheet swipes away; a dirty sheet resists the swipe (the iOS `isModalInPresentation` behaviour) and ignores Android back, and **Cancel** or the primary action are the exits. EditorScreen does the same on its route: `gestureEnabled: false` while dirty or busy, and a focused-only Android `hardwareBackPress` handler that swallows back (not `usePreventRemove`, which would also block Cancel's `router.back()`). There is no "Discard changes?" confirm, and nothing is lost silently. Persisted drafts (kit `useDraft`) are Later. Lift's program-editor `usePreventRemove` alert stays as it is, because it guards a route, not a sheet.
- **Stepping back inside a sheet (`guarded`):** when `close` may keep the sheet open (macro's FastLogger portion view steps back to the list; Cancel with a non-empty meal asks first; PhotoLogger's Adjust food), pass `guarded`. The sheet then never leaves on its own: iOS holds the swipe (`isModalInPresentation`) and turns the swipe attempt into `close`, and Android back calls `close`, so the app decides. Without it, a swipe on a clean sheet dismisses it natively while RN's Modal stays mounted with `visible`; the kit then presents the sheet again rather than leaving it stuck, but the swipe was still lost, so guarded sheets must say so. `busy` holds everything, as before. EditorScreen takes `guarded` too: the route's gesture is held and Android back calls `onClose`; on iOS the held swipe does nothing (it is not turned into `onClose`, as the Editor's is), so Cancel and the primary are the exits there.
- **Closing one sheet and opening another:** on iOS a sheet slides away for about 0.4s, and UIKit ignores a present during that slide (RN's Modal would stay mounted but invisible). Every Editor that opens while another is still leaving **waits** for it: its Modal's `onDismiss`, or 600ms when it unmounted and that event never comes (`src/vector/sheets.ts`, covered by a test). So a flow can unmount one Editor and mount the next in the same commit, or close sheets and open one on the next tick (macro's app-action links), with no timers of its own. `onDismissed` fires once the sheet has left the screen (after the slide; at once after a swipe or on Android): the place to open an alert, a route or a non-Editor modal. It does not fire for a swiped sheet that `close` kept open, which is presented again. `primary.loadingLabel` replaces the kit "Saving…" while `primary.loading` ("Reading…" for an import).

### 5.9 Charts (`src/vector/chart.tsx`, from lift/macro `progress/chart.tsx`)

Components: `TrendChart`, `Sparkline`, `RangeChips`, `RangeSummary`, `Legend`. Locale and formatters come from `useKitFormat()`; data comes in through props. **No kit file imports `@/lib/*`.**

| element | rule |
|---|---|
| canvas | no fill of its own; sits on `surface` |
| size | 200pt tall (260 at ≥600); sparkline 32 |
| grid | 3–5 horizontal lines at 1pt `separator`, 1pt `border` baseline, no vertical grid or axis lines |
| y ticks | on the **end** side in a 44pt gutter, `readoutXS` muted, cap 1.3 |
| x ticks | 3–4 ticks; the first aligns to start and the last to end; `Intl` short day or month, plus the year when the span is over 400 days |
| series, goals, bands, bars | §2.5; bars radius 2, gap 2, width ≤ 16. No capsule bars. |
| points | only when there are ≤ 31: hollow r2.5; the latest is solid r3.5 `tint`, and its value sits in the `Value` summary above |
| scrub | a 1pt `foreground` rule; the summary Value updates through a polite live region; no tooltip bubble |
| legend | required for more than one series: an 8×8 radius-2 swatch plus a `small` label |
| motion | none; ranges redraw instantly |
| a11y | `accessibilityRole="image"` with a summary (range, min, max, latest, direction); sparklines are hidden |
| RTL | the Svg sits in a View with `transform: [{scaleX: -1}]` when RTL; every text label is RN Text outside the Svg; scrub `locationX` is mirrored |

---

## 6. Chrome and navigation

### 6.1 NativeTabs (all four apps)

`<NativeTabs {...tabOptions(scheme)}>` comes from `src/vector/native.ts`, so `(tabs)/_layout.tsx` contains no hex.

| platform | props |
|---|---|
| iOS | `tintColor` = DynamicColorIOS(tint), `minimizeBehavior="never"`. **No** `backgroundColor`, `blurEffect`, `shadowColor`, `iconColor`, `labelStyle` or per-trigger `contentStyle`, so Liquid Glass renders. |
| Android | `backgroundColor` = surface, `indicatorColor` = `#22D3EE`, `iconColor {default: muted, selected: #071017}`, `labelVisibilityMode="labeled"`, `backBehavior="initialRoute"`. |

- **Icons:** outline for `default` and `.fill` for `selected`. Settings is always `gearshape` / `settings`.
- **Labels:** always `t()`.
- **Order:** Today, then the app's doing tabs, then Progress or History, then Library, then Settings.

| app | tabs |
|---|---|
| body | Today (was "Overview"), Body, Photos, Height, Settings |
| lift | Today, Plan, Progress, Exercises, Settings |
| macro | Today, Plan, Progress, Library, Settings |
| water | Today, History, Settings |

### 6.2 Headers

The root `<Stack>` sits inside the kit `NavigationTheme` (1.1.0), so every native-stack default the app leaves unset (bar, screen and modal backgrounds, title) uses the Vector palette.

**Tab roots** have no native bar. Their title is in the in-content ScreenHeader, which is where SIBYL typography lives. **Pushed screens** always use the native bar with the system title and no in-content title.

`detailHeaderOptions({title, scheme, flags, scrolls})`:

| option | iOS 26+ | iOS 16–25 and Android |
|---|---|---|
| `headerStyle` | `{ backgroundColor: "transparent" }` (never paint the bar; unset falls back to the navigation theme's card colour) | `{ backgroundColor: background }` |
| `headerTransparent` | `flags.transparentHeaders && scrolls` (shipped **false**) | false |
| `headerShadowVisible` | false | false |
| `headerLargeTitleEnabled` | false (`headerLargeTitle` is deprecated in expo-router 57) | false |
| `headerBackButtonDisplayMode` | `'minimal'` | `'minimal'` |
| `headerTintColor` | DynamicColorIOS(foreground): bars are monochrome | foreground |

Header rules:

- A header action goes in `unstable_headerRightItems` (≤ 1 action + an overflow menu). `prominent` items wait behind flag `prominentHeaderItems` (off); they are never tinted `#22D3EE`.
- A non-scrolling screen under a transparent header pads by `useHeaderHeight()`.
- Lift's 7 copy-pasted header blocks and macro's hand-made "Done" buttons are removed.
- **Later:** native `headerSearchBarOptions` for lift Exercises and macro Library.

### 6.3 Sheets and modals

| content | presentation (shipped) | later |
|---|---|---|
| data entry: every editor (weight, drink, food, set, gym, program, backup password) | kit **Editor**: RN Modal `pageSheet` with `dirty` (clean swipes away, dirty resists); **EditorScreen** for existing modal routes | native stack sheet routes with native header items; persisted drafts |
| read-only or explainer (health privacy, sources and methods, what syncs, coaching method, water today-details) | the existing route and presentation, restyled | `sheetOptions()`: `formSheet`, `fitToContents`, grabber, transparent content on iOS 26 only, never `sheetCornerRadius` |
| one quick decision (amount picker, effort after a set, custom amount) | Editor, or inline | **Tray**: formSheet with one signal button at the end |
| irreversible confirm | native `Alert.alert` with `destructive` style, marked `// vector: irreversible` | |
| HeroUI BottomSheet, `@gorhom/bottom-sheet` | not used (the dependency is removed in the owner's install commit) | |

### 6.4 Status bar, splash, launch

- `<StatusBar style="auto" />` in all four apps. Delete `ThemedStatusBar`: `Uniwind.setTheme` already syncs Appearance.
- The splash stays as it is: a black glyph on `#22D3EE`, dark is the cyan glyph on `#071017`, 200pt.
- `SplashScreen.preventAutoHideAsync()` until fonts, migrations and the first store read are ready, then `hide()` with a 200ms fade. **No intermediate `ActivityIndicator` screen.**
- The icons are unchanged; the owner says they are perfect.
- Android `primaryColor: "#007088"`.

---

## 7. Motion and haptics

| token | ms | use |
|---|---|---|
| instant | 100 | press colour |
| fast | 150 | selection, toggle, dock content swap, exit fades |
| normal | 200 | enter fades, splash hide, list insert |
| slow | 300 | meter change, layout reflow |
| pulse | 600 | signal pulse (hold 300 + fade 300) |
| scan | 900 | one ProcessLine sweep (stops after 5s) |

**Easing:**

- `standard = Easing.bezier(0.2, 0.8, 0.2, 1)`;
- `exit = bezier(0.4, 0, 1, 1)`;
- linear for timers.

There are **no springs, no bounce and no scale-on-press**: kit Buttons pass `feedbackVariant="none"`, and water's watch `PressStyle` is deleted.

- **Native transitions stay native:** pushes, sheets and tabs. Keep lift's `start` route `animation: 'none'` (instant start).
- **List insert and remove:** `LinearTransition.duration(200).easing(standard)`, `FadeIn(150)`, `FadeOut(100)`. No slides.
- **Signal pulse** (`Value pulseKey`, on a user commit only): a `#22D3EE` block appears behind the hero digits, the digits **and the unit** turn `#071017`, it holds 300ms, then fades over 300ms. The block stays mounted and only its opacity animates; the ink returns at the fade's midpoint, where both inks still clear 3:1 on the half-faded block. This is the SIBYL "data update", and the feedback *is* the icon look.
- **Reduce Motion:** no pulse, no scan, no layout transitions, and meters jump. The haptic and the announcement still fire.

**Haptics.** There are five events and no others. The kit calls `useHaptics()`; the app wires the adapter (no-op until `expo-haptics` is installed in that app).

| event | API | fires on |
|---|---|---|
| `selection` | `selectionAsync()` | Choices change, Toggle, Slider stop, Stepper step, effort pick, undo |
| `commit` | `impactAsync(Light)` | primary action completes: log drink, set done, save, add food, swipe past threshold |
| `complete` | `notificationAsync(Success)` | daily goal reached, rest over |
| `warn` | `notificationAsync(Warning)` | validation fails on submit, crossing the target |
| `error` | `notificationAsync(Error)` | a save or sync fails after a user action |

There are no haptics on navigation, scroll or passive updates.

On the watch: `WKInterfaceDevice.current().play(.success)` on log and set done, `.notification` when rest ends, and crown detents are system.

---

## 8. Native surfaces and Liquid Glass

### 8.1 Rules (every widget, Live Activity and watch view)

1. **One token source.** Colours come from `targets/_shared/VectorTheme.swift`, whose token block is generated from `tokens.json`. There are no asset-catalog colours except `$accent` (`#22D3EE`) and `$widgetBackground`, which `expo-target.config.js` reads from `tokens.json`.
2. **Only the container background is opaque:** `vectorWidgetBackground()`. The system removes it in accented, clear, StandBy and vibrant contexts. Every other fill is alpha-based or depends on the rendering mode.
3. **Hierarchy comes from alpha, not hue.** Text uses **only `.primary` and `.secondary`**. The one accentable thing (hero number, meter fill, action glyph) is `.widgetAccentable()`, applied **before** `.background`, so the plate stays in the default group.
4. **Full colour is the brand; accented is the glass.** A full-colour action plate is signal with a `#071017` glyph. In accented mode it is `primary.opacity(0.18)` (+0.10 under Increase Contrast) with an accentable glyph.
5. **Shapes:** `ContainerRelativeShape()` for plates, 2pt for marks, and system button shapes on the watch. There are no fixed corner radii.
6. **Type:** `VectorFont.readout(style)` is SF Mono, and `.vectorReadout()` adds `.monospacedDigit()`. Words are SF. Always use text styles, never fixed sizes, and no SF Rounded. `VectorLabel` uppercases only for cased scripts.
7. **Dynamic Type:** `.vectorWidgetTypeCap()` (…xxLarge) on widget and Live Activity roots; `.vectorWatchTypeCap()` (…accessibility2) plus a ScrollView on every watch page.
8. **State is never hue-only:** over = `exclamationmark.circle.fill` + text; done = `checkmark`; live = the timer itself.
9. **Always-On (`isLuminanceReduced`):** readouts only. Controls use `.vectorHiddenWhenDimmed()` (they keep their space), fills become 1pt strokes, and nothing moves.
10. **Strings come from the phone** (snapshot / ContentState / `WatchState.text` + `locale`). English literals remain only as pre-sync fallbacks. **Later:** per-target `Localizable.xcstrings`.
11. **Never use `glassEffect` inside WidgetKit.** The system supplies the platter. Custom glass appears only on the watch, for floating elements (`vectorFloatingCapsule()`).
12. **RTL:** leading and trailing only; SF directional symbols auto-mirror; custom directional images use `.flipsForRightToLeftLayoutDirection(true)`.

### 8.2 Rendering-mode matrix

| element | fullColor (Home light/dark, StandBy day, CarPlay) | accented (iOS 18 tinted, iOS 26 tinted and clear glass) | vibrant (Lock Screen, StandBy night) | luminance reduced (Always-On) |
|---|---|---|---|---|
| container | `VectorColor.surface` via `vectorWidgetBackground()` | removed by the system | `AccessoryWidgetBackground()` only in circular | system-dimmed |
| signal plate (`vectorPlate(.signal)`) | fill `#22D3EE`, glyph `#071017` | `primary` 0.18 (+0.10 HC), glyph `.primary` accentable | — (no buttons) | 1pt `primary` 0.5 stroke |
| quiet plate (`vectorPlate(.quiet)`) | `surfaceTertiary`, glyph `tint` | `primary` 0.10 (+0.10) | — | stroke |
| hero readout | `.primary`, SF Mono, accentable | `.primary`, accentable | `.primary` | `.primary` |
| secondary text | `.secondary` | `.secondary` | `.secondary` | `.secondary` |
| meter track (`VectorMeter`) | `surfaceTertiary` + 1pt `borderStrong` (signal style) | `primary` 0.20 (+0.10) | `primary` 0.20 | 1pt `primary` 0.5 stroke |
| meter fill | signal + ink tick (widget) / tint (Live Activity) / foregroundSecondary (neutral) | `.primary`, accentable | `.primary` or `Gauge` | 1pt `primary` stroke segment |
| over | warning fill + glyph + text | glyph + text | glyph + text | glyph + text |

### 8.3 Widgets (macro now; the pattern for any future widget)

- **Families:**
  - systemSmall: the kcal readout (`title2` mono, accentable) plus unit, a signal VectorMeter, a compact P · C · F row, and **Scan** as the signal plate with **AI** as the quiet plate.
  - systemMedium: the same, with stacked labelled plates.
  - accessories: Gauge plus text.
- `.disfavoredLocations(VectorWidget.disfavoredSmallLocations, for: [.systemSmall])`. The array is built at runtime because `.carPlay` is iOS 26 only and the widget deploys at 17.
- `$accent` becomes `#22D3EE` in both appearances. The `track`, `calories` and `danger` colorsets are deleted.
- Snapshot adds `locale` and `text` (pre-localized). Numbers use `Locale(identifier:)`.

### 8.4 Live Activities (lift rest timer)

**Shipped in 1.0: an owned `@bacons/apple-targets` widget target**, `targets/activity` (target `LiveActivity`, bundle id `.LiveActivity`, unchanged, so no new App ID; deployment **16.4**, the app's own). It keeps expo-live-activity's JS API: its config-plugin entry is removed from `app.json`, and the extension declares a `LiveActivityAttributes` with the module's exact Codable shape, which is the same mechanism the plugin itself uses. `rest-timer.ts` calls `startActivity(state)` with no config, because the owned UI ignores every JS colour key. Design, from `reference/lift-activity/LiveActivity.swift` (type-checked at iOS 16.4, 17.0 and 18.0):

| surface | design |
|---|---|
| Lock Screen | `activityBackgroundTint(nil)` and `activitySystemActionForegroundColor(nil)` (system material and a system-chosen action colour, never black on dark). A leading `VectorActivityGlyph` (signal plate + black glyph: the icon in miniature), then the title in `.headline` over the subtitle in `.secondary`. The trailing timer is mono `.title`. The bottom `ProgressView(timerInterval:)` is tinted `VectorColor.tint`. Margins are 14. |
| Always-On | the same layout, with the meter tinted `.secondary` |
| Stale (`context.isStale`) | a check glyph instead of the timer; `staleDate` = end + 60s once the module passes it (Later) |
| Dynamic Island | compact leading: the timer glyph in signal (11.6:1). Compact trailing: mono `.subheadline` timer, fixed width. Minimal: circular ProgressView tinted signal. Expanded: glyph + title, timer, meter. `keylineTint(signal)`. |
| Smart Stack, CarPlay | the compact views above (glyph + mono timer), so the timer is never anonymous. `.supplementalActivityFamilies([.small])` is iOS 18-only and cannot be availability-gated in a `WidgetConfiguration`, so it waits until lift's minimum iOS is 18 (Later). |
| deep link | `.widgetURL(lifttrack://workout)` directly (the plugin read the URL scheme from the extension bundle, so its link was dead) |

**Fallback** (only if the owned target cannot be built): keep the plugin and omit `backgroundColor`, `titleColor`, `subtitleColor` and `progressViewLabelColor` from JS. The plugin then renders `activityBackgroundTint(nil)` with `.primary` text, `progressViewTint` is the single-hex `#0891B2` (3.68 on white, 5.21 on `#071017`), and the black system-action colour and dead deep link remain.

### 8.5 watchOS (lift 11.0, water 10.0: both stay)

| element | watchOS 26+ | watchOS 10/11 |
|---|---|---|
| background | system black, no `containerBackground` in workout views | same |
| primary (Start, Log, Finish) | `vectorPrimaryButton()`: the capsule `VectorFillButtonStyle` (signal fill, `#071017` label, 48 min). `.glassProminent` only when `VectorFlags.glassProminentLabelOK` is flipped after a device check. | capsule fill |
| secondary (Skip rest, Undo) | `vectorSecondaryButton()` → `.glass` | `.bordered` |
| interactive tiles (water favourites) | `vectorTileButton()` → `.glass` + `.roundedRectangle` | `.bordered` + `.roundedRectangle` |
| data tiles (crown values) | `VectorDataTile`: `primary` 0.08 fill, 1pt `primary` 0.16 stroke, 4pt; a focused tile gets a 2pt `tint` stroke | same |
| floating undo | `vectorFloatingCapsule()` → `.glassEffect(.regular.interactive(), in: .capsule)` | `.ultraThinMaterial` capsule |
| effort | EffortMark in capsules; selected is a signal fill with `#071017` content | same |
| double tap | `vectorPrimaryAction()` → `handGestureShortcut(.primaryAction)` on Log and Skip rest | no-op on 10 |

Other watch rules:

- Log turns signal (it was system green).
- Done checks turn signal.
- Non-working sets use `.secondary` (was orange).
- Heart rate stays red.
- Loads use `value.formatted(.number.precision(.fractionLength(0...2)))`.
- Water percent uses `NumberFormatter.percent`.
- The water palette is deleted.

### 8.6 Test matrix (recorded per release in `docs/design-system-checks.md`)

The Phase 1 simulator review (MIGRATION, after P1.8) covers what the iOS 27 simulator can show: light, dark, tinted, clear, Lock Screen, Dynamic Island, Always-On, Increase Contrast, Bold Text, largest Dynamic Type, `forcesRTL`. StandBy, the real Smart Stack, CarPlay and Android need hardware.

| surface | light | dark | tinted ×2 | clear light/dark wallpaper | Lock Screen | StandBy day/night | Always-On | Increase Contrast | Reduce Transparency | Bold Text | largest DT | RTL (forcesRTL dev build) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| macro widget small, medium, accessories | ● | ● | ● | ● | ● | ● | — | ● | ● | ● | ● | ● |
| lift Live Activity (Lock Screen, DI, Smart Stack via compact views) | ● | ● | — | ● | ● | ● | ● | ● | ● | ● | ● | ● |
| lift and water watch (41, 45, 49mm) | — | ● | — | — | — | — | ● | ● | ● | ● | ● | ● |
| apps (tab root, detail, Editor) on iOS 18 and iOS 26, Android | ● | ● | — | — | — | — | — | ● | ● | ● | ● | ● |

---

## 9. Internationalization and RTL

### 9.1 Config (all four `app.json`)

```json
["expo-localization", { "supportedLocales": ["en","es","fr","de","it","pt","nl","sv","ja","ko","zh-Hans"] }]
```

- `supportedLocales` writes `CFBundleLocalizations`, which gives per-app language in iOS Settings and localized system UI. It takes effect at the next prebuild.
- **`"supportsRTL": true` is deliberately NOT set yet.** With it, expo-localization calls `allowRTL` and `forceRTL` before React loads whenever the device's first language is RTL, even though no RTL translation exists (theming audit #31). An Arabic-device user would then see English in a mirrored layout. Set it in the same change that adds the first RTL locale, after the `forcesRTL` dev-build check.
- **Later:** add `"locales"` to localize `CFBundleDisplayName` and the Health and Photo usage strings.
- A direction change needs a reload. A future in-app picker calls `I18nManager.allowRTL(true)`, then `forceRTL(isRTL(lang))`, then `Updates.reloadAsync()`.

### 9.2 Layout rules (enforced by `vector-kit check`)

| do | never |
|---|---|
| `ms- me- ps- pe- start- end- border-s- border-e- rounded-s- rounded-e-` (a side prefix on an allowed radius, such as `rounded-s-mark`, passes the radius rule); symmetric `{left: n, right: n}` pairs and `hitSlop` / `insets` objects are direction-neutral | `ml- mr- pl- pr- left- right- border-l border-r rounded-l rounded-r`, and `style={{left/right/marginLeft/…}}` |
| On Text, `text-left` means start and `text-right` means end: RN resolves both against the layout direction. Use them only on Text. | `text-end` or `text-start` (Fabric doesn't support end) |
| `rtl:text-right` on TextInput (Field does this) | |
| `flex-row` (it mirrors) | `flex-row-reverse` to fake RTL |
| `mirrors` icons from the registry | text arrows `→ › ‹ ←` in strings |
| kit SwipeRow; pagers invert the gesture delta with `useIsRTL()` (water `home-carousel`, macro `week-strip`) | raw swipe directions |
| kit charts (mirrored Svg, labels outside) | absolute `right: 0` labels |
| Intl output in its own Text run | `"+" + n`, `n + "%"`, `` `${a} · ${b}` `` |

Mirrors for free: flex rows, start/end, Meter, NativeTabs, native headers and back buttons, sheets, UISwitch, HeroUI's own direction logic, and SwiftUI `.leading` layouts.

Never mirrored: `play`, clocks, the brand glyph, and numeric labels.

### 9.3 Text expansion

- Design every label for **+40%** (de, fr and nl run 30–40% longer) and every sentence for +30%.
- Tab labels stay ≤ 12 characters in English.
- No fixed widths on text columns. Water's `w-16` and `w-24`, lift's `w-14` and `w-16`, and macro's `width: 80` become `minWidth` + flex.
- Eyebrows are ≤ 3 words, one line.
- **Later:** a dev-only pseudo-locale (+40%, accented, bracketed), selectable in debug builds.

### 9.4 Formatting (`src/vector/format.ts`, the only formatter)

- **`localeTag(language, deviceLocales)`** picks the first device locale whose language matches (so en-GB stays en-GB). Otherwise it uses `en-US es-ES fr-FR de-DE it-IT pt-BR nl-NL sv-SE ja-JP ko-KR zh-Hans-CN`. This replaces about 20 `language === 'zh' ? 'zh-CN' : language` sites.
- **`createFormat(tag, { uses24h?, strings? })`** provides (VectorProvider passes the kit strings of the app language; a direct caller may omit them):
  - `number(n, digits, style)` (exactly `digits` decimals), `percent` and `percentParts(fraction, digits, style)` (at most `digits`), and `unit` / `unitParts(n, unit, digits, style)` (at most `digits`). `style` is `true` (signed, the 1.x form) or `{ signed?, fixed?, grouping? }`: `signed` for deltas (`+3`, `+5 %`), `fixed` for a column of readings (`80.0 kg`, BAC `0.050%`), `grouping: false` for text a person edits. `percentParts` spreads into Value like `unitParts`, and its `.unit` alone is a Field suffix (`%`).
  - `editable(n, digits = 2)`: the text a numeric Field starts with: no grouping, at most `digits` decimals, a plain hyphen-minus (sv, nb and fi write U+2212; `editable` turns it back). The bidi mark an RTL locale writes before the sign (LRM in he, ALM in ar) stays, because it keeps the sign in place in an RTL field. It reads back through `parseDecimal` after any edit.
  - Units: ECMA-402 kilogram, gram, pound, stone, centimeter, inch, foot, milliliter, liter, fluid-ounce, hour, minute, second (`IntlUnit`), plus `milligram` (`SymbolUnit`), which Intl does not sanction: the kit string `unitMilligram` in the gram's order and spacing (`95 mg`, ko `95mg`; a CJK symbol attaches). `FormatUnit` is either.
  - **Typographic minus:** every display format writes U+2212 where the engine wrote a hyphen-minus before a digit (Hermes and most ICU locales do; sv already writes U+2212), never between two numbers (an es range `−3 - 4`). A value that rounds to zero is zero (no `−0.0`). It lives in `format`, not in Value, so readouts, Meta facets, chart ticks, sentences and accessibility text agree. `editable` keeps the hyphen-minus the keyboard types; `parseDecimal` reads both.
  - `range`, `date(d, 'short'|'medium'|'long'|'full')`, `monthDay` (`Sep 29`), `monthYear(d, 'long'|'short')`, `year`, `dateRange(a, b, { year? })` (`Sep 22 – 28, 2026`; without formatRange the year prints once, on the date the locale writes it beside: the start in ja, ko and zh, `2026年9月22日 – 9月28日`, the end elsewhere), `time` (24-hour setting from expo-localization), `weekdayShort`, `weekdayLong`, `weekdayNarrow`. Dates take a `Date` or a timestamp.
  - `list(items, { type?: 'conjunction'|'disjunction'|'unit', style? })`: `unit` joins measurements with no "and" (`1 hr 5 min`). Without `Intl.ListFormat` (Hermes) the kit strings `listAnd` / `listOr` / `listSeparator` join the items, matching Intl in all 11 languages for two items; a direct caller without kit strings gets `a, b` / `a / b`.
  - `relativeDays`, `plural`, and `duration` (m:ss, Latin digits).
- **`parseDecimal(text, tag)`** is the only number parser for typed input: it accepts the locale decimal or `.`, grouping in threes, Latin or Arabic-Indic digits and U+2212 minus, and returns `null` for anything else. A single separator is the decimal, except the locale's own grouping mark before exactly three digits (`2,200` in en and `2.200` in de are 2200). Repeated locale decimals are never grouping (`1.234.567` in en is `null`). Numeric Fields start from `format.editable`, so `72,5` round-trips in de and fr and `2000` never becomes `2,000` (read back as 2 after a backspace). Bidi marks are ignored.
- `kcal` and reps are not Intl units, and a macro amount is a phrase ("30 g protein"): they use translated templates (`"{value} kcal"`). A bare mass in grams or milligrams (caffeine, alcohol) goes through `unit`.
- **Hermes Intl.** `ListFormat`, `PluralRules`, `RelativeTimeFormat`, `style: "unit"` (behavioural: converted units and the `#` pound fail it), `formatToParts`, `signDisplay`, `useGrouping: false` and both `formatRange`s are feature-detected (`intlSupport`), each with a fallback. The node tests run every format call against a Hermes-like Intl (no `formatToParts`, converting units, no ListFormat, PluralRules, RelativeTimeFormat or date `formatRange`) and assert the same parts as full ICU where the result can be the same. An engine that rejects one unit outright falls back instead of throwing. The simulator review found the iOS gaps (§12); the gallery's Environment group logs `intlSupport` and a `format` sample list on the engine in hand.
- `isolate(s)` wraps values in FSI…PDI (U+2068 / U+2069) inside RTL templates.
- Every native snapshot (widget, watch, Live Activity) carries `locale` and a pre-translated `text` dictionary.

### 9.5 Strings

- The kit owns **24 strings** (cancel, done, save, close, undo, retry, back, more, search, clearSearch, selected, loading, processing, noData, over, goal, all, increase, decrease, and for `format`: unitGram, unitMilligram, listAnd, listOr, listSeparator) in all 11 locales, with a `satisfies Record<KitLanguage, KitStrings>` parity check. The kit never imports an app's translations.
- Every other visible string reaches a kit component as a translated prop. Icon-only controls require `accessibilityLabel` by type.
- Apps use a typed `t(key: Message, values?)`: water's `Message = keyof typeof en` and `interpolate()`, ported to body, lift and macro. An unknown key is a **tsc error**.
- `react/jsx-no-literals` and a label-prop literal rule run in ESLint, with existing hits baselined in `vector.allow.json`.

---

## 10. Copy voice

| rule | yes | no |
|---|---|---|
| short, declarative, present tense | "Could not save. Try again." | "Oops! Something went wrong." |
| sentence case in every source string | "Log drink" | "Log Drink", "LOG DRINK" |
| no contractions | "cannot", "did not" | "can't" |
| typographic punctuation | ’ “ ” … and ranges from `Intl` | ' " ... - |
| buttons are verb + object, ≤ 20 characters in English | "Save weight", "Add food" | "OK", "Submit" |
| errors say what happened, then what to do | "Sync did not finish. Check Health permissions." | developer leaks ("native development build") |
| empty states give the fact, then the action | "No weights yet." + "Add weight" | "Your next sip starts here" |
| progress uses the ellipsis character | "Syncing…" | "Syncing" |
| no exclamation marks, no emoji, no "please" (except consent) | | |
| never concatenate; separators live in templates or Meta | `"{action} · {object}"` | `` `${t('add')} · ${t('weight')}` `` |
| eyebrows are nouns or live context, never a restatement of the title below them; `DOMAIN / OBJECT` inside panels and sections | panel: "Record / Weight", "System / Sync"; tab root: the date, the range | sentences, verbs; "Today / Intake" over a "Today" title |

**Vocabulary.** SIBYL vocabulary (Record, Analysis, Status, Log, Scan) appears **only in eyebrows and status words**, never in actions or sentences. Warmth is allowed only in notification bodies.

**Glossary:**

- Appearance: System / Light / Dark (not "Theme").
- Units: Metric / Imperial / Stone (body); Metric / US (water).
- Today (not "Overview").
- Up to date · Syncing… · Last synced {time} · Not connected.
- Delete {object} / {Object} deleted + Undo.
- Backup · Erase all data.

**Names** (recommended; applied only after the owner's sign-off in MIGRATION, since bundle ids stay the same): app names Vector Body, Vector Lift, Vector Macros, Vector Hydration; home-screen labels (`CFBundleDisplayName`), watch and widget names Body, Lift, Macros, Hydration. Today the apps are named "VECTOR BODY" (no display name), "Vector Lift" / "Lift", "Vector Macros" / "Macros" (widget "Macros") and "VECTOR HYDRATION" / "HYDRATE". Phase 1 changes only the water watch setup text to "Vector Hydration".

---

## 11. Kit architecture and drift policy (summary; details in KIT.md)

- **No shared repo.** Identical files sit at identical paths in every repo:
  - `src/vector/**`
  - `src/global.css`
  - `docs/design-system.md`
  - `scripts/vector-kit.mjs`
  - `eslint.vector.cjs`
  - the fonts
  - `targets/_shared/VectorTheme.swift` (lift, macro, water)

  Canonical copy: `/Users/sam/Development/VectorApps/vector-design/kit/` (the owner can `git init` it). Lift is the first integration repo.
- **`tokens.json` is the single source.** `gen` writes the token block of `tokens.css`, `tokens.ts` and the token block of `VectorTheme.swift`, so CSS, TS and Swift parity holds by construction.
- **`check` fails on:**
  - any hash mismatch against `src/vector/manifest.json`;
  - generated output that differs from `tokens.json`;
  - an app-code rule hit (hex literals, RN Text imports, physical direction, `uppercase` / `tracking-*` / `text-end`, `shadow-*`, `bg-accent` / `text-accent` / `border-accent` (and, since 1.2.1, the signal under another name: `bg-` / `text-` / `border-segment`, `bg-accent-hover`, `fill-` / `stroke-` / `outline-` / `ring-accent`, Uniwind's `accent-accent`, and `useThemeColor` / `useCSSVariable` of `segment` or `accent-hover`, reported as `accent-alias`), `font-bold` / `font-semibold` / `font-medium`, `rounded-*` other than `mark` / `control` / `panel` / `none` (optionally with a side or corner prefix), `allowFontScaling={false}`, and `Alert.alert` without `// vector: irreversible`) that `vector.allow.json` doesn't already count.

  `accent`, `accent-alias`, `removed-token` and `raw-heroui-tabs` allow no baseline: a signal-filled app cell is a SignalCell (§5.5). `numberOfLines` on content text (`lines`, since 1.2.0) is counted the same way as the others. A rule added after a repo's baseline was written (`vector.allow.json` records the kit version as `kit`; a file without it predates 1.2.0) is reported as a warning until the next `check --baseline`, so syncing a newer kit never fails `lint` on code that was already there. For a rule that allows no baseline (`accent-alias`, 1.2.1) that next baseline refuses the hits, so they are migrated first.

  It **warns** on peer version ranges and on a `.prettierignore` that misses synced kit files. `check --drift` runs only the hash and generated-output checks: it is the MIGRATION S1 gate (before `vector.allow.json` exists) and what the test wrapper runs; `lint` runs the full `check`.
- `check --swift` type-checks the shared Swift for iOS 16.4 (app), iOS 16.4 appex (lift activity), iOS 17.0 appex (macro widget), watchOS 10.0 and watchOS 11.0, then each target at its own deployment target.
- **An app never edits a kit file.** A change is made in the canonical copy, then `gen`, then `bump`, then `sync` to all four repos, and the owner commits it in each repo as `vector-kit vX.Y.Z` (agents never commit).
- **`sync` never replaces an app's own file.** Only the files the repo's own `manifest.json` lists are kit-owned there. A different file at a kit path (the app's `global.css` before the first sync, or an app file where a newer kit starts shipping one) stops the sync with a list, and only `--force`, after review, replaces it. Sync deletes only files an earlier kit shipped and this one does not; an app file inside `src/vector` is kept and reported (`check` flags it as unknown).

---

## 12. Flags and device checks

Each unverified platform behaviour ships with a safe default decided in advance. Checks run first in the Phase 1 simulator review (after the P1.8 simulator build); only what the simulator cannot settle waits for a device.

| # | check (simulator review, then device if needed) | shipped default | flag / upgrade |
|---|---|---|---|
| 1 | iOS 26 `.glassProminent` tinted `#22D3EE` keeps a `#071017` label | capsule `VectorFillButtonStyle` everywhere | `VectorFlags.glassProminentLabelOK` (Swift) |
| 2 | `NativeTabs.BottomAccessory` mounts and unmounts per focused tab | docked strip above the tab bar | `bottomAccessoryDock` (**not wired in 1.0.0**: needs the Later accessory slot) |
| 3 | iOS 26 transparent headers: scroll-edge effect, no overlap | unpainted, non-transparent header | `transparentHeaders` |
| 4 | tab-root top edge under the iOS 26 status bar | `SafeAreaView edges={['top']}` | `scrollUnderStatusBar` |
| 5 | Inter variable-instance weights on iOS and Android | numeric weights (at worst they render at Regular, as today) | owner supplies static faces (§3.1) |
| 6 | `Uniwind.updateCSSVariables` Increase Contrast swap | base tokens (AA); native chrome and Swift adapt already | `runtimeContrastSwap` |
| 7 | iOS 26 UISwitch with `thumbColor #071017` | system thumb, `#22D3EE` track | `switchInkThumb` |
| 8 | CJK explicit families when app and device languages differ | Inter + system fallback | `cjkSystemFamilies` (Text and Choices / chip labels, iOS) |
| 9 | `prominent` header item on `#007088` renders a light glyph | plain tinted items | `prominentHeaderItems` (DetailScreen `action.prominent`, iOS 26) |
| 10 | `glassEffect` inside WidgetKit | never used | none (by design) |
| 11 | Hermes Intl: ListFormat, PluralRules, RelativeTimeFormat, unit style, formatRange | feature-detected fallbacks | none needed |
| 12 | `expo-symbols` Material names on Android (SDK 57) | Ionicons renderer everywhere | `renderIcon` adapter (lift, macro) |
| 13 | lift Live Activity: JS-started activity renders the owned UI on the Lock Screen and in the Dynamic Island (proves the `LiveActivityAttributes` match) | owned `targets/activity` target, deployment 16.4 | fallback if it cannot build: the plugin with omitted colours; Later: `staleDate` (module patch), `.small` (iOS 18 minimum) |
| 14 | variable-font or plugin font embedding in extensions | SF / SF Mono in all native surfaces | owner upgrade |

**Device-verified in simulator** (lead's review, iOS 27 simulator on iPhone 18 Pro, lift and water; body could not launch on iOS 27 for an unrelated scene-lifecycle reason, and its screens use the same kit):

- **#11 Hermes Intl on iOS.** `Intl.NumberFormat.prototype.formatToParts` does not exist (kit 1.0.0 crashed on Progress; fixed in 1.0.1). `style: "unit"` runs through NSMeasurementFormatter: it converts units (a 38 h elapsed time came out as "136,800s") and writes the short pound as "#" ("293#"), so 1.0.2 and 1.0.3 trust unit output only behind a behavioural probe, and on iOS every unit takes the number + symbol fallback. `signDisplay` works but writes a hyphen-minus ("-2"); 1.2.0 turns it into U+2212. The shipped fallbacks are what the node tests' Hermes-like Intl exercises.
- **NavigationTheme (1.1.0).** A pushed screen in dark mode showed a white header band behind light glass items until the root `<Stack>` was wrapped in `<NavigationTheme>` inside `VectorAdapter` (§5); with it, the canvas shows through the transparent iOS 26 header. Verified in lift; body, macro and water adopt it in their root layout.
- **#13 owned Live Activity.** The JS-started lift rest timer renders the owned `targets/activity` UI on the Lock Screen and in the Dynamic Island, which proves the `LiveActivityAttributes` shape matches. Two follow-ups stay open (MIGRATION L6): the Lock Screen bar is drawn from `Date()...end`, so it refills on every re-render (carry the rest length in `progress` and draw `end - length ... end`); and with no `staleDate` the Island keeps showing "0:00" after the rest ends, so the stale state never appears.

---

## 13. Checklist for a new screen

1. It uses `Screen` (tab root) or `DetailScreen` (pushed). The ScrollView is the first descendant.
2. There is exactly one `Button variant="primary"` (or none). Secondary actions are in `ActionMenu`.
3. There are no hex values, size classes, `font-*` weights, `uppercase` or `tracking-*`, `rounded-*` other than mark / control / panel, `shadow-*` or physical-direction classes.
4. Every string comes from `t()` with a typed key. There is no concatenation: use templates, `Meta` or `format.list`.
5. Every measured number is a `Value` fed by `useKitFormat()`. Units come from `unitParts`.
6. Cyan appears only as a fill with `#071017` (§2.4), drawn by a kit component (a selected app cell is a SignalCell). Text cyan is `tint`.
7. Every meter, chart and status has adjacent text. Every icon-only control has `accessibilityLabel`.
8. Deletions use undo where the store can restore; `Alert.alert` is otherwise used only for irreversible actions and carries the comment (existing delete confirms stay until L4).
9. Editors use `Editor` and pass `dirty`.
10. The screen was checked at +40% text (de), in ja, at the largest Dynamic Type size, in dark mode, and under `forcesRTL` in a dev build.
11. `pnpm typecheck && pnpm lint && pnpm test` pass (`lint` includes `vector-kit check`).

---

## Changelog

- **1.2.2.** `assets/fonts/IBMPlexMono-OFL.txt` is stored with LF line endings. Git keeps the file as LF in each repo, so a fresh clone checked it out as LF while the manifest hashed the CRLF copy, and `check` reported drift on any machine but this one.
- **1.2.1.** (patch) The lead's decision on 1.2.0 deferred items #23 / #35: a kit primitive for signal-filled app cells, and the `accent` rule closes the alias lift used to get around it. Additive: nothing renamed or removed, and all four apps compile against it unchanged.
    - New **SignalCell** (form.tsx) `{selected, onPress?, disabled?, accessibilityLabel, accessibilityHint?, accessibilityRole?: 'button'|'checkbox'|'radio', size?: 'md'|'sm', check?, className?, children?}`, `SignalCellProps` and `useSignalInk()`: the one place a `#22D3EE` fill meets its `#071017` content (§5.5). While a cell is selected, kit Text, Value and Icon inside it draw signal ink whatever tone they pass. ChipRow chips are now small SignalCells: same look, plus the pressed `bg-accent-hover` state on a selected chip.
    - New rule **`accent-alias`** (no baseline, like `accent`): `bg-` / `text-` / `border-segment`, `bg-accent-hover`, `fill-` / `stroke-` / `outline-` / `ring-accent`, Uniwind's `accent-accent`, and `useThemeColor` / `useCSSVariable` of `segment` or `accent-hover` in app code. A baseline older than 1.2.1 gets warnings until the next `check --baseline`, which refuses them. Hits today: lift 2 (`workout/set-row.tsx` done cell, `workout/effort.tsx` EffortPicker); body, macro and water none. Covered by tests.
    - Gallery: SignalCell specimens (weekday toggles, set done, a static next-session mark, Value content, disabled, an effort radiogroup). Docs: §2.2, §2.4, §5.2, §5.5, §11, §13.
  **After syncing, apps will notice:** lift's `lint` warns about its 2 `accent-alias` hits until they move to SignalCell; macro's calorie-shift DayToggle (an `accent-soft` wash with a tint edge, which no rule counts) can adopt SignalCell or ChipRow `multiple`.
- **1.2.0.** (minor) The kit issues from the four Phase 1 migrations (85 reports, deduplicated) and the lead's simulator review. Every new prop, option and export is optional or additive; nothing was renamed or removed, and all four apps compile against it unchanged. Behaviour an app notices after syncing is listed last.
  **Components, accessibility and layout:**
    - Scaffold: Undo **stacks above** the dock or footer instead of replacing it (lift's rest strip and Skip stay reachable; under a screen reader nothing is hidden indefinitely); the fallback toast moves to the top edge, clear of the tab bar; Undo is announced on both platforms, once (the docked strip explicitly; the toast explicitly on iOS only, because it is an Android live region), with an optional spoken `undoneMessage`; `useScreenReader` is exported. The static column (`scroll={false}`) flexes (`flex: 1`, `minHeight: 0`). Android Screens avoid the keyboard. `DetailScreen` takes `footer` and `compact`.
    - Editor: `guarded` (close steps back or asks; the swipe and Android back become `close`), `onDismissed`, `primary.loadingLabel`; opening waits for a sheet that is still sliding away (`sheets.ts`, tested), and a sheet swiped away while `open` stays true is presented again instead of sticking (without firing `onDismissed`). `EditorScreen` takes `guarded` (its own doc: the iOS swipe is held and does nothing; Android back calls `onClose`); `EditorScreenProps` is exported.
    - Lists: ListRow `disabled`, `accessibilityHint`, `control` (an interactive end control kept as its own screen-reader element), element `description`, and check rows report `selected`; `RowRule` and `useRowIndex` are exported for app rows in `Panel inset="none"`; RecordRow `leading`, `control`, `onLongPress`, element `description` and `accessibilityLabel/Hint/State`; SwipeRow `ref` (`close()`) and `onAction(close)`.
    - Inputs: Select announces its value and takes `showTitle`, `disabled`, `accessibilityHint`; Choices `disabled`; ChipRow `required` and `multiple` modes; Field `ref`, `selection`, `onSelectionChange`, `onFocus`; DateInput / TimeInput `accessibilityLabel` (TimeInput reads its time as the value); Slider `accessibilityHint` and `sliderMetrics`; new `SearchTrigger`.
    - Actions and feedback: LinkButton `accessibilityRole` (`button` / `link`), `accessibilityLabel`, `accessibilityState`; `buttonLook` / `iconButtonLook` for shim fallbacks; Panel `accessibilityHint`, Panel.Header `action` and `wrap`; Label documents `numberOfLines`; Callout wraps mixed text children; Meter `over="none"`.
    - Portals: ActionMenu, Select, DateInput and TimeInput re-provide the kit inside their HeroUI portals, so they work with either provider order; §5 now states the order (VectorAdapter outside HeroUINativeProvider).
  **Formatting (`format.ts`, `strings.ts`):**
    - `number`, `percent`, `unit` and `unitParts` take a style: `true` (signed, as in 1.x) or `{ signed?, fixed?, grouping? }`. `fixed` keeps trailing decimals (`80.0 kg` from `unit`/`unitParts`, BAC `0.050%`); `grouping: false` drops the thousands mark. Defaults are unchanged (number exact, the others at most `digits`).
    - `editable(n, digits = 2)`: ungrouped Field text with a plain hyphen-minus (sv's U+2212 included; he and ar keep their bidi mark), so a backspace in "2000" never reads back as 2 (water's `useDecimal`).
    - `percentParts`: the locale's percent sign, order and spacing for Value, and `.unit` as a Field suffix (body's `percentSign` workaround).
    - `gram` joins `IntlUnit`; `milligram` (`SymbolUnit`; ECMA-402 does not sanction it) uses the new kit string `unitMilligram` in the gram's order and spacing, and the gram fallback uses `unitGram`. `FormatUnit` covers both. A unit the engine rejects falls back to number + symbol instead of throwing during render.
    - Dates: `monthDay`, `monthYear(d, 'long'|'short')`, `year`, `weekdayLong`, `weekdayNarrow`, `date` styles `long` / `full`, `dateRange(a, b, { year })` (without formatRange the year prints once: on the start date in ja, ko and zh, which write it first, on the end date elsewhere), and every date call accepts a timestamp. DateTimeFormats are cached like NumberFormats.
    - `list(items, { type: 'conjunction'|'disjunction'|'unit', style })`. Without `Intl.ListFormat` (Hermes) the new kit strings `listAnd`, `listOr` and `listSeparator` join the items, matching Intl for two items in all 11 languages; a direct `createFormat` caller without kit strings gets a neutral `a, b` / `a / b`.
    - **Typographic minus:** display formats write U+2212 where the engine wrote a hyphen-minus before a digit (the review's `-2` deltas), never between two numbers; a value that rounds to zero prints as zero, never `−0`. It lives in `format`, not Value, so readouts, sentences, chart ticks and accessibility text agree; `parseDecimal` reads it back and now ignores bidi marks.
    - `createFormat(tag, { strings })`: VectorProvider passes its kit strings. `intlSupport.ungrouped` probes `useGrouping: false` (the ungrouped fallback strips the group mark). New types: `NumberStyle`, `NumberParts`, `FormatUnit`, `SymbolUnit`, `FormatStrings`. `format.ts` still imports nothing, and the 1.0.1–1.0.3 Hermes rules are intact: every new call is tested against a Hermes-like Intl (no formatToParts, converting units, no ListFormat or date formatRange). RangeChips' screen-reader names ("3 months", unit style `long`) now pass the same output check as `unit` (the plain number and no other digit, else the code is read); before, they were the one unit call without it.
    - Kit strings: 19 → 24 (`unitGram`, `unitMilligram`, `listAnd`, `listOr`, `listSeparator`) in all 11 locales.
  **Icons (`icons.ts`):** new keys `swap`, `link`, `warmUp`, `moveUp`, `moveDown`, `repeat`, `tools`, `document`, `travel`, `stop`, `mic`, `copy`, `bookmark`, `today`, `flag`, `options`, `refresh`, `download`, `retake`, `photoLibrary`, `scanText`, `unselected`, `scale` and `help`, each `{sf, md, ion}` with the Ionicons name the apps used, so the shims' `resolveIcon` finds them and their Ionicons fallbacks can go. `milk` is a glass (`pint-outline`, Material `glass_cup`), no longer identical to `coffee` with the Ionicons renderer.
  **Tooling (`vector-kit.mjs`):**
    - New baselinable rule `lines`: `numberOfLines` on content text (§3.5), in JSX or in a props object spread into Text; `numberOfLines={0}` and Label are exempt. `check --baseline` now records `"kit"` in `vector.allow.json`, and a rule newer than a repo's baseline warns instead of failing until the next baseline, so this sync does not fail any app's `lint` (lift 1, macro 12, water 1 hits today; body none).
    - `sync` never replaces an app-owned file: a different file at a kit path that the repo's own manifest does not list (the first sync's `global.css`, or a path a newer kit starts shipping) stops the sync until `--force`, and sync deletes only files an earlier kit shipped (an app file in `src/vector` is kept and reported). Covered by tests, as is the `lines` rule.
  **Docs:** §5, KIT.md §5 and MIGRATION S4 show the provider order (`VectorAdapter` wraps `HeroUINativeProvider`; `NavigationTheme` wraps the root Stack); §12 records what the simulator verified (Hermes Intl gaps, NavigationTheme, the owned Live Activity in the Lock Screen and Dynamic Island); MIGRATION P1.8 now uses `prebuild --no-clean` (Expo SDK 57 cleans ios/ by default), documents the offline `pod install` with the React Native tarball variables, and drops `-sdk` (it breaks repos with a watch target).
  **After syncing, apps will notice:**
    - Negative readouts and deltas print U+2212; tests that compare formatter output with a hyphen-minus need the new character (macro: `coaching.test.cjs` pace and trend delta, `nutrition.test.cjs` check-in pace, `strategy.test.cjs` pace slider).
    - Shims now resolve the new glyphs, so lift's ActionMenu fallback copy, macro's `LegacySwipeRow` for `repeat` and the Ionicons fallbacks in SystemIcon / SystemButton stop being used for them.
    - Undo stacks above a dock (macro's quick-log bar stays); macro's Editor shim can pass `guarded` straight through and drop its open delay; water can drop its StaticScreen shim, undo strip and Android KeyboardAvoidingView; lift can drop `useWorkoutUndo` and `DetailFooterScreen` (its workout screen gets docked Undo only if `DockProvider` wraps the root Stack).
    - Macro's own tests that transpile `editor.tsx` or render the kit Screen need `./sheets` in their module map and the new dock structure.
- **1.1.0.** Navigation theme and iOS 26 header background (found in the first simulator run: a pushed screen in dark mode showed a white bar with light glass items).
  - New `NavigationTheme` (screen.tsx) and `navigationTheme(scheme)` (native.ts): React Navigation now gets the Vector palette (card and background = canvas, text = foreground, primary = tint, border, notification = danger). Wrap the root `<Stack>` in `<NavigationTheme>` inside `VectorAdapter`. Without it, native-stack fills every unset option from its own light palette (white header, grey screens).
  - `detailHeaderOptions`: on iOS 26 the header background is explicitly `transparent` (unset fell back to the theme card colour), so the canvas shows behind the Liquid Glass bar items.
- **1.0.3.** `format.ts`: `intlSupport.unitStyle` is now behavioural. Hermes on iOS also renders the short pound as "#" ("293#" in the first simulator run), so the load-time probe requires `2 lb` and an unconverted `2 hr`; an engine that fails gets the number + abbreviation fallback for every unit. ICU engines (Android Hermes, Node) keep full localized units.
- **1.0.2.** `format.ts`: Hermes on iOS formats `style: "unit"` through NSMeasurementFormatter, which can convert to another unit (a 38 h elapsed time rendered as "136,800s" in the first simulator run). `unit` and `unitParts` now trust unit output only when it holds the plain number and no other digit, and otherwise fall back to the number plus the unit abbreviation. Covered by a test.
- **1.0.1.** `format.ts`: Hermes on iOS has no `Intl.NumberFormat.prototype.formatToParts`, so `unitParts`, `decimalSeparator` and `parseDecimal` threw "undefined is not a function" on device (found in the first simulator run). `intlSupport.parts` now feature-detects it; without it, the unit and the locale's spacing are read around the plain formatted number. Output is identical to the `formatToParts` path in all 11 locales plus `ar-EG`, and a test covers it.
- **1.0.0.** First release:
  - SIBYL white + signal cyan;
  - flattened 4/2 radius;
  - bundled-fonts-only default;
  - ink categorical ramp;
  - native Toggle;
  - generated CSS / TS / Swift tokens;
  - Liquid Glass rendering-mode kit for widgets, Live Activity and watch;
  - owned lift Live Activity target (iOS 16.4).
