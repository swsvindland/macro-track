# Food catalog sources

## USDA — `usda.db`

USDA SR Legacy, April 2018, from [FoodData Central](https://fdc.nal.usda.gov/download-datasets/).
USDA describes its data as [public domain / CC0](https://fdc.nal.usda.gov/api-guide/).

## Open Food Facts — `off.db`

Contains information from [Open Food Facts](https://world.openfoodfacts.org), which is made available
here under the [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
Individual contents are available under the
[Database Contents License (DbCL) 1.0](https://opendatacommons.org/licenses/dbcl/1-0/).

`off.db` is a derivative database: a filtered, worldwide subset of the full
[Open Food Facts JSONL export](https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz),
downloaded October 2, 2026 and decompressed before the build (`sourceSha256` in `manifest.json`
is the decompressed JSONL's). It is distributed under the ODbL 1.0, and this directory is where it,
and the method that made it, are publicly offered:

- `off.db` — the derivative database exactly as the app ships it.
- [`scripts/build-food-catalog.py`](../../scripts/build-food-catalog.py) — the complete
  transformation recipe, which rebuilds `off.db` from the source export.
- `manifest.json` — source URL, source and recipe SHA-256 hashes, filtering counts and sizes.

Each database also carries its own `license`, `attribution` and `source` rows in `catalog_meta`, so
the notice stays with the file when it is copied out of the app.

No product images are included (Open Food Facts images are under a separate CC BY-SA license). This
is not a verified or comprehensive catalog; only records with a valid barcode, complete core
macros, and an explicit g/ml (or oz/fl oz) basis are included. Vector Macros is not affiliated
with or endorsed by Open Food Facts.

## What each public release must keep doing (ODbL 4.2, 4.3, 4.6)

1. **Notice in the app.** Library → _Your offline food catalog_ shows the ODbL notice above, links
   to Open Food Facts, the ODbL and the DbCL, and links here to download the database.
2. **Per-food source.** A packaged food's portion screen names Open Food Facts as its source.
3. **Public access to the derivative.** Keep this directory, with the `off.db` and recipe that match
   the shipped build, publicly reachable. At 555 MiB, `off.db` is stored with Git LFS; GitHub
   serves it from this directory like any other file. If the repository ever goes private, publish
   the same files elsewhere (for example a public GitHub release) and update the Library link.
4. **Keep notices intact.** Don't strip `catalog_meta` or this file from redistributed copies.

The personal diary is not part of either catalog. Foods logged from `off.db` into the person's own
diary or Apple Health / Health Connect stay private to them and are not public use of the database.

## Transformations

The builder uses only values printed on the label, not ones Open Food Facts estimates from the
ingredients; it retains source calories, rejects incomplete core macros and ambiguous portion bases,
converts sodium and micronutrients to their label units (mg or µg), drops micronutrient values above
twice the richest USDA food's (unit slips) or larger than their whole (saturated fat over total fat),
keeps an Open Food Facts zero only for nutrients a US label must list, rounds values to four
significant figures, and never equates a missing nutrient with zero. Nutrition values are estimates;
check product labels for the foods you consume.
