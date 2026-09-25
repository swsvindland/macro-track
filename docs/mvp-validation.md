# Macro Track MVP — September 25, 2026

## What is ready for internal use

- Offline search of 90,730 US foods, exact barcode lookup, camera scanner and personal-food fallback.
- Dated hourly timeline (with optional classic meals) with quantities, common portions, editing/deletion, favorites, recents and explicit completeness states.
- One-tap repeat foods/meals with Undo, multi-food selection with remembered portions, fixed Log/Scan controls, quick calorie/macro estimates, saved meals, whole-day and meal copying.
- Recipes with ingredient snapshots, equal servings and optional cooked batch mass for weighed portions.
- Guided Cut/Bulk/Maintain programs; generated calorie/macro baselines; normalized-weight learning and weekly review with explicit accept/keep decisions and conservative holds.
- Weight history, trend charts, optional health integration, complete-day intake averages and next check-in. Due check-ins can be accepted or kept directly on Today.
- Encrypted backup/restore with a verified pre-restore recovery copy, readable food/weight CSV export, and confirmed local erasure.
- Bundled catalog version information and offline coaching-method explanation. Catalog refreshes arrive with app releases.

The ordinary first-use path is Plan → Build my program → Today → add food → Progress → add weight. Mark each finished diary day complete. Method 2 examines the preceding 21 days, using at least 12 covered days in complete blocks of seven or more and six weigh-in days. Gaps can pause updates without resetting learning. Manual logging and targets are usable immediately without calibration, accounts, network calls or health permission.

## Verification performed

| Check                                      | Result                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| TypeScript                                 | Passed                                                                 |
| ESLint                                     | Passed, no warnings                                                    |
| Automated tests                            | 61 passed                                                              |
| Production iOS and Android JS/asset export | Passed                                                                 |
| iOS native debug build                     | Passed, installed and launched on iPhone 17 simulator (iOS 26.5)       |
| Android native arm64 debug build           | Passed                                                                 |
| Latest database migrations                 | Exercised by tests using real SQLite and the production Drizzle driver |

Tests include compiler-transformed UI refresh, food arithmetic, source catalogs/search/barcodes, immutable history, saved meals, weighed recipe portions, copy rollback, quick-add double taps, missing logging data, water-weight jumps, bounded check-ins, weekly cadence, target history, backward-compatible backups, encryption/tamper rejection, restore rollback/recovery, CSV escaping and transactional erasure. They do not substitute for real-device UX checks or clinical validation.

Latest fast-logging production exports are in `/private/tmp/macro-track-speed`; prior native build logs are in `/private/tmp/macro-track-mvp-*` on the development machine. These are temporary verification artifacts, not release builds.

## Before public release

1. Run the phone checklist below on actual iOS and Android devices. Native UI inspection through the available simulator automation repeatedly timed out, so no screenshot-based final visual QA is claimed.
2. Review the coaching method with a qualified nutrition professional before marketing its recommendations as validated. The baseline is a provisional profile-based estimate; the estimator is an approximate local method with documented limits, not MacroFactor's algorithm.
3. Publish the distributed OFF-derived database and license notices, choose final branding, create a separate Macro Track EAS project, and complete store privacy/screenshots/signing setup. Do not reuse Vector Body's EAS project.
4. Exercise OS health reconciliation after backup restore; reconnecting an existing history can duplicate external weight records. Restore and erasure switch sync off.
5. Test large-backup performance, interrupted restores, low storage and app-upgrade catalog installation on supported phones.

## Device acceptance checklist

- Fresh install in airplane mode: search USDA ingredients and a known packaged barcode, save food, restart, verify history.
- Scan a real barcode; deny camera permission; create a missing food; try decimal portions, grams, milliliters and servings.
- Edit/move/delete a food; copy a meal/day into a nonempty destination; confirm no double-tap duplicates.
- Build a recipe with cooked weight, log by grams, edit ingredients, verify the older diary entry stays unchanged.
- Switch day/month, cross midnight, change units, test large text, keyboard scrolling and light/dark themes.
- Add/backdate/edit a weight; verify Progress and Plan refresh immediately. Test health permission denied, partial grant, import, export and sync failure.
- Export encrypted backup through Files and Android document providers; restore it, test wrong password, export/recover the pre-restore copy, and confirm historical goals/check-ins remain.
- Export both CSVs, inspect non-English names and missing nutrient cells. Confirm erasure cancels safely, then use disposable test data to verify its actual deletion scope.

## Explicitly outside this MVP

Nutrition-label OCR, optional signed food-pack downloads/cleanup, advanced micronutrients, reminders/widgets, restaurant coverage, paid entitlements and translated nutrition screens. No cloud AI fallback is silently used.

Photo and description logging now exists on phones with Apple Intelligence or Gemini Nano ([details](ai-logging.md)). It has simulator and on-Mac model evaluation only; the plan's physical-device accuracy/performance gate and an Android device run are still required before release.

## Program and timeline follow-up

The official MacroFactor feature review identified important prototype gaps; the follow-up adds guided automatic targets, normalized weight in coaching, weight-based protein, dynamic maintenance, configurable check-in day and retained expenditure learning across goal changes. It does not claim to reproduce MacroFactor's private estimation algorithm. The remaining clinical/device QA gates above still apply.

The diary now stores an explicit local `HH:mm` alongside the selected date. Changing time moves an entry between hourly groups; calendar-day totals do not change. Whole-day copies retain times. Saved meals and hour reuse log at the chosen destination time. Older entries and backups have null times and stay visible under their former meal labels. Times do not move when the phone changes timezone. CSV exports include local time. Food-diary layout preferences remain local settings and are not part of the portable nutrition backup.

Additional tests cover guided program creation, fixed weight-based protein under calorie changes, maintenance drift, completed goals, incomplete intervals, retained learning, timeline grouping/order, edits between hours, hour reuse, whole-day time preservation and old-backup compatibility. The update changes no native dependencies; both production platform bundles were regenerated.

## Fast daily use follow-up

Home now prioritizes remaining calories, macro totals, due check-ins and familiar food shortcuts. Repeat logging is one tap with safe Undo. The multi-food logger has local search, remembered quantities, a compact selection review, retained scan selections and one atomic save. Detailed logging controls remain available under More options. Fixed controls account for the native tab bar; the editor keeps Save outside the scrolling results.

Recent-food lookup uses a new index; non-Home screens defer their first render until visited and retain their state afterward. No native dependencies were added. The current 61-test run includes compiled logger/Home behavior, check-in acceptance and holds, safe undo, duplicate-tap protection, and an SQLite query-plan check. TypeScript, lint and both production platform exports passed. Visual inspection through the simulator automation timed out again; no elapsed-time claims or final visual QA are made. See [fast logging validation](fast-logging.md) for the phone protocol and proposed timing budgets.
