# Macro Track

An offline nutrition tracker for iPhone and Android, forked from Vector Body. Public branding is still undecided. See [the product plan](docs/macro-track-plan.md).

## Working foundation

- Today: date navigation, calories/macros, meals, logging status, add/edit/delete entries.
- Offline food search across **7,793 USDA SR Legacy foods** and **82,937 US packaged foods** from the full Open Food Facts CSV export.
- Camera barcode scanning and typed barcode lookup, with a custom-food fallback.
- Gram, milliliter, and serving quantities; source-provided common portions; nutrition snapshots that preserve historical totals.
- Personal foods, favorites, and recent foods.
- Saved meals with adjustable quantities, plus copying meals between dates and meal slots. Tap **Reuse meal** below a logged meal, or open **Saved meals** from Today or Library. Copies preserve nutrition snapshots and remain independently editable.
- Recipes: add ingredients from food search, specify the number of servings in a batch, and log whole or fractional servings. Create and edit recipes in Library; recipes also appear in food search. Edits update future recipe portions without changing past diary entries.
- Manual targets with effective dates; later revisions preserve earlier days.
- Inherited weight history, smoothed trend, and opt-in HealthKit / Health Connect integration.
- Distinct `dev.svindland.macrotrack` application IDs, `macrotrack://` scheme, private `macro_track.db`, and app icon.

Adaptive coaching/check-ins, label OCR, meal-photo AI, portable backup/restore, and downloadable catalog updates are not implemented yet. New nutrition screens currently use English; the inherited localization infrastructure remains available. Native camera/health behavior and the complete UI still need device QA before release.

The September 25 update adds reusable meals and refreshes the diary, meal cards, food results, shared controls and light/dark surfaces. Reload a running development app after pulling this update so the new saved-meals migration runs. The saved-meal flow supports half/double quantities, retains existing destination entries, and never changes past logs when a saved meal is removed.

The recipe follow-up adds its own local storage migration, so reload once before trying **Library → Create recipe**. Recipe yield currently uses equal servings, not finished batch weight. Ingredients retain the nutrition selected when the recipe was built; previously saved meals also retain their own snapshots. Recipe deletion removes it from reusable search/favorites while preserving logged history.

## Development

Use Node 24 and pnpm 11.26 (see `.nvmrc` and `package.json`).

```sh
pnpm install
pnpm start
pnpm ios
pnpm android
```

Expo Go can preview the diary, food catalogs and weight screens. Health sync requires a native build. Camera scanning requires camera permission and a device with a usable camera. Food search does not call a remote API. Expo Go downloads development assets from Metro; production builds bundle them locally.

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
