# Next push: improvement plan

September 25, 2026. Built from a code audit of the logging loop, coaching/Progress, data/search, a correctness sweep, platform shortcuts and UI quality. Every serious bug below was independently re-traced by a second reviewer; claims that reviewer refuted are listed at the end so they are not reopened.

The ranking follows how the app is used: 3–4 quick logs a day, a morning weigh-in when Health isn't supplying weights, and one weekly check-in. Success is less time in the app, not more. Everything stays on the phone.

## Status, September 26, 2026

Landed on `roadmap/next-push`: every A item except A2 (needs the native build), B0–B12 (B11 without the catalog rebuild), and a MacroFactor parity batch requested after the owner shared screenshots of their MacroFactor setup:

- **Progress** is a dashboard: weekly nutrition grid (consumed/remaining), daily expenditure estimate with a range and holding periods, weight trend with scale weight, goal line and 1W–All ranges.
- **Plan** opens on a check-in countdown and the program's week, with **calorie shifting**: higher weekdays inside the same weekly budget; check-ins keep working on the unshifted budget.
- **Today** has a week strip with calorie rings, hour headings with kcal and P/F/C and a **+** per hour, food icons, and a quick-log bar pinned above the tab bar on Today, Progress and Plan (search, barcode, on-device AI, and **+** for Log again).
- **The logger** gives search results the screen, and the portion screen has unit chips (g, oz, volumes, the food's own portions, kcal), an in-app keypad with fractions, live target rings, and remembers each food's unit.

Each item was built with tests, reviewed from a correctness and a product angle, and fixed; a whole-branch review then found and fixed 10 further defects, several of them interactions between features built in parallel. 285 tests pass in several time zones. Simulator checks covered Home, the logger, search, Progress, Expenditure, Plan and the food log; the device acceptance checklist in [MVP validation](mvp-validation.md) still applies.

Next: the native batch (N1–N4 and A2), then section C. Calorie shifting moved from C into the parity batch.

## Ground rules

- JS/TS work lands first, one commit per item, each passing `pnpm typecheck && pnpm lint && pnpm test`.
- Native modules and Info.plist changes are batched so they need one new build.
- A pre-migration database snapshot lands before any new migration.
- Catalog install/cleanup hardening lands before any catalog version bump.

## A. Confirmed bugs

| #   | Bug                                                                                                                        | Where                                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| A1  | Health sync is all-or-nothing: declining waist or body-fat write access stops every weight import                          | `health-native.ios.ts`, `health-native.android.ts`, `health.ts`    |
| A2  | Camera/photo permission prompts describe progress photos, not meal, label and barcode capture                              | `app.json` (native build)                                          |
| A3  | Label OCR reads "Sodium 1,160mg" as 1.16 mg                                                                                | `nutrition-label.ts`                                               |
| A4  | AI logging treats "30 g" of a per-serving food as 30 servings; "lbs"/"kgs" not recognized                                  | `meal-ai.ts`                                                       |
| A5  | Model JSON extraction fails when trailing text contains a brace; truncated arrays are lost                                 | `model-json.ts`                                                    |
| A6  | Branded-dish cleanup can drop real sides and double-count collapsed parts                                                  | `meal-ai.ts`                                                       |
| A7  | Editing any field of an entry rewrites its portion label and drops the "≈" estimate marker                                 | `food-editor.tsx`                                                  |
| A8  | Deleting an entry turns a "Not fully logged" day back to in-progress, so Home asks again                                   | `diary.ts`                                                         |
| A9  | A program rebuilt after a manual period is due for check-in the day it is created                                          | `coaching-store.ts`                                                |
| A10 | One outlier Health weight holds coaching for ~3 weeks without saying which reading                                         | `program.ts`, check-in UI                                          |
| A11 | Check-in weight query uses a UTC end of day, dropping evening weigh-ins west of UTC                                        | `coaching-store.ts`                                                |
| A12 | Editing the program on check-in day blends the same evidence twice in the preview                                          | `coaching-store.ts`                                                |
| A13 | Unanswered days older than 7 days are never asked about but still block learning                                           | `diary.ts`                                                         |
| A14 | Pace can read "−0.0 kg/wk"                                                                                                 | `home-check-in.tsx`                                                |
| A15 | "Targets saved" never appears after targets change                                                                         | `plan-screen.tsx`                                                  |
| A16 | Time entry rejects "9:30", "930" and "9:30 pm" while Home shows 12-hour times                                              | `food-time.ts`, `time-field.tsx`                                   |
| A17 | UPC-E barcodes (cans, gum, candy) can't be scanned or typed                                                                | `nutrition.ts`, `food-editor.tsx`                                  |
| A18 | The barcode camera stops scanning after a rejected code                                                                    | `food-editor.tsx`                                                  |
| A19 | Logging from Library in the classic meal layout defaults to Breakfast                                                      | `food-editor.tsx`                                                  |
| A20 | Selected portion chip is hard to see in light mode; light accent/link colour fails contrast                                | `fast-logger.tsx`, `global.css`                                    |
| A21 | Diary CSV is sorted by save time, not eaten time, and omits fasting days                                                   | `data-ownership.ts`                                                |
| A22 | Erased rows can remain in SQLite free pages                                                                                | `data-ownership.ts`                                                |
| A23 | Favorites fall off "Log again" once recent history fills the list                                                          | `fast-log.ts` → fixed by B4                                        |
| A24 | Search buries staple foods ("chicken", "rice", "eggs"), has no plural/stopword handling, no history boost and hides brands | `food-catalog.ts`, `nutrition.ts`, `fast-logger.tsx` → fixed by B2 |
| A25 | An interrupted catalog copy can leave search unavailable; every catalog update leaves the old ~50 MB copy behind           | `food-catalog.ts` → fixed by B11                                   |

## B. Features, in priority order

| #   | Feature                                                                                                                                                  | Native build?  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| B0  | Snapshot the database before pending migrations, with a way to share the copy from the migration-error screen                                            | No             |
| B1  | Speed foundation: cache screen reads per data revision instead of re-running 10–20 SQLite reads on every render; WAL; one coaching snapshot per revision | No             |
| B2  | One ranked search: stemming, stopwords, deeper candidate pool, personal-history boost, brand shown on rows; a search-quality test basket                 | No             |
| B3  | Photo logging in 3 taps: prewarm the model on Home, analyze as soon as the shutter fires, re-run on description edits                                    | No             |
| B4  | "Log again" that learns: frequency × recency × time-of-day scoring, favorites always visible                                                             | No             |
| B5  | Amounts in real units: "2 slices", "½ cup", "1 1/2 servings", or "300 kcal" of a food; remembered per food                                               | No (migration) |
| B6  | Fast fixes: swipe to delete with Undo, multi-select move/copy/delete, Undo on every diary write, one-tap time chips                                      | No             |
| B7  | Stop the daily "Finish yesterday" question for days that were clearly logged in full (setting, with Undo)                                                | No             |
| B8  | Deep-link actions: `macrotrack://log`, `/scan`, `/photo`, `/weigh-in` open straight into the right sheet                                                 | No             |
| B9  | Check-in parity: adjust the proposal before accepting, custom protein/carb split while coached, one-tap Maintain at goal, ignore an outlier weight       | No (migration) |
| B10 | Progress at a glance: this week vs budget, weight trend vs goal with projected date, expenditure history                                                 | No             |
| B11 | Catalog install hardening: atomic install, old-version cleanup, excluded from device backup                                                              | No             |
| B12 | Small wins: Quick add works out kcal from macros; barcode remembers the last quantity; "Scan another"                                                    | No             |
| N1  | Home-screen quick actions (long-press icon: Photo, Scan, Log food, Log weight) via B8                                                                    | Yes            |
| N2  | Local reminders: morning weigh-in (only without Health weights), check-in due, optional "nothing logged yet"                                             | Yes            |
| N3  | iOS Home/Lock Screen widget: calories left, pace, P/C/F                                                                                                  | Yes            |
| N4  | App Intents/App Shortcuts: Siri, Spotlight and the Action Button open B8 actions                                                                         | Yes            |

## C. Later

Maintenance breaks and paused check-ins; Health reconciliation after restore (link instead of duplicating) and anchored incremental reads; backup v2 with preferences and height; one shared food-picker component; splitting today-screen/food-editor/photo-logger as features touch them; one sheet layout everywhere; VoiceOver labels that include kcal/time/portion; known fiber/sodium totals instead of "—"; removing the inherited Body Track screens and hiding the language picker until nutrition screens are translated; EAS Update for JS-only fixes; catalog v2 with porter stemming, merged OFF duplicates and a typo vocabulary; Android widget; Control Center control.

## Checked and intentionally unchanged

- A late check-in moving the next one out is the documented spacing rule (`coaching.md`), not a bug.
- Editing sex or activity after a program exists keeps the learned expenditure baseline by design; a "Recalculate starting estimate" option is backlog.
- No Live Activity: logging a meal has no ongoing event to show.
