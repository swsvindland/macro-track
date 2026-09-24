# Macro Track product and implementation plan

Working proposal, September 24, 2026. Internal name: Macro Track. Public name remains open. Confirmed launch scope: US food coverage, iPhone and Android, with iPhone potentially releasing about two weeks earlier. This document proposes the work; it does not change the application.

**Product direction.** Build a private macro tracker with adaptive nutrition coaching. The everyday loop is: log food quickly, record weight, see the trend, and review a clear weekly recommendation. Food search, logging, history, calculations, and check-ins run on the phone. Photo assistance also runs locally on supported devices. No account is required.

MacroFactor is the functional reference. Its current offering includes adaptive targets, food and barcode search, recipes, photo and label logging, weight trends, and coached/manual program options. We should implement our own experience and coaching method around the same user needs. Its published description is a feature reference, not a specification of its proprietary algorithm. [MacroFactor feature overview](https://macrofactor.com/macrofactor/)

**What “fully local” means.** A bundled starter catalog makes the core app usable on first launch without a connection. Search queries, barcodes, food diaries, weight history, check-ins, and meal photos are processed locally. Internet access is used for app releases and optional public food/model downloads. Downloads contain shared reference data; they do not require uploading personal records. An unavailable update never stops logging. Optional OS health integration and user-chosen backup destinations follow the user's system settings; we should explain those boundaries accurately.

The product promise should be: **fast food logging and weekly macro adjustments, with your data on your phone.** Privacy is a benefit, but convenience and useful coaching must carry daily use.

**Launch features.** This is the proposed first public release, including both manual targets and adaptive weekly check-ins.

| Area | Initial scope | Important behavior |
| --- | --- | --- |
| Today | Calories, protein, carbs, fat; consumed/remaining views; meals; quick actions | Opening the app should make logging the next meal obvious. |
| Food search | Offline generic and branded foods, recent/favorite foods, useful serving units | Personal history ranks highly; generic ingredient searches should not be overwhelmed by brands. |
| Barcode logging | Scan and look up the installed US catalog | Unknown barcode opens a custom-food flow, with label scanning when available. |
| Manual logging | Quick-add calories/macros, custom foods, portions, backdating and edits | Users can estimate a meal or a full day without inventing individual foods. |
| Repeat meals | Multi-add, copy a meal/day, saved meals, recent portion sizes | Repeated meals should take only a few interactions. |
| Recipes | Ingredients, servings, total cooked yield, log by grams or portion | Editing a recipe affects future logging; past entries retain their original nutrition. |
| Targets | Lose, maintain, gain; adjustable pace; manual or coached targets | Allow calorie/protein preferences and macro customization within the chosen mode. |
| Coaching | Weekly review, estimated expenditure, progress, proposed target changes | Explain the evidence, allow accept/keep/edit, and hold when data is insufficient. |
| Weight | Quick weigh-in, raw and smoothed charts, goal progress | Reuse the fork's weight foundation and health integrations. |
| Useful nutrients | Fiber, sugar, saturated fat, sodium when supplied by the source | Unknown values remain unknown, rather than displaying zero. |
| Data ownership | Full portable backup/restore, readable CSV export, erase data | Backup includes custom foods, recipes, targets and check-in history. |
| Offline maintenance | Food-pack version, update/download controls, storage usage | Keep working indefinitely with the installed pack. |

Onboarding should ask only what is needed for the selected goal and initial estimate: units, current weight, relevant profile inputs, activity estimate, goal, preferred pace, and check-in day. Allow manual targets without forcing adaptive coaching. Ask for health/camera permissions when their features are used.

**The app structure should be smaller than Body Track's.** Use four main destinations: Today, Progress, Plan, and Library. Settings can sit behind a toolbar button. Today combines the daily overview and food diary. Progress contains weight, intake averages and expenditure. Plan contains goals and weekly check-ins. Library contains saved foods, meals and recipes. Height becomes a profile input. Body measurements and physique photos can remain the responsibility of Vector Body instead of occupying nutrition-app tabs.

**What comes after the core release.** Add different daily targets within a weekly budget, more flexible collaborative coaching, maintenance breaks, meal planning, broader micronutrient views, widgets/shortcuts, and additional country packs. Local meal-photo assistance is a conditional launch feature: prototype it at the start, ship it if it passes the device and usefulness gates below, otherwise deliver it in a subsequent release. Label scanning is the earlier priority. Text/voice logging and URL recipe imports can follow; voice must use a verified offline path, and URL imports necessarily require fetching the recipe. Restaurant coverage needs a separate data strategy and should not be promised from Open Food Facts alone.

**The food catalog needs two complementary sources.** Use Open Food Facts for packaged products and barcodes, and USDA FoodData Central for ingredients and common prepared foods. Evaluate Foundation Foods, SR Legacy, and FNDDS first; assess USDA Branded as a later US coverage supplement. USDA offers downloadable datasets, so runtime API access is unnecessary. [USDA downloads](https://fdc.nal.usda.gov/download-datasets/)

Open Food Facts publishes bulk exports that can feed a build process. We should transform those exports into a compact mobile catalog before distribution. Do not have phones ingest the full raw export. [Open Food Facts export project](https://github.com/openfoodfacts/openfoodfacts-exports)

Use separate versioned catalog files for OFF and USDA, plus a writable personal database. The app can combine ranked results from the sources while retaining provenance. Store the fields needed to find and log food: stable source ID, names and aliases, brand, barcode, market/language, nutrient basis, nutrients, known portions, quality flags, and source/update version. Omit product images and unrelated metadata from the initial packs.

The build pipeline should:

1. Fetch pinned source snapshots and record their provenance and checksums.
2. Select US-relevant products while auditing the coverage lost to missing market tags.
3. Normalize barcodes and units, retain source identities, and detect duplicate candidates.
4. Preserve per-100-g versus per-100-ml bases; convert only when a valid portion mass or density is known. Keep raw/cooked distinctions.
5. Distinguish missing nutrients from zero. Check suspicious values and serving conversions. Preserve declared energy; a simple 4/4/9 recomputation is not a universal replacement for label calories.
6. Build indexed SQLite files with exact barcode lookup and full-text search. Rank using match quality, food type, region, and local usage history.
7. Produce a quality report, license/attribution files, and a versioned manifest.

Expo SQLite supports importing a prebuilt database and full-text search. The actual catalog size and latency must be measured using representative source data and phones. We should not commit to a worldwide offline catalog or a fixed download size before that measurement. [Expo SQLite](https://docs.expo.dev/versions/latest/sdk/sqlite/)

**Catalog licensing belongs in the build pipeline.** OFF identifies its database as ODbL and product images under a separate license. Plan attribution and redistribution of the OFF-derived catalog under the appropriate terms. Publish access to the distributed derived data and the reproducible build recipe. USDA identifies its data as public domain/CC0. Keep source datasets and private user records distinct; separate files alone are not a blanket exemption for any combined derivative data or index we distribute. This concerns the catalog's distribution design and does not authorize uploading private diaries or user corrections. [OFF licensing](https://openfoodfacts.github.io/openfoodfacts-server/api/tutorials/license-be-on-the-legal-side/), [ODbL sections 4.4–4.6](https://opendatacommons.org/licenses/odbl/1-0/), [USDA licensing](https://fdc.nal.usda.gov/api-guide/)

**Food updates can start simple.** Bundle a useful generic catalog and a curated US branded pack with the initial app. Refresh bundled packs in ordinary app releases first. Add an optional “Update food database” download from static hosting if pack size or update frequency makes it worthwhile. A monthly publication cadence is a starting proposal, not a dependency for using the app. No personal-data backend is needed, though static hosting and release maintenance still have costs.

For downloadable packs, use a signed manifest, content hashes, schema compatibility checks, a disk-space check, and staged installation. Validate the replacement before switching the active catalog, retain a working version until the new one opens successfully, and recover cleanly from interrupted downloads. Begin with whole-pack replacement. Add delta updates only if measured bandwidth justifies the extra complexity.

App/OTA updates, public food packs, and AI model assets need distinct versions. Expo updates must match the installed native runtime; adding a native camera/OCR/AI module requires a new app build. Replacing a bundled asset also does not automatically replace an existing copied SQLite database: the app needs explicit catalog version/install logic. The fork currently has EAS build configuration but no `expo-updates` dependency or OTA runtime configuration. [Expo update compatibility](https://docs.expo.dev/eas-update/runtime-versions/)

**Personal history must survive catalog changes.** Each logged food stores a nutrition snapshot, selected quantity, conversion basis, source ID/version, and whether the user edited the result. Historical totals must not change when OFF corrects a product, a pack is removed, or a recipe is edited. Goal and target revisions likewise have effective dates; accepting a new target must not rewrite previous weeks.

The personal database will need records for diary entries, day completeness, custom foods/portions, saved meals, recipe versions, goals, target revisions, expenditure estimates, check-ins, installed packs, and optional AI drafts. Reuse the existing weight/preferences/health mapping foundation. Queries should be scoped to the active day or chart interval; the current global store's synchronous whole-history reads should not be extended to a large food catalog.

**Adaptive coaching is a separate, testable product component.** It does not require an LLM. Build a deterministic local calculation engine, version its methods, and generate explanations from the actual inputs and rules. Its estimate is calibrated to reported intake and weight change, with uncertainty from logging and physiology; avoid presenting it as a direct measurement of someone's metabolism.

The proposed flow is:

1. Start with an explicitly provisional estimate or the user's manual baseline.
2. Smooth weight and evaluate intake over aligned calendar intervals. Reuse the existing weight trend for display, but validate whether it is appropriate for the coaching estimator.
3. Track daily logging states: in progress, complete, partial, unlogged, or explicitly fasting. A blank day is not zero calories. Planned future food is not consumed intake.
4. Evaluate whether the available observation window supports a useful update. Target an initial calibration experience around two to three weeks, but choose actual thresholds through validation. Do not combine a weight change spanning unknown intake days with the average of only complete days as though it represented the entire interval. Start conservatively by holding when gaps make inference unreliable.
5. Estimate expenditure from the relationship between reported intake and sustained trend change, damp sudden adjustments, and expose a learning/ready/holding status.
6. Propose a goal-aligned calorie target and a coherent macro allocation. Apply only after the user accepts. Keep manual mode available throughout.

MacroFactor's public check-in documentation includes incomplete-log review and a choice to decline recommended changes. Those are useful interaction principles to adopt. [MacroFactor check-ins](https://help.macrofactorapp.com/en/articles/247-introduction-to-check-ins-and-coaching-modules)

A check-in should show the period reviewed, logging coverage, weight trend, desired versus observed pace, and a short explanation of the proposed change. Ask about incomplete days without treating a high-calorie day as bad data. Missing records should not cause an automatic calorie cut. Large weight fluctuations, breaks from logging, and a sudden goal change need deliberate handling. Avoid automatically adding wearable exercise calories on top of a target already inferred from total energy balance.

Choose and document the initial expenditure equation, smoothing, observation-window criteria, adjustment limits, and supported goal ranges before shipping coached recommendations. Test water-weight shifts, persistent logging bias, missing weekends, long gaps, duplicate weigh-ins, and timezone changes. A fixed energy-per-unit-weight shortcut should not be presented as a complete long-term physiological model; dynamic models explicitly account for changing energy needs. Include an accessible offline Sources & methods explanation, building on the existing app's approach. [NIDDK model research](https://www.niddk.nih.gov/research-funding/at-niddk/labs-branches/laboratory-biological-modeling/integrative-physiology-section/research/body-weight-planner)

**Local AI should make logging easier while leaving the final entry editable.** There are two different opportunities.

Nutrition-label scanning is the first: photograph a label, extract text locally, parse nutrient amounts and serving basis, and show a confirmation form. Google documents bundled on-device text-recognition models; bundling avoids making first use depend on a model download. Evaluate an iOS native text-recognition adapter and the Android bundled path with real US labels. OCR success does not guarantee the nutrition parser understood a multi-column label. [ML Kit text recognition](https://developers.google.com/ml-kit/vision/text-recognition/v2/android)

Meal-photo assistance is the second: photo → candidate foods → matches in the installed catalog → portion/ingredient confirmation → normal diary entries. A photo should produce a draft. Ask about preparation, sauce, cooking oil, or portions when these materially affect the entry; exact mass and hidden ingredients cannot be established reliably from a single image. Nutrient totals should come from confirmed database foods and quantities. Preserve an estimated-entry indicator where appropriate. Default to discarding the photo after confirmation unless the user elects to retain it.

Prototype the following behind one internal image-analysis interface:

| Candidate | Why evaluate it | What must be established |
| --- | --- | --- |
| React Native ExecuTorch with a compact vision-language model | One on-device approach for both platforms | Expo 57 build compatibility, model redistribution terms, minimum devices, install size, memory, speed, and food-recognition usefulness |
| Apple Foundation Models with image input | Native on-device image understanding on eligible Apple configurations | Exact released OS/device requirements, availability checks, and strictly on-device model selection |
| Android ML Kit GenAI | Potential native image-description support | Current beta status, device/model availability, and whether short descriptions are useful enough for food matching |

ExecuTorch documents local multimodal inputs and requires native development builds. Its current documentation includes compact VLM options, but model size alone does not establish memory use or accuracy. Apple's current documentation includes on-device image prompts. Android's image-description API remains beta and requires runtime availability checks. These are feasible research paths, not proof of meal-logging quality. [ExecuTorch multimodal support](https://docs.swmansion.com/react-native-executorch/docs/extensions/llm-chat-and-generation), [ExecuTorch installation](https://docs.swmansion.com/react-native-executorch/docs/fundamentals/getting-started), [Apple image prompting](https://developer.apple.com/documentation/foundationmodels/analyzing-images-with-multimodal-prompting), [Android image description](https://developers.google.com/ml-kit/genai/image-description/android)

Use optional downloadable model assets where appropriate, with clear size, progress, deletion, and availability controls. Once installed, inference must work offline. Unsupported phones retain the complete manual/barcode workflow. There is no silent cloud fallback. Do not raise the base app's minimum OS solely for an optional AI feature without evaluating the reach tradeoff; some native dependencies can impose a build-wide minimum even if the feature is disabled at runtime.

**What we can reuse from the fork.** The repository currently contains Expo 57, React Native 0.86, HeroUI Native, SQLite/Drizzle, charting, localization infrastructure, local photo storage, weight smoothing, and HealthKit/Health Connect adapters. These are strong foundations. Nutrition tracking, recipes, food catalogs, coaching, backup/restore, barcode scanning, OCR, and model execution are new work. Existing body-app translations do not translate the new nutrition features automatically.

Before implementation builds, separate the app identities: package/display name, Expo slug/project, iOS bundle ID, Android application ID, URL scheme, database naming, permission copy, health-export identifier namespace, and store assets. The fork still points at Vector Body's identifiers and EAS project. Audit generated native configuration as well. The new app should install alongside Vector Body. User-requested health sync can bring weight across; do not assume apps can directly read each other's private databases. Preserve source-aware deduplication so Vector Body, smart scales, and Macro Track do not create repeated weight entries or export loops.

**Build order and acceptance gates.** The dates depend on the early prototypes. The requested approximately two-week iPhone lead is a release sequence, not an estimate of total development time. Build and exercise Android throughout so that its later launch is mostly platform QA and release work.

| Stage | Deliverable | Gate to move forward |
| --- | --- | --- |
| 0. Separate and measure | Independent app identity; sample US catalog; local search; native OCR/AI prototypes | Both platform builds work; measured pack size, barcode coverage, search quality and AI feasibility report |
| 1. Daily tracker | New navigation, manual targets, diary, search, barcode scan, custom foods, basic progress | A full week can be logged offline, including edits, unknown foods and backdating |
| 2. Everyday convenience | Recipes, saved meals, copying, label scanning, backup/restore, pack updates | Repeated meals are fast; quantities are correct; interrupted updates and restore preserve history |
| 3. Adaptive coaching | Goal setup, estimator, logging completeness, check-ins and explanations | Simulation and retrospective checks pass; recommendations behave reasonably through gaps and weight noise |
| 4. Beta and iPhone release | Device QA, privacy/methods copy, food-source attribution, store presentation | Core flows work on supported phones in airplane mode; health sync and data durability verified |
| 5. Android release | Same core product, Android camera/storage/health QA | Android device matrix passes; aim for roughly two weeks after iPhone if ready |
| Conditional AI release | Meal-photo drafts on supported devices | Saves time compared with ordinary logging; acceptable device performance; no network dependency after setup |

The first implementation milestone should therefore be an independently installable Macro Track build with a real offline food-search screen, barcode lookup, a minimal diary, and the inherited weight chart. Run the data and AI feasibility experiments early enough to influence architecture. The public v1 still needs the weekly-coaching loop; this first milestone is an internal foundation.

**What to measure.** Set initial engineering goals of under 200 ms for typical indexed local searches on the agreed baseline devices and no noticeable UI blocking during search. These are proposed targets, not measured results. Build a representative basket of actual US groceries and meals to measure barcode hits, correct top search matches, serving correctness, duplicate results, and missing nutrients. Record catalog counts and size before and after filtering.

For photo assistance, evaluate at least 100 varied meal photos with known food/portion references across a current iPhone, an older supported iPhone, and a midrange Android. Measure food identification, catalog-match quality, time to confirm a usable entry, memory, heat, and cold/warm latency. A useful starting target is an editable draft within about 10 seconds on devices where we enable the feature. Compare the complete corrected workflow against manual search, not just the model's first response. Do not imply that model-generated confidence scores are calibrated probabilities.

Coaching validation needs more than unit tests: synthetic trajectories with known intake/expenditure changes, weight noise and missingness; opt-in retrospective examples where available; and review of the published method before release. Validate insufficient-data behavior as carefully as recommendation behavior. Native health and AI behavior require device tests; simulator success is insufficient.

Verify data durability with interrupted catalog updates, low storage, corrupt packs, pack rollback, recipe changes, app upgrades, full restore, and deleted source foods. Exercise locale-sensitive quantities, daylight-saving transitions, camera denial, text scaling, and first launch in airplane mode. Backup should use a consistent snapshot, validate before restore, and offer encryption for full personal-data archives. Replaceable catalogs/models should not inflate personal backups.

**Naming and commercial direction remain open.** Keep Macro Track as the internal project name. For the public name, test a descriptive family such as “Vector: Macro Tracker,” “Vector: Weight Tracker,” and “Vector: Water Tracker” before committing to an entirely new umbrella brand. These are working examples, not cleared names. “Vector Nutrition” is broader than the initial product, while “Macro Tracker” communicates the job immediately.

Weak traction alone does not show that Vector is the problem. First inspect search impressions, listing visits, conversion and retention, then change the relevant part of positioning. Apple's search documentation identifies app name, subtitle and keywords among its relevance factors. The current Body listing uses “VECTOR BODY” with “Weight, measurements & photos” as its subtitle; clearer title wording is a reasonable hypothesis to test, not a guaranteed growth fix. [Apple App Store search](https://developer.apple.com/app-store/search/)

Local operation removes per-meal server inference costs but still leaves catalog maintenance, hosting, model distribution, platform work and support. A paid download or one-time core unlock fits the ownership proposition and is worth evaluating; subscription versus lifetime pricing is undecided. Any later entitlement design must preserve ordinary offline use without repeated server validation.

The next product decisions after the feasibility milestone are minimum supported devices, the AI release gate, the public naming direction, and pricing. None needs to delay validating the food catalog and core logging workflow.
