# Foundation validation — September 24, 2026

The first implementation milestone delivers an independent Macro Track app with an offline diary, real food catalogs, barcode lookup/scanning, custom foods, manual targets and inherited weight progress. Weekly coaching and local photo AI remain later milestones in the [product plan](macro-track-plan.md).

## Full export measurement

The supplied Open Food Facts CSV gzip was downloaded and processed locally. It is tab-delimited and contains 4,532,767 records. The compressed download was 1,275,171,186 bytes (1.28 GB); it is kept outside the repository. The importer streams compressed rows rather than expanding the entire export on disk.

| Bundled catalog     | Included foods |  Indexed SQLite bytes |
| ------------------- | -------------: | --------------------: |
| USDA SR Legacy      |          7,793 |             4,292,608 |
| Open Food Facts, US |         82,937 |            46,596,096 |
| Total               |         90,730 | 50,888,704 (48.5 MiB) |

These are catalog sizes, not total installed app size. Expo keeps bundled assets and installs searchable database copies; older catalog versions are currently retained. Cleanup and backup exclusions need attention in the catalog-management milestone.

OFF filtering excluded 3,622,635 records outside the US market, 76,540 with unusable names/barcodes, 737,365 with missing or implausible nutrition, 13,288 with ambiguous mass/volume basis, and two malformed rows. These counts reflect sequential filters, not independent quality categories. Coverage is deliberately conservative and has not been measured against a representative grocery basket.

The CSV lacks some unit metadata. The importer requires an explicit gram or milliliter serving label to infer a basis, preserves missing optional nutrients, validates GTIN checksums, and rejects implausible per-100 values. This cannot establish that a product's label is accurate. Personal foods provide a fallback for missing or incorrect products.

The [manifest](../assets/food/manifest.json) records source hashes, transformation version, output hashes and counts. Refreshing the bundled catalogs uses the same builder with fresh source downloads; personal diary data lives in a separate database. Public OFF artifact distribution and attribution must be configured before release, as described in [the source notes](../assets/food/ATTRIBUTION.md).

## Checks completed

- All 21 automated tests passed, including scanning every bundled food through logging validation, catalog integrity and provenance, real SQLite diary operations, historical snapshots, dated targets, barcode identities, quantity arithmetic, and logging-status transitions.
- TypeScript and ESLint passed.
- Production Metro exports passed for iOS and Android with both database assets included.
- iOS native debug build compiled and installed on an iPhone 17 simulator running iOS 26.5. The development bundle loaded without a reported startup JavaScript error.
- Android native arm64 debug build passed.

## Remaining acceptance work

The simulator's UI inspection service repeatedly timed out, so visual inspection and end-to-end taps are not verified. Physical-device barcode scanning, permission denial, health integration, accessibility/text scaling, a fresh airplane-mode launch, and a week of diary use remain release gates. Android was compiled, not exercised on a device.

Next implementation work covers recipes/saved meals/copying, portable backup and restore, catalog lifecycle management, then goal setup and validated weekly coaching. Local OCR and meal-photo inference still need device feasibility measurements. The public app name and new EAS project are undecided; no store submission or remote release has been created.
