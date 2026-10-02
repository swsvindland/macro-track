# Vector Macros

An offline nutrition tracker for iPhone and Android, forked from Vector Body. The home-screen label is **Macros**, since the full name is cut off under an icon; the internal project name, slug, `macrotrack://` scheme, database and backup identifiers stay `macro-track` so existing installs and backups keep working. See [the product plan](docs/macro-track-plan.md).

## Usable MVP

- Home: calories left with an "on pace / heading over" projection from your own recent complete days, macros against targets, one due task at a time (morning weigh-in → confirm an unfinished day → weekly check-in), a quick-log bar pinned above the tab bar (also on Progress and Plan) with food search, on-device AI photo logging where the phone runs it, and barcode scanning, Undo after every diary change, and a compact time-grouped food list with each hour's calories and macros, a **+** per hour, and rows where a swipe deletes or logs again and a long press moves, copies or deletes several foods. A week strip of each day's calories against target moves between days, and a ··· menu on the summary handles day status, weight and copying; Settings is a tab. Classic meal layout remains in Settings. Older entries remain visible with time unset.
- Links for an iOS Shortcuts **Open URL** action, for example on the Action Button: `macrotrack://log`, `macrotrack://search`, `macrotrack://scan`, `macrotrack://photo` and `macrotrack://weigh-in` open Today on the food logger, the food logger with the keyboard up, the barcode scanner, the photo logger (the food logger on phones that can't run the model) or the Log weight sheet, whether the app was closed or already open. Unknown links open Today.
- Offline food search across **7,793 USDA SR Legacy foods** and **3,192,971 packaged foods** from 184 countries in the full Open Food Facts export (740,527 sold in the US), forgiving typos ("chiken brest", "protien bar") and words typed without their space ("peanutbutter"), with products sold in the phone's region, then the ones people scan most, first among packaged foods. Barcode lookup finds a product from any country.
- Micronutrients: up to 34 nutrients per food (sugars, fat types, cholesterol, vitamins, minerals, caffeine) from USDA and Open Food Facts, shown on a food and for the day against FDA Daily Values, counting only what each food's record actually lists.
- Camera barcode scanning and typed barcode lookup (EAN-13, EAN-8, UPC-A, UPC-E and ITF-14), with a custom-food fallback. For an unknown product, photograph its Nutrition Facts label and the new food fills itself in with on-device text recognition; see [nutrition label scanning](docs/label-scanning.md).
- Photo and description logging with the phone's own model (Apple Intelligence on iPhone, Gemini Nano on supported Android phones): a photo, a sentence, or both become an editable draft of catalog foods and estimated portions. Chain and packaged items are logged whole; unbranded dishes are split into components. Nothing leaves the phone. See [photo and description logging](docs/ai-logging.md).
- Amounts in grams, ounces, volumes the food can convert, its own portions ("slice", "serving") or kcal, typed on an in-app keypad with fractions ("1 1/2", "½"); each food reopens at the unit and count last logged; nutrition snapshots that preserve historical totals.
- Personal foods, favorites, and recent foods. The meal logger selects multiple foods in one screen, remembers quantities, retains selections while scanning, and saves the meal once.
- Saved meals with adjustable quantities, plus copying meals between dates and meal slots. Choose **Save or copy this meal** from a meal’s ··· menu on Today; saved meals appear under Log again in the logger and in Library. Copies preserve nutrition snapshots and remain independently editable.
- Recipes: add ingredients from food search, specify the number of servings in a batch, and log whole or fractional servings. Create and edit recipes in Library; recipes also appear in food search. Edits update future recipe portions without changing past diary entries.
- Guided Cut/Bulk/Maintain programs generate calories and macros from your profile, goal and preferences. Weekly reviews use normalized weight and observed intake; maintenance gently corrects drift around a target weight. Optional calorie shifting gives chosen weekdays more inside the same weekly budget. Goal changes preserve learning. Manual mode remains available. See [coaching method and limits](docs/coaching.md).
- Quick-add estimates (calories worked out from macros when left blank), whole-day copying, and optional cooked batch weights for gram-based recipe portions.
- Progress at a glance: the week's calories, protein, fat and carbs day by day against target, a daily expenditure estimate and the weight trend (each opens a chart with 1W–All ranges), the week's complete-day average against budget with "~X kcal/day for the rest of the week lands on budget" (or how far over or under the week is when that would stray more than 500 kcal from target), the projected goal date and the next check-in. Add a weight from its header; the full weight history opens from Weight trend.
- Readable food/weight/targets CSV exports and confirmed local personal-data erasure.
- Inherited weight history, smoothed trend, and opt-in HealthKit / Health Connect integration.
- Password-protected local backup and restore in Settings, with an automatic encrypted recovery copy before replacement. See [backup scope and recovery](docs/backups.md).
- Distinct `dev.svindland.vector.macro` application IDs, `macrotrack://` scheme, private `macro_track.db`, and app icon.

A downloadable AI model for phones without Apple Intelligence or Gemini Nano and downloadable catalog updates are not implemented yet. Catalog refreshes ship through app updates. New nutrition screens currently use English; the inherited localization infrastructure remains available. Native camera/health behavior and the complete UI still need device QA before release.

Start with **Plan → Build my program**, then choose Cut, Bulk or Maintain. Log food from **Today**. Without Health weights, Today asks for a morning weigh-in; it also asks you to confirm recent days were fully logged, which weekly check-ins need, unless yesterday was clearly logged in full (Settings → **Count logged days as complete**). **Library** holds personal foods, saved meals and recipes. Due check-ins appear directly on Today (after the morning weigh-in and day confirmation) with Accept/Keep/Adjust actions and expandable evidence. Plan opens on a countdown ring to the next check-in (its outer arc shows progress toward a cut or bulk goal) with a due check-in right below, then the running program: its start date and each weekday's calories and protein/fat/carbs. Tap the program to edit it; **How check-ins work** is available offline in Plan. Settings contains encrypted backups, CSV exports and data erasure.

Reload after pulling changes so all personal-database migrations run. The app copies the database before migrating and keeps the last two copies (see [backups](docs/backups.md#pre-migration-copies)). The native client must include the camera, document picker, sharing and crypto modules, and the local `modules/local-ai` module for photo logging (rebuild the dev client after pulling it). Guided programs generate provisional starting targets from your profile and refine them with normalized weight and food intake. Manual targets remain optional.

## Development

Use Node 24 and pnpm 11.26 (see `.nvmrc` and `package.json`). The food catalogs in `assets/food/*.db` are stored with [Git LFS](https://git-lfs.com): run `git lfs install` once before cloning, or `git lfs pull` after. Without it they are small pointer files that the app and tests can't open.

```sh
pnpm install
pnpm start
pnpm ios
pnpm android
```

Expo Go can preview the diary, food catalogs and weight screens. Health sync and photo logging require a native build; photo logging on the iOS simulator needs a Mac with Apple Intelligence turned on. Android builds pin Kotlin 2.2.21 (`plugins/with-kotlin-plugin-version.js`) for ML Kit GenAI. Camera scanning requires camera permission and a device with a usable camera. Food search does not call a remote API. Expo Go downloads development assets from Metro; production builds bundle them locally.

The inherited EAS project ID has been removed deliberately. Link a **new Vector Macros EAS project** before remote builds or submission. Do not reconnect the old Vector Body project. Generated native folders are ignored and regenerated from app configuration.

## Food catalog builds

The importer reads Open Food Facts' full JSONL export, compressed or not, across every core: on a 10-core Mac the 83 GB file's 4.8 million products take about two minutes, and the whole build three and a half. It keeps products from every country with a valid GTIN, a name and usable core nutrients; it does not treat missing values as zero or convert milliliters into grams.

Products in Open Food Facts' newer nutrition format record where each value came from and what it was entered per. Only label values count (packaging or manufacturer); values OFF estimates from the ingredient list, such as added sugar or vitamins, are left out. Each value's basis is what it was entered as: per 100 g, per 100 ml, or per serving in the serving's unit, read from the serving label where it prints one ("1 cup (55 g)" is grams even where OFF read ml). OFF's single combined basis can be wrong (a smoothie's per-100 ml label filed per 100 g), so it isn't used. Older records hold per-100 ml values under a per-100 g default, so their basis comes from units printed on the product: the serving label's one unit (g, ml, oz or fl oz); where that label prints both, as in "1/4 cup (60 ml) (80.1 g)", the one whose amount is OFF's `serving_quantity`; otherwise the unit the package is sold in ("1.89L" is per 100 ml, "10 oz" per 100 g); and per 100 g only when nothing prints a unit. `basisFromServingQuantity` and `basisFromPackage` in the manifest count the package and serving-quantity readings.

Of the 4,787,849 products in the export downloaded October 2, 2026, 3,192,971 are bundled: 465,633 lack a valid barcode or name, 1,112,921 lack complete, plausible calories, protein, carbs and fat, 16,292 have no clear per-100 g or ml basis, and 32 repeat a code. A product sold in the US, UK, Canada, Australia, New Zealand or Ireland is named in English when OFF has an English name; others keep the name printed in their own language. Each product keeps the countries it is sold in, and search ranks packaged foods the phone's region doesn't sell below the ones it does, since a brand's recipe differs between countries.

The CSV export (`en.openfoodfacts.org.products.csv.gz`) is still read, but it leaves out the nutrition of every product in the newer format and mixes OFF's ingredient estimates into its label columns. That is why the earlier US-only catalog counted 734,577 US products with no nutrition and bundled 88,229: from the JSONL export the US has 740,527.

Micronutrients come from USDA as measured and from Open Food Facts in grams, converted to each nutrient's label unit. A packaged food's value above twice the richest USDA food's is a unit slip and is dropped, as is a part larger than its whole (saturated fat over total fat). Open Food Facts fills voluntary nutrients with zeros nobody measured, so only nutrients a US label must list keep a zero.

Download these public sources outside the repository:

- [USDA SR Legacy JSON ZIP](https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_json_2018-04.zip)
- [Open Food Facts full JSONL gzip](https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz) (decompress it to read it in parallel)

```sh
python3 scripts/build-food-catalog.py --usda /path/usda.zip --off /path/openfoodfacts-products.jsonl
```

SR Legacy no longer changes, so `--usda` is optional: without it the bundled USDA catalog is kept (checked against its manifest hash) and only Open Food Facts is rebuilt.

A `.jsonl` file is split into byte ranges the worker processes read themselves; a `.jsonl.gz` is read in order and handed to them; `.csv` or `.csv.gz` reads the CSV export. Python's standard library is sufficient. The output is two source-separated SQLite catalogs, approximately **561 MiB combined** (about 240 MB compressed in an app download), with FTS5 and barcode indexes, a `terms` table of each catalog's words for typo correction, and a popularity score from Open Food Facts scan counts. `assets/food/manifest.json` records source/recipe hashes, counts, catalog versions and output sizes. Keep large raw downloads out of Git.

The packaged catalog is built for size and keystroke speed. Rows are stored most scanned first, and a search ranks only a packaged catalog's first 1,000 matches. FTS5 indexes 2- and 3-letter prefixes, so "ch" doesn't merge thousands of words. A row keeps its nutrients as a JSON array in the order `catalog_meta` lists, its barcode as a number, and, for 96% of products, no id: the app derives `off:` and the barcode's 13 digits. Typo correction scales with the catalog: a word in fewer than one food in 4,800 is checked against common words a typo away. On a laptop a keystroke search takes about 10 ms; phones are slower.

At this size, `off.db` (555 MiB) is over GitHub's 100 MB file limit, so `assets/food/*.db` is stored with Git LFS (`.gitattributes`). GitHub's free LFS quota is 10 GiB of storage and 10 GiB of downloads a month. Every pushed catalog version stays in storage, and every clone, CI checkout or download of the file counts against downloads, including other people's clones of this public repository. EAS Build uploads the working directory's files, so it gets the catalog itself rather than its pointer, unless `requireCommit` is turned on in `eas.json`. iOS asks before downloading an app this large over cellular. Android installs copy the catalog out of the app, so it takes about twice its size there, and the download likely exceeds Google Play's base-module limit, which would mean Play Asset Delivery. Check Google's current limits.

USDA data are CC0. The OFF-derived catalog is ODbL 1.0; each database file also carries its license and attribution in `catalog_meta`. See [attribution and distribution notes](assets/food/ATTRIBUTION.md), including what the ODbL asks of each release.

Catalog filenames include the source and build-recipe version, so an app update installs a new reference catalog without replacing personal records. Each catalog is copied under a pending name, checked, then renamed into place, so a copy cut short by a full disk or a closed app is redone, not opened. Installed catalogs live in the cache folder, which iCloud and Android backups skip; the app copies them again if the system clears it. At launch, older versions and copies cut short are deleted, and current catalogs earlier builds left in `Documents/SQLite` are moved in rather than copied again. If one catalog can't install, the other still searches, and it is retried a minute later without holding search up. Signed downloadable updates belong to the next catalog-management milestone. The importer is a development/release tool, not an in-app download feature.

## Verification

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm test:tz
pnpm exec expo export --platform ios --platform android
```

Tests use real SQLite with the production Drizzle driver and cover migrations, health sync, source catalog integrity, search, barcode normalization, quantity arithmetic, unknown nutrients, history snapshots, dated targets and logging completeness. `pnpm test:tz` repeats them in Los Angeles, Auckland and London time. These checks do not replace physical-device camera, Health permission or UI testing.

The September 24, 2026 foundation passed all 21 automated tests, TypeScript and lint checks, iOS simulator compilation/installation, Android arm64 debug compilation, and production JavaScript/asset exports for both platforms. See [the milestone report](docs/foundation-validation.md) for catalog measurements and remaining QA.

The documentation and store assets under `docs/app-store/` were inherited from Body Track and are reference material, not ready-to-submit Vector Macros assets.

See [MVP validation and release gates](docs/mvp-validation.md) for the latest verified scope.

See [the MacroFactor feature review](docs/macrofactor-feature-review.md) for the researched comparison and remaining gaps.

See [fast logging flows and device timing targets](docs/fast-logging.md) for interaction budgets and the speed validation protocol.
