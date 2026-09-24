# Food catalog sources

USDA SR Legacy, April 2018, from [FoodData Central](https://fdc.nal.usda.gov/download-datasets/).
USDA describes its data as [public domain / CC0](https://fdc.nal.usda.gov/api-guide/).

The packaged-food catalog is a filtered US subset of the full [Open Food Facts CSV export](https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz), downloaded September 24, 2026.
The derived `off.db` database is distributed under the [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
Individual contents are available under the [Database Contents License](https://opendatacommons.org/licenses/dbcl/1-0/).
No product images are included. This is not a verified or comprehensive US catalog; only records
with a valid barcode, complete core macros, and an explicit g/ml serving basis are included.

`manifest.json` records exact source URLs, SHA-256 hashes, filtering counts, and output sizes.
`scripts/build-food-catalog.py` is the complete transformation recipe. The source-separated SQLite
artifacts in this directory are the actual databases distributed in the app. Provide public access
to the OFF-derived artifact and attribution when distributing a public release.

The builder retains source calories, rejects incomplete core macros and ambiguous portion bases,
converts sodium to milligrams, and never equates a missing nutrient with zero. Nutrition values
are estimates; check product labels for the foods you consume. Private user records are not part
of either reference catalog.
