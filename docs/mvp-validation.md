# Macro Track MVP — September 25, 2026

## What is ready for internal use

- Offline search of 90,730 US foods, exact barcode lookup, camera scanner and personal-food fallback.
- Dated four-meal diary with quantities, common portions, editing/deletion, favorites, recents and explicit completeness states.
- Quick calorie/macro estimates, saved meals, whole-day and meal copying.
- Recipes with ingredient snapshots, equal servings and optional cooked batch mass for weighed portions.
- Manual calorie/macro baselines; lose/maintain/gain goals; local 21-day calibration and weekly review with explicit accept/keep decisions and conservative holds.
- Weight history, trend charts, optional health integration, complete-day intake averages and next check-in.
- Encrypted backup/restore with a verified pre-restore recovery copy, readable food/weight CSV export, and confirmed local erasure.
- Bundled catalog version information and offline coaching-method explanation. Catalog refreshes arrive with app releases.

The ordinary first-use path is Plan → enter daily targets and choose a goal → Today → add food → Progress → add weight. Mark each finished diary day complete. Coaching uses the preceding 21 days and requires three weigh-in days per week. Manual logging and targets are usable immediately without calibration, accounts, network calls or health permission.

## Verification performed

| Check                                      | Result                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| TypeScript                                 | Passed                                                                 |
| ESLint                                     | Passed, no warnings                                                    |
| Automated tests                            | 45 passed                                                              |
| Production iOS and Android JS/asset export | Passed                                                                 |
| iOS native debug build                     | Passed, installed and launched on iPhone 17 simulator (iOS 26.5)       |
| Android native arm64 debug build           | Passed                                                                 |
| Latest database migrations                 | Exercised by tests using real SQLite and the production Drizzle driver |

Tests include compiler-transformed UI refresh, food arithmetic, source catalogs/search/barcodes, immutable history, saved meals, weighed recipe portions, copy rollback, quick-add double taps, missing logging data, water-weight jumps, bounded check-ins, weekly cadence, target history, backward-compatible backups, encryption/tamper rejection, restore rollback/recovery, CSV escaping and transactional erasure. They do not substitute for real-device UX checks or clinical validation.

Build logs and final bundle are in `/private/tmp/macro-track-mvp-*` on the development machine. These are temporary verification artifacts, not release builds.

## Before public release

1. Run the phone checklist below on actual iOS and Android devices. Native UI inspection through the available simulator automation repeatedly timed out, so no screenshot-based final visual QA is claimed.
2. Review the coaching method with a qualified nutrition professional before marketing its recommendations as validated. The baseline is user supplied; the estimator is an approximate local method with documented limits, not MacroFactor's algorithm.
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

Local meal-photo AI, nutrition-label OCR, profile-based initial calorie estimates, optional signed food-pack downloads/cleanup, multi-food selection, advanced micronutrients, reminders/widgets, restaurant coverage, paid entitlements and translated nutrition screens. Photo AI/OCR need a separate native prototype and physical-device accuracy/performance validation. No cloud AI fallback is silently used.
