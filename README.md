# Macro Track

An offline nutrition tracker for iPhone and Android, forked from Vector Body. Public branding is still undecided. See [the product plan](docs/macro-track-plan.md).

## Usable MVP

- Home: calories left with an "on pace / heading over" projection from your own recent complete days, macros against targets, one due task at a time (morning weigh-in → confirm an unfinished day → weekly check-in), in-page Log food and Scan, Undo after every diary change, and a compact time-grouped food list where a swipe deletes or logs again and a long press moves, copies or deletes several foods. A compact header handles dates, day status and copying; Settings is a tab. Classic meal layout remains in Settings. Older entries remain visible with time unset.
- Links for an iOS Shortcuts **Open URL** action, for example on the Action Button: `macrotrack://log`, `macrotrack://scan`, `macrotrack://photo` and `macrotrack://weigh-in` open Today on the food logger, the barcode scanner, the photo logger (the food logger on phones that can't run the model) or the Log weight sheet, whether the app was closed or already open. Unknown links open Today.
- Offline food search across **7,793 USDA SR Legacy foods** and **82,937 US packaged foods** from the full Open Food Facts CSV export.
- Camera barcode scanning and typed barcode lookup (EAN-13, EAN-8, UPC-A, UPC-E and ITF-14), with a custom-food fallback. For an unknown product, photograph its Nutrition Facts label and the new food fills itself in with on-device text recognition; see [nutrition label scanning](docs/label-scanning.md).
- Photo and description logging with the phone's own model (Apple Intelligence on iPhone, Gemini Nano on supported Android phones): a photo, a sentence, or both become an editable draft of catalog foods and estimated portions. Chain and packaged items are logged whole; unbranded dishes are split into components. Nothing leaves the phone. See [photo and description logging](docs/ai-logging.md).
- Gram, milliliter, and serving quantities; source-provided common portions; nutrition snapshots that preserve historical totals.
- Personal foods, favorites, and recent foods. The meal logger selects multiple foods in one screen, remembers quantities, retains selections while scanning, and saves the meal once.
- Saved meals with adjustable quantities, plus copying meals between dates and meal slots. Choose **Save or copy this meal** from a meal’s ··· menu on Today; saved meals appear under Log again in the logger and in Library. Copies preserve nutrition snapshots and remain independently editable.
- Recipes: add ingredients from food search, specify the number of servings in a batch, and log whole or fractional servings. Create and edit recipes in Library; recipes also appear in food search. Edits update future recipe portions without changing past diary entries.
- Guided Cut/Bulk/Maintain programs generate calories and macros from your profile, goal and preferences. Weekly reviews use normalized weight and observed intake; maintenance gently corrects drift around a target weight. Goal changes preserve learning. Manual mode remains available. See [coaching method and limits](docs/coaching.md).
- Quick-add estimates, whole-day copying, and optional cooked batch weights for gram-based recipe portions.
- Progress includes complete-day intake averages and the next check-in.
- Readable food/weight CSV exports and confirmed local personal-data erasure.
- Inherited weight history, smoothed trend, and opt-in HealthKit / Health Connect integration.
- Password-protected local backup and restore in Settings, with an automatic encrypted recovery copy before replacement. See [backup scope and recovery](docs/backups.md).
- Distinct `dev.svindland.macrotrack` application IDs, `macrotrack://` scheme, private `macro_track.db`, and app icon.

A downloadable AI model for phones without Apple Intelligence or Gemini Nano and downloadable catalog updates are not implemented yet. Catalog refreshes ship through app updates. New nutrition screens currently use English; the inherited localization infrastructure remains available. Native camera/health behavior and the complete UI still need device QA before release.

Start with **Plan → Build my program**, then choose Cut, Bulk or Maintain. Log food from **Today**. Without Health weights, Today asks for a morning weigh-in; it also asks you to confirm recent days were fully logged, which weekly check-ins need, unless yesterday was clearly logged in full (Settings → **Count logged days as complete**). **Library** holds personal foods, saved meals and recipes. Due check-ins appear directly on Today (after the morning weigh-in and day confirmation) with Accept/Keep actions and expandable evidence; **How check-ins work** is available offline in Plan. Settings contains encrypted backups, CSV exports and data erasure.

Reload after pulling changes so all personal-database migrations run. The app copies the database before migrating and keeps the last two copies (see [backups](docs/backups.md#pre-migration-copies)). The native client must include the camera, document picker, sharing and crypto modules, and the local `modules/local-ai` module for photo logging (rebuild the dev client after pulling it). Guided programs generate provisional starting targets from your profile and refine them with normalized weight and food intake. Manual targets remain optional.

## Development

Use Node 24 and pnpm 11.26 (see `.nvmrc` and `package.json`).

```sh
pnpm install
pnpm start
pnpm ios
pnpm android
```

Expo Go can preview the diary, food catalogs and weight screens. Health sync and photo logging require a native build; photo logging on the iOS simulator needs a Mac with Apple Intelligence turned on. Android builds pin Kotlin 2.2.21 (`plugins/with-kotlin-plugin-version.js`) for ML Kit GenAI. Camera scanning requires camera permission and a device with a usable camera. Food search does not call a remote API. Expo Go downloads development assets from Metro; production builds bundle them locally.

The inherited EAS project ID has been removed deliberately. Link a **new Macro Track EAS project** before remote builds or submission. Do not reconnect the old Vector Body project. Generated native folders are ignored and regenerated from app configuration.

## Food catalog builds

The full OFF export is tab-delimited despite its `.csv.gz` name. The importer reads compressed rows incrementally. It filters to US market tags, valid GTINs, usable core nutrients and explicit mass/volume servings; it does not treat missing values as zero or convert milliliters into grams. The exported CSV omits some unit metadata, so the importer conservatively skips ambiguous records.

Download these public sources outside the repository:

- [USDA SR Legacy JSON ZIP](https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_json_2018-04.zip)
- [Open Food Facts full CSV gzip](https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz)

```sh
python3 scripts/build-food-catalog.py --usda /path/usda.zip --off /path/off-full.csv.gz
```

Use a `.csv.gz` filename for CSV input; `.jsonl.gz` sample input is also supported. Python's standard library is sufficient. The output is two source-separated SQLite catalogs, approximately **48.5 MiB combined**, with FTS5 and barcode indexes. `assets/food/manifest.json` records source/recipe hashes, counts, catalog versions and output sizes. Keep large raw downloads out of Git.

USDA data are CC0. The OFF-derived catalog is ODbL 1.0. See [attribution and distribution notes](assets/food/ATTRIBUTION.md). Make the distributed OFF database and license notices publicly accessible before public release.

Catalog filenames include the source and build-recipe version, so an app update installs a new reference catalog without replacing personal records. The old catalog is currently retained; automatic cleanup and signed downloadable updates belong to the next catalog-management milestone. The importer is a development/release tool, not an in-app download feature.

## Verification

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm exec expo export --platform ios --platform android
```

Tests use real SQLite with the production Drizzle driver and cover migrations, health sync, source catalog integrity, search, barcode normalization, quantity arithmetic, unknown nutrients, history snapshots, dated targets and logging completeness. These checks do not replace physical-device camera, Health permission or UI testing.

The September 24, 2026 foundation passed all 21 automated tests, TypeScript and lint checks, iOS simulator compilation/installation, Android arm64 debug compilation, and production JavaScript/asset exports for both platforms. See [the milestone report](docs/foundation-validation.md) for catalog measurements and remaining QA.

The documentation and store assets under `docs/app-store/` were inherited from Body Track and are reference material, not ready-to-submit Macro Track assets.

See [MVP validation and release gates](docs/mvp-validation.md) for the latest verified scope.

See [the MacroFactor feature review](docs/macrofactor-feature-review.md) for the researched comparison and remaining gaps.

See [fast logging flows and device timing targets](docs/fast-logging.md) for interaction budgets and the speed validation protocol.
