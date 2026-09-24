# VECTOR BODY

Part of the VECTOR app series. Local-first weight, height, body measurements and progress photos for iOS and Android, built with Expo SDK 57, HeroUI Native and SQLite.

## Run

Use Node 24 (`nvm use`) and pnpm 11.26 (`corepack enable`).

```sh
pnpm install
pnpm start
```

Expo Go supports the recording screens and photo flow. Health sync needs a native build:

```sh
pnpm ios
pnpm android
```

These commands generate native projects as needed. iOS requires Xcode and CocoaPods; Android requires the Android SDK and a compatible JDK. The default development identifier is `com.bodytrack.app`; use your registered identifier and signing team before distributing the app.

## App icons

The editable mark is `assets/branding/ruler.svg`. Run `pnpm icons:generate` to rebuild the PNG assets and `assets/branding/preview.png`. The default icon is a black ruler on the app's cyan accent (`#22d3ee`); iOS also has dark and grayscale tinted sources. All iOS icons are opaque, square 1024px images; the OS applies the corner mask.

Android uses separate transparent foreground and monochrome layers over the cyan background. The complete ruler stays inside the central 66/108 safe-zone circle for launcher masks and motion. Android 13+ launchers can recolor the monochrome layer for themed icons. The splash screen includes light and dark variants, and web uses a matching favicon.

After changing assets or `app.json`, run `pnpm exec expo prebuild --no-install` to sync existing native projects, then rebuild the app. A Metro reload does not update installed launcher icons. Check the icons on iOS in default/dark/tinted appearances and on Android with circle/squircle masks and themed icons enabled.

## Features

- Dated weight and height history with add, edit, delete and backdating.
- Dashboard with daily-mean weight trend, BMI, estimated body fat, FFMI and shoulder-to-waist ratio (goal 1.62). Cards show metric-specific adult reference labels; ratio labels describe progress toward the physique goal. Trend uses an exponential average with a seven-day half-life and calendar-day spacing. Repeated weigh-ins on one day contribute one daily average. Missing days do not create synthetic entries.
- Body sessions with 16 optional circumference sites, including left/right limbs, plus a manually measured body-fat percentage.
- US Navy circumference estimates when the user selects a male or female equation. Male inputs: neck and abdomen at the navel; female inputs: neck, natural waist and hips. Height is required. Manual body fat takes precedence. Invalid or missing inputs display no estimate.
- Private front/side/back photo gallery, editable dates/poses, deletion and two-photo comparison for matching poses. Selected images are copied into the app's document directory; only relative filenames are stored so iOS container changes do not break photos.
- Metric, imperial and decimal-stone units. Canonical values stay in kg/cm; changing display units does not rewrite history.
- English, Spanish, French, German, Italian, Portuguese, Dutch, Swedish, Japanese, Korean and Simplified Chinese. Language controls the interface and number/date formatting; units are independent.

## Health sync behavior

Sync is enabled from Settings and runs when due, including background execution when the device allows it. Weight and height sync in both directions. Recorded body-fat percentages are exported to HealthKit and Health Connect; waist circumference is also exported to HealthKit. Other tape measurements, photos and calculated estimates stay in the app. New write permissions require opening health sync in Settings after upgrading.

- Exports use stable client identifiers and versions. Repeating sync does not duplicate app records; corrections update them, and deleting an app-origin record queues deletion from the health provider on the next successful sync.
- Imports use provider record IDs and transactional mappings. Imported records are managed by their original source and cannot be edited here; deleting an imported record hides it locally without deleting the original. A remembered mapping prevents it from reappearing.
- Imports are snapshots, not a mirror of remote deletions. Updates to available provider records are imported, but records removed from the provider are not automatically deleted from VECTOR BODY.
- Apple Health returns only readable samples. iOS intentionally does not reveal whether read permission was denied; successful write authorization does not prove read access. This limitation is also explained in Settings.
- Health Connect currently imports the most recent 29 days, within its default historical access window, and paginates all results. It requires all four requested permissions before proceeding. Older local records can still be exported.
- A failed sync preserves completed mappings and only updates the last-success timestamp once the whole pass finishes. Retrying continues without replaying completed exports.
- Health Connect's system permission rationale opens the app's translated health-privacy screen through a config plugin.

Supported body measurement types were checked against [Apple’s waist circumference documentation](https://developer.apple.com/documentation/healthkit/hkquantitytypeidentifier/waistcircumference), [Health Connect’s data types](https://developer.android.com/health-and-fitness/health-connect/data-types), and the installed native SDKs. Neither provider has matching types for the other tape sites we record. Both support lean body mass, and HealthKit also supports BMI, but those are derived values rather than additional recorded measurements. HealthKit stores body fat as a fraction (20% → 0.20); Health Connect uses percentage points (20% → 20).

Dashboard categories use [adult BMI screening bands](https://www.cdc.gov/bmi/adult-calculator/bmi-categories.html), ACE adult body-fat bands, and approximate FFMI reference ranges informed by [Schutz et al. (2002)](https://doi.org/10.1038/sj.ijo.0802037). Body-fat and FFMI references follow the selected male/female formula; no sex is assumed when the formula is disabled. These are general references, not individual targets. Shoulder-to-waist ratio uses both circumferences from the latest session containing both, and compares the displayed two-decimal value with the 1.62 physique goal.

The pinned `react-native-health-connect@4.1.3` dependency includes a pnpm patch replacing its removed legacy Expo Gradle script with the SDK 57 Expo module plugin. HealthKit 14.1 has an incorrect TypeScript intersection for common sample metadata; a documented, narrow adapter cast accommodates its valid native sync metadata.

## Verification

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm exec expo export --platform ios
pnpm exec expo export --platform android
```

Tests exercise real SQLite through the production Drizzle Expo driver with the native SQLite boundary substituted by Node SQLite. They cover existing-data migrations, calendar validation, unit conversion, smoothing, body composition, dictionary completeness and sync idempotency/retry/deletion behavior. Health provider APIs are fakes in those tests; they do not prove native permissions or entitlement behavior.

## Verified in this implementation

Type checking, lint and all eight tests pass. Metro production exports succeed for iOS and Android. The overview and body screen were inspected in an iPhone simulator with Expo Go. The full Android arm64 debug APK compiles successfully, including Health Connect and the native privacy-rationale handler. Native iOS compilation and real-device health permission/sync behavior remain unverified.

## Before release

See [the implementation plan](IMPLEMENTATION_PLAN.md). Complete native device QA for health permissions, updates/deletions, provider availability, photo selection and persistence, large text and translated layouts. Review translations with native speakers. BMI and circumference formulas are adult estimates; FFMI is unadjusted and derived from trend weight and the latest recorded body-fat inputs. Source dates are shown because height and circumference records can be older than weight.

This app has no cloud backup. Device backups follow the operating system's settings; removing the app may remove its local records and photos. Add your store privacy disclosures, registered signing identifiers and Health Connect access declarations before publishing. There is no subscription or payment implementation in this scope.
