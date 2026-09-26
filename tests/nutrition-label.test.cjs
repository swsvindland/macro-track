const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

function load(file, dependencies = {}) {
  const output = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const localRequire = require("node:module").createRequire(path.resolve(file));
  new Function("require", "module", "exports", output)(
    (name) => (name in dependencies ? dependencies[name] : localRequire(name)),
    module,
    module.exports
  );
  return module.exports;
}
const label = load("src/lib/nutrition-label.ts");
const nutrition = load("src/lib/nutrition.ts");

/** Text lines laid out like OCR output: [text, x, y] with a common line height. */
const boxes = (rows, height = 0.03) =>
  rows.map(([text, x, y, h = height]) => ({ text, x, y, width: 0.3, height: h }));

test("the 2016 label layout, with calories and serving size split from their values", () => {
  const reading = label.readNutritionLabel(
    boxes([
      ["Nutrition Facts", 0.03, 0.01, 0.06],
      ["8 servings per container", 0.03, 0.08],
      ["Serving size", 0.02, 0.115],
      ["2/3 cup (55g)", 0.55, 0.118],
      ["Amount per serving", 0.03, 0.19],
      ["Calories", 0.03, 0.219, 0.042],
      ["230", 0.71, 0.206, 0.057],
      ["% Daily Value*", 0.62, 0.289],
      ["Total Fat 8g", 0.03, 0.327],
      ["10%", 0.85, 0.327],
      ["Saturated Fat 1g", 0.09, 0.366],
      ["Trans Fat 0g", 0.09, 0.407],
      ["Cholesterol 0mg", 0.03, 0.447],
      ["Sodium 160mg", 0.03, 0.485],
      ["Total Carbohydrate 37g", 0.03, 0.524],
      ["Dietary Fiber 4g", 0.09, 0.568],
      ["Total Sugars 12g", 0.09, 0.607],
      ["Includes 10g Added Sugars", 0.15, 0.646],
      ["Protein 3g", 0.03, 0.68],
      ["a serving of food contributes to a daily diet. 2,000 calories", 0.05, 0.937],
    ])
  );
  assert.deepEqual(reading, {
    calories: 230,
    fat: 8,
    carbs: 37,
    protein: 3,
    fiber: 4,
    sodium: 160,
    servingLabel: "2/3 cup",
    servingAmount: 55,
    servingUnit: "g",
    estimatedCalories: false,
    warnings: [],
  });
  assert.ok(label.labelFound(reading));
});

test("a two-column can label merges neighbors and states traps that are not amounts", () => {
  const reading = label.readNutritionLabel(
    boxes([
      ["Nutrition", 0.21, 0.417],
      ["Amount/serving", 0.4, 0.411],
      ["Total Fat 16g", 0.4, 0.459],
      ["25% Total Carb. 1g", 0.54, 0.451],
      ["Serv. Size 2 oz. (56g)", 0.21, 0.508],
      ["Sat. Fat 6g", 0.42, 0.502],
      ["Fiber Og", 0.6, 0.5],
      ["Servings: 6", 0.21, 0.551],
      ["Calories 180", 0.21, 0.593],
      ["Cholest. 40mg 13% Protein 7g", 0.4, 0.586],
      ["Fat Cal. 140", 0.22, 0.629],
      ["Sodium 580mg 24%", 0.4, 0.633],
      ["based on a 2,000 calorie diet.", 0.22, 0.697],
      ["SODIUM CONTENT HAS BEEN LOWERED FROM 790mg TO 580mg", 0.21, 0.731],
      ["Calories per gram: Fat 9 • Carbohydrate 4 • Protein 4", 0.21, 0.8],
    ])
  );
  assert.equal(reading.calories, 180);
  assert.equal(reading.fat, 16);
  assert.equal(reading.carbs, 1);
  assert.equal(reading.protein, 7);
  assert.equal(reading.fiber, 0, "OCR's O is a zero");
  assert.equal(reading.sodium, 580);
  assert.equal(reading.servingLabel, "2 oz.");
  assert.equal(reading.servingAmount, 56);
});

