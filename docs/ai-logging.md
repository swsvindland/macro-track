# Photo and description logging

September 25, 2026. Take a photo of a meal, describe it, or both; the phone's own language model names the foods and amounts, the offline catalog supplies their nutrition, and you confirm a draft before anything is logged. Nothing is sent to a server.

## Using it

Home shows **Photo** next to Log food and Scan when this phone can run the model (**Describe** where only text is supported). It is also in the food logger's row of shortcuts, where the foods join the meal being built.

1. Take a photo (or choose one), add an optional description such as “large pepperoni from Domino's, ate 3 slices”, and tap **Find foods**. A description alone also works.
2. The draft lists each food with its catalog match, an estimated amount (marked **≈**) and calories. Tap a food to change the amount, pick another match, search the full list or remove it. Foods without a confident match say **No match yet** and are skipped unless you choose one.
3. **Log** saves the whole meal at once, with the usual Undo on Home.

Branded menu items and packaged foods are logged whole: a Domino's pizza is one entry counted in slices, a Big Mac is one entry. Unbranded dishes are split into components: a homemade burger becomes bun, patty, cheese, lettuce, tomato and sauce, plus the fries. Brands are rarely readable from logos alone, so naming the restaurant in the description is the reliable way to get the chain's own nutrition.

## Where it runs

| Platform | Engine                                                                   | Photos                                   | Descriptions |
| -------- | ------------------------------------------------------------------------ | ---------------------------------------- | ------------ |
| iPhone   | Apple Foundation Models (`SystemLanguageModel`), with Apple Intelligence | iOS 27 on eligible iPhones               | iOS 26+      |
| Android  | Gemini Nano through ML Kit GenAI Prompt API (`genai-prompt:1.0.0-beta4`) | Supported Pixel, Galaxy and other models | Same devices |

Only Apple's on-device model is used, never Private Cloud Compute. On Android, AICore installs Gemini Nano; the logger offers a one-time **Download Gemini Nano** when the model is downloadable. Gemini Nano runs only while Macro Track is in the foreground and has a per-app daily quota. Phones without either model do not show the button; if Apple Intelligence is merely turned off, the logger explains how to turn it on. Search, Scan and Quick add are unaffected everywhere.

Photos are downscaled to at most 1,280 px on iPhone and 1,024 px on Android before analysis, and the camera or picker copy is deleted from the app cache when the logger closes. Photos are not stored with diary entries.

## How a draft is made

