# Nutrition label scanning

September 25, 2026. When a food isn't in the catalog, photograph its Nutrition Facts panel and the create-food form fills itself in. Text is read on the phone; nothing is uploaded.

## Using it

- **Unknown barcode:** Scan a barcode that isn't in the catalog, then tap **Scan its nutrition label**. The camera opens straight away and the barcode is kept with the new food.
- **New food:** In the food logger, tap **New food**, then **Scan nutrition label**.

Fill the frame with the panel, hold it flat and avoid glare, or choose a photo you already took. The form switches to **per serving** and fills calories, protein, carbs, fat, fiber, sodium, the rest of what a US label must list (saturated and trans fat, cholesterol, total and added sugars, vitamin D, calcium, iron and potassium, under **More nutrients from the label**), the serving size (“2/3 cup”) and its weight (55 g). A note says what to check: values that weren't found, calories estimated from fat, carbohydrate and protein when the calories line is missing, or calories that don't match the macros. Add the name and save.

With a serving weight, the food is stored per 100 g (or ml) and gets a **1 serving (2/3 cup) · 55 g** portion, so it can be logged by serving or by weight and still shows the label's own numbers for one serving. Without a weight it is stored per serving. The photo is deleted once it has been read.

## How it works

1. **Text recognition** — Apple Vision (`VNRecognizeTextRequest`, accurate, no language correction) on iOS and ML Kit's bundled Latin recognizer (`text-recognition:16.0.1`) on Android. Both run on every supported phone, need no Apple Intelligence, Gemini Nano or download, and take well under a second. A label photographed sideways is read again rotated. The native side returns text lines as normalized boxes (`recognizeText` in `modules/local-ai`).
2. **Parsing** (`src/lib/nutrition-label.ts`) — a nutrient's value is taken from its own line (“Total Fat 8g”) or from the nearest box on the same printed row (“Calories” … “230”). It handles two-column panels, the older column format with units in the heading (“PROTEIN, g”), bilingual labels, “<1g” (logged as 0.5 g), “Includes 10g Added Sugars” (the amount before the name), vitamin D in mcg but never a bare % Daily Value, and common OCR misreads (O for 0, a trailing g read as 9). It ignores lines that mention a nutrient without giving this food's amount: “Fat Cal.”, “2,000 calorie diet”, “Calories per gram”, “sodium lowered from …”. A serving weight lighter than its own fat, carbohydrate and protein is discarded in favor of the ounces on the label.
3. **The form** — `customFood` in `src/lib/nutrition.ts` converts per-serving values with a known weight into a per-100 g food with a serving portion.

The on-device language model is not used here. OCR reads the printed digits exactly and works on every phone; a small model could only guess at text the OCR already missed.

## Verification

- `pnpm test`: 6 tests for the parser and food conversion, using fixtures modeled on real OCR output (split calories, two-column cans, a skewed bag without calories, Supplement Facts, the 1991 format, a bilingual label and non-label photos).
- Real photos (Wikimedia Commons, not committed), read with Vision on macOS: 32 of 38 printed values right, 2 wrong, 4 missed; serving weight right on 7 of 8. The misses were a small, low-resolution bilingual label and a panel mostly out of frame; the wrong values were OCR misreading tiny print (23 g as 25 g) and a 1991 column the OCR skipped. Phone photos taken at label distance are sharper than these web images.
- iOS 27 simulator: unknown barcode → Scan its nutrition label → a sideways Spam can photo filled 180 kcal, 16 g fat, 1 g carbs, 7 g protein, 0 g fiber, 580 mg sodium, 2 oz (56 g) → saved with a 1-serving portion.
- Android: the module and full app compile. Not yet run on a device.

## Limits

- US Nutrition Facts panels are the target. Other layouts (EU per-100 g tables, Supplement Facts) are read when the wording matches, but not checked systematically.
- The product name isn't on the panel, so it is typed.
- Curved, glossy or crumpled packaging can still defeat OCR; the note lists anything missing, and every field stays editable.