test("a skewed bag without calories estimates them and repairs the serving weight", () => {
  const reading = label.readNutritionLabel(
    boxes([
      ["Amount/Serving", 0.36, 0.33, 0.11],
      ["Total Fat 28g", 0.37, 0.42, 0.11],
      ["Sodium 400mg", 0.74, 0.3, 0.09],
      ["Total Carbohydrate 47g", 0.76, 0.32, 0.13],
      ["Dietary Fiber 4g", 0.78, 0.39, 0.1],
      ["Protein 5g", 0.74, 0.51, 0.07],
      // "(94g/3.3 oz)" read as "g4g/3.3 oz)": a 4 g serving can't hold 80 g of macros.
      ["erving Size 1 Package", -0.015, 0.628, 0.223],
      ["g4g/3.3 oz)", -0.017, 0.738, 0.167],
      ["carvings Per Contain-", -0.003, 0.755, 0.218],
    ])
  );
  assert.equal(reading.calories, 9 * 28 + 4 * 47 + 4 * 5);
  assert.equal(reading.estimatedCalories, true);
  assert.equal(reading.servingLabel, "1 Package");
  assert.equal(reading.servingAmount, 93.6, "3.3 oz");
  assert.equal(reading.servingUnit, "g");
  assert.ok(label.labelFound(reading));
  assert.equal(label.labelFound({ ...reading, fat: null, carbs: null }), false);
});

test("column layouts, implied units, bilingual labels and small amounts", () => {
  const drink = label.readNutritionLabel(
    boxes([
      ["Supplement Facts", 0.03, 0.01],
      ["Serving Size 8.0 fl.oz. (240 mL)", 0.03, 0.089],
      ["Calories", 0.03, 0.248],
      ["100", 0.57, 0.252],
      ["Total Carb", 0.03, 0.301],
      ["27g", 0.57, 0.302],
      ["9%*", 0.84, 0.298],
      ["Sodium", 0.03, 0.609],
      ["180mg", 0.5, 0.606],
      ["Taurine", 0.03, 0.662],
      ["1000mg", 0.47, 0.654],
    ])
  );
  assert.deepEqual(
    [drink.calories, drink.carbs, drink.sodium, drink.fat, drink.protein],
    [100, 27, 180, null, null]
  );
  assert.deepEqual([drink.servingAmount, drink.servingUnit], [240, "ml"]);
  // Unknown values stay unknown instead of becoming zero.
  assert.equal(drink.estimatedCalories, false);

  const cereal = label.readNutritionLabel(
    boxes([
      ["SERVING SIZE: 1 OZ.", 0.07, 0.06],
      ["(28.4 g, ABOUT 1 CUP)", 0.43, 0.085],
      ["CALORIES.", 0.07, 0.236],
      ["100", 0.56, 0.234],
      ["140*", 0.77, 0.232],
      ["PROTEIN, g", 0.07, 0.261],
      ["2", 0.6, 0.262],
      ["6", 0.82, 0.262],
      ["CARBOHYDRATE, g.", 0.07, 0.289],
      ["24", 0.58, 0.289],
      ["SODIUM, mg.", 0.07, 0.424],
      ["290", 0.56, 0.424],
    ])
  );
  assert.deepEqual(
    [cereal.calories, cereal.protein, cereal.carbs, cereal.sodium],
    [100, 2, 24, 290]
  );
  assert.equal(cereal.servingAmount, 28.4);

  const agave = label.readNutritionLabel(
    boxes([
      ["Serving Size/Tamaño de Porción (1.06 oz)/30 g", 0.53, 0.444, 0.01],
      ["Calories 90", 0.53, 0.47, 0.01],
      ["Total Fat / Grasa Total 09", 0.53, 0.507, 0.01],
      ["Sodium / Sodio 0.1g", 0.53, 0.52, 0.01],
      ["Total Carb. / Carb. Totales 23g", 0.53, 0.546, 0.01],
      ["Dietary Fiber <1g", 0.59, 0.555, 0.01],
      ["Protein / Proteína 0g", 0.53, 0.57, 0.01],
    ])
  );
  assert.deepEqual(
    [agave.calories, agave.fat, agave.sodium, agave.carbs, agave.fiber, agave.protein],
    [90, 0, 100, 23, 0.5, 0]
  );
  assert.equal(agave.servingAmount, 30);
  assert.equal(agave.servingLabel, "", "a measure without a number is not shown");
});