1. **Name the foods.** One request with the photo and/or description returns `{brand, name, quantity, unit, grams}` per food. iOS decodes against the JSON schema; Android is given the shape in the prompt and the reply is parsed leniently: chatter around the JSON is ignored, and a reply cut off at the length limit keeps the foods it finished. The prompt carries typical weights so estimates are anchored.
2. **Clean up** (`readSeenFoods`). Repeated items (a generation loop) are dropped. A chain written into the name (“dominos pepperoni pizza”) moves to the brand; a chain named only in the description is applied to the dish. When a chain's pizza, burger or bowl is present, its separately listed toppings (40 g or less, or counted in slices, strips or spoonfuls) are removed; a real side such as a banana or beans and rice stays. A chain item the model split into parts (bun, muffin, patty, egg, cheese, sauce) is collapsed back into the dish named in the description, keeping “with egg” or “with cheese”, unless that dish is already listed (“blueberry muffin”, or “chicken nuggets” for McNuggets). Foods the description names on their own (“and scrambled eggs”, “with bbq sauce”) are never absorbed.
3. **Find candidates.** Catalog full-text searches run from specific to broad (brand + name, name, head noun, first word) with stems that match plurals and a few catalog synonyms (bun → roll, ketchup → catsup). Your own foods, recipes, favorites and recent foods are included and preferred.
4. **Rank.** Name coverage (the last word counts double), USDA's leading food name, “typical” markers such as _year round average_, and everyday defaults (long-grain rice, cheddar/American cheese) raise a candidate. Variations (canned, powder, meatless, turkey, low-fat…), unrelated words and brand mismatches lower it; unbranded foods prefer generic USDA entries.
5. **Settle near-ties.** When the top candidates are within one point, a second, text-only request asks the model to choose among them (raw or cooked, which lettuce). It cannot override a clearly better name match. Weak best matches are offered, not chosen.
6. **Amounts.** A named unit uses the food's own portion (“3 slices” × 113 g). A generic “piece” uses the food's natural unit (a breast, a large egg), checked against the model's weight so a lettuce “piece” is not a whole head, and several pieces must be small ones. A volume of a weighed food converts through the food's own volume portion (milk's “1 fl oz” of 30.5 g makes 250 ml 258 g); without one it uses the model's weight, else water's density. Otherwise the model's weight is used; any single food is capped at 2 kg. A weight or volume of a per-serving food (a custom food without a serving weight, a recipe without a cooked weight) becomes servings through the serving size in its label (“1 serving (30 g)”, “1 1/2 cups”, “2 tbsp (32g)”); without one it is logged as “≈ 1 serving”. Nutrients always come from `scaleNutrients` on the catalog food.

## Code

- `modules/local-ai` — local Expo module. `getStatus`, `download`, `prewarm` and `generate(instructions, prompt, schema, imageUri, maxTokens)`; Swift (FoundationModels, weak-linked) and Kotlin (ML Kit GenAI).
- `src/lib/local-ai.ts` — JS bridge; missing module reports “unavailable”. Retries a busy model twice.
- `src/lib/model-json.ts` — schema description for Gemini Nano and lenient JSON extraction.
- `src/lib/meal-ai.ts` — prompts, schema, clean-up, retrieval, pick step and amounts. Pure and injected with `generate`/`search`, so tests run it against the real catalogs.
- `src/lib/food-rank.ts` — stems and ranking, shared with manual food search.
- `src/components/nutrition/photo-logger.tsx` — capture, progress, review and adjust screens.
- `plugins/with-kotlin-plugin-version.js` — pins the Kotlin Gradle plugin to 2.2.21. ML Kit GenAI ships Kotlin 2.3 metadata, which React Native's default 2.1.20 compiler cannot read; `expo-build-properties`' `kotlinVersion` alone only reaches Expo's version catalog.

Prompts live in TypeScript so both platforms share them. Changing a prompt needs no native rebuild.

## Verification

- `pnpm test`: 19 tests for this feature (reply clean-up, chain handling, FTS safety, ranking against the real USDA/OFF catalogs, amounts, the pick step and the full analysis with a scripted model).
- iOS simulator (iPhone 18 Pro, iOS 27, Apple Intelligence available on the host Mac): photo → draft → swap match → log → Home totals and Undo; Domino's photo with description → one Domino's entry; description-only meal. The simulator has no camera, so photos came from the library.
- Android: the module and the full app compile (`assembleDebug`, arm64) with Kotlin 2.2.21. **Not run on a device**; Gemini Nano is unavailable on the emulator.
- Prompt evaluation used the same Apple on-device model on macOS 27 with 10 CC-licensed Wikimedia meal photos and 3 descriptions (not committed).

| Case                                                                             | Result                                                                               |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Unbranded burger and fries (2 photos)                                            | Split into bun, patty, cheese, lettuce, tomato, bacon/ketchup, fries; 830–1,060 kcal |
| Domino's box + “…from dominos, ate 3 slices”                                     | One entry: DOMINO'S 14″ Pepperoni, Hand-Tossed, 3 slices, 339 g, 925 kcal            |
| Domino's box without description                                                 | Pizza Hut pepperoni: logo not read; generic pizza offered as an alternative          |
| “big mac from mcdonalds” photo                                                   | One entry: McDONALD'S, BIG MAC, 219 g, 563 kcal                                      |
| Chipotle bowl + description                                                      | One entry: Chipotle Chicken Burrito Bowl                                             |
| Full English breakfast                                                           | 9 foods; eggs, toast, sausage, ham, mushrooms, beans, hash brown and butter found    |
| Sushi                                                                            | Wasabi and soy sauce matched; nigiri/sashimi left unmatched with salmon offered      |
| “2 scrambled eggs, 2 slices of whole wheat toast with butter and a black coffee” | All four matched, 439 kcal                                                           |
| “chicken breast with a cup of white rice and broccoli”                           | 1 breast 172 g, 1 cup long-grain rice, 1 cup broccoli; 544 kcal                      |

Analysis took 6–15 s per meal on an Apple-silicon Mac (two model calls); phone timings are not yet measured.

## Known limits

- The model varies between runs and misses or misreads small items (a Caesar salad's dressing and parmesan, an IKEA tray's tiramisu). Review the draft.
- Weights are estimates. Catalog portions help for counted foods; bowls, piles and salads depend on the model's guess.
- The catalog has no generic sushi or many composite dishes; such foods may match a dish that contains them (spaghetti and meatballs) or remain unmatched.
- Chains are recognized from a fixed US list; other chains work when the model fills the brand itself.
- Plan gates still apply before release: 100+ varied photos on a current iPhone, an older supported iPhone and a midrange Android; time-to-logged versus manual search; memory and heat.
- Phones without Apple Intelligence or Gemini Nano have no photo logging yet. A downloadable fallback (for example llama.rn with Qwen3.5-0.8B, about 740 MB, Apache-2.0) is the candidate if that coverage is needed.