test("thousands commas next to a unit, and footer limits that are not amounts", () => {
  const soup = label.readNutritionLabel(
    boxes([
      ["Serving size 1 cup (245g)", 0.03, 0.1],
      ["Calories 90", 0.03, 0.2],
      ["Total Fat 2g 3%", 0.03, 0.3],
      ["Sodium 1,160mg 50%", 0.03, 0.4],
      ["Total Carbohydrate 14g 5%", 0.03, 0.5],
      ["Protein 3g", 0.03, 0.6],
    ])
  );
  assert.equal(soup.sodium, 1160);
  assert.equal(soup.calories, 90);

  const split = label.readNutritionLabel(
    boxes([
      ["Sodium", 0.03, 0.4],
      ["1,160mg", 0.6, 0.401],
      ["50%", 0.85, 0.4],
    ])
  );
  assert.equal(split.sodium, 1160);

  // A 1990s label whose sodium row was cut off still prints the daily limits underneath.
  const footer = label.readNutritionLabel(
    boxes([
      ["Calories 250", 0.03, 0.1],
      ["Total Fat 12g", 0.03, 0.2],
      ["Protein 5g", 0.03, 0.3],
      ["Calories: 2,000 2,500", 0.03, 0.7],
      ["Total Fat Less than 65g 80g", 0.03, 0.75],
      ["Sodium Less than 2,400mg 2,400mg", 0.03, 0.8],
      ["Sodium", 0.03, 0.85],
      ["Less than 2,400mg", 0.4, 0.85],
    ])
  );
  assert.deepEqual([footer.calories, footer.fat, footer.sodium], [250, 12, null]);

  const small = label.readNutritionLabel(
    boxes([
      ["Sodium less than 5mg", 0.03, 0.1],
      ["Protein 0,125g", 0.03, 0.2],
    ])
  );
  assert.equal(small.sodium, 2.5, "a real small amount is still read");
  assert.equal(small.protein, 0.125, "a leading zero means a decimal comma");
});

test("inconsistent values are flagged and a photo without a label is rejected", () => {
  const reading = label.readNutritionLabel(
    boxes([
      ["Calories 900", 0.03, 0.1],
      ["Total Fat 8g", 0.03, 0.2],
      ["Total Carbohydrate 37g", 0.03, 0.3],
      ["Protein 3g", 0.03, 0.4],
    ])
  );
  assert.equal(reading.warnings.length, 1);
  const none = label.readNutritionLabel(
    boxes([
      ["SANDWICH BREAD", 0.1, 0.2],
      ["Ingredients: Wheat Flour, Water, Sugar", 0.1, 0.5],
    ])
  );
  assert.equal(label.labelFound(none), false);
  assert.equal(label.labelFound(label.readNutritionLabel([])), false);
});

test("per-serving label values become a per-100 g food with the serving as a portion", () => {
  const input = {
    name: " Granola ",
    brand: "Store",
    barcode: null,
    basis: "serving",
    nutrients: { calories: 230, protein: 3, carbs: 37, fat: 8, fiber: 4, sodium: null },
    serving: { label: "2/3 cup", amount: 55, unit: "g" },
  };
  const food = nutrition.customFood(input, "custom:granola");
  assert.equal(food.name, "Granola");
  assert.equal(food.basis, "g");
  assert.deepEqual(food.portions, [{ label: "1 serving (2/3 cup)", amount: 55 }]);
  assert.ok(Math.abs(food.nutrients.calories - (230 * 100) / 55) < 1e-9);
  assert.equal(food.nutrients.sodium, null);
  // Logging one serving gives back the label's own numbers.
  const one = nutrition.scaleNutrients(food, 55);
  assert.ok(Math.abs(one.calories - 230) < 1e-9 && Math.abs(one.protein - 3) < 1e-9);

  const drink = nutrition.customFood(
    { ...input, serving: { label: "1 can", amount: 355, unit: "ml" } },
    "custom:drink"
  );
  assert.equal(drink.basis, "ml");
  const noWeight = nutrition.customFood(
    { ...input, serving: { label: "1 bar", amount: null, unit: "g" } },
    "custom:bar"
  );
  assert.deepEqual([noWeight.basis, noWeight.nutrients.calories], ["serving", 230]);
  assert.deepEqual(noWeight.portions, [{ label: "1 serving (1 bar)", amount: 1 }]);
  const plain = nutrition.customFood({ ...input, basis: "g", serving: undefined }, "custom:plain");
  assert.deepEqual([plain.basis, plain.portions], ["g", []]);
  assert.throws(
    () => nutrition.customFood({ ...input, serving: { label: "", amount: 0, unit: "g" } }),
    /serving weight/
  );
  assert.throws(() => nutrition.customFood({ ...input, name: " " }), /food name/);
});
