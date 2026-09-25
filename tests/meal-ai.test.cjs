const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
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
const nutrition = load("src/lib/nutrition.ts");
const modelJson = load("src/lib/model-json.ts");
const ai = load("src/lib/meal-ai.ts", { "./nutrition": nutrition });

// The app's catalog search: generic foods first, with a deeper generic limit.
const catalogs = ["usda", "off"].map(
  (source) => new DatabaseSync(`assets/food/${source}.db`, { readOnly: true })
);
const search = async (expression) =>
  catalogs.flatMap((database, i) =>
    database
      .prepare(
        `SELECT foods.data FROM food_search JOIN foods ON foods.rowid = food_search.rowid
         WHERE food_search MATCH ? ORDER BY bm25(food_search, 3.0, 1.0) LIMIT ?`
      )
      .all(expression, i === 0 ? 100 : 30)
      .map((row) => JSON.parse(row.data))
  );
const seen = (name, extra = {}) => ({
  name,
  brand: "",
  quantity: 1,
  unit: "piece",
  grams: null,
  ...extra,
});
/** Answers the first (vision) request with `items`; later requests fail like an unavailable model. */
function scripted(items, picks) {
  const requests = [];
  return {
    requests,
    generate: async (request) => {
      requests.push(request);
      if (requests.length === 1) return { items };
      if (picks) return picks(request);
      throw new Error("model busy");
    },
  };
}
async function draft(items, options = {}) {
  const model = scripted(items, options.picks);
  const drafts = await ai.analyzeMeal(
    { description: options.description ?? "my meal", imageUri: options.imageUri },
    { generate: model.generate, search, known: options.known ?? [] }
  );
  return { drafts, requests: model.requests };
}

test("model replies are validated, cleaned and deduplicated", () => {
  assert.deepEqual(ai.readSeenFoods(null), []);
  assert.deepEqual(ai.readSeenFoods({ items: "no" }), []);
  const foods = ai.readSeenFoods({
    items: [
      { brand: "none", name: "  Pepperoni   pizza ", quantity: 3, unit: "1 slice", grams: 330 },
      { brand: "", name: "", quantity: 1, unit: "cup", grams: 5 },
      { brand: "", name: "Salmon nigiri", quantity: 99, unit: "", grams: -4 },
      { brand: "", name: "salmon nigiri", quantity: 2, unit: "piece", grams: 60 },
      null,
      "text",
    ],
  });
  assert.deepEqual(foods, [
    { name: "Pepperoni pizza", brand: "", quantity: 3, unit: "slice", grams: 330 },
    { name: "Salmon nigiri", brand: "", quantity: 1, unit: "serving", grams: null },
  ]);
  const many = ai.readSeenFoods({
    items: Array.from({ length: 20 }, (_, i) => ({ name: `Food ${i}`, quantity: 1, unit: "g" })),
  });
  assert.equal(many.length, 12);
});

test("a chain's pizza or burger keeps its toppings; drinks and sides stay separate", () => {
  const foods = ai.readSeenFoods({
    items: [
      { brand: "Domino's", name: "Pepperoni pizza", quantity: 3, unit: "slice", grams: 330 },
      { brand: "", name: "Ham", quantity: 1, unit: "piece", grams: 30 },
      { brand: "", name: "Sliced mushrooms", quantity: 1, unit: "piece", grams: 30 },
      { brand: "", name: "White rice", quantity: 1, unit: "cup", grams: 160 },
      { brand: "", name: "Cola", quantity: 1, unit: "cup", grams: 250 },
      { brand: "", name: "Garlic bread", quantity: 2, unit: "piece", grams: 60 },
    ],
  });
  assert.deepEqual(
    foods.map((food) => food.name),
    ["Pepperoni pizza", "Cola", "Garlic bread"]
  );
  // Without a brand, a burger is split into its components as seen.
  const burger = ai.readSeenFoods({
    items: ["Hamburger bun", "Beef patty", "Cheddar cheese", "Lettuce"].map((name) => ({
      brand: "",
      name,
      quantity: 1,
      unit: "piece",
      grams: 30,
    })),
  });
  assert.equal(burger.length, 4);
});

test("a chain written into the name or only in the description still keeps the dish whole", () => {
  // The reply Apple's model gave on the simulator for a Domino's box photo and
  // "large pepperoni from dominos, ate 3 slices".
  const reply = {
    items: [
      { brand: "", name: "dominos pepperoni pizza", quantity: 3, unit: "slice", grams: 330 },
      ...["ham slice", "beef patty", "cheese slice", "pepperoni slice", "sausage slice"]
        .concat(["onion slice", "green pepper slice"])
        .map((name) => ({ brand: "", name, quantity: 1, unit: "piece", grams: 20 })),
    ],
  };
  assert.deepEqual(ai.readSeenFoods(reply, "large pepperoni from dominos, ate 3 slices"), [
    { name: "pepperoni pizza", brand: "Domino's", quantity: 3, unit: "slice", grams: 330 },
  ]);
  const unnamed = {
    items: [
      { brand: "", name: "Pepperoni pizza", quantity: 2, unit: "slice", grams: 220 },
      { brand: "", name: "Ham", quantity: 1, unit: "piece", grams: 30 },
      { brand: "", name: "Garlic knots", quantity: 2, unit: "piece", grams: 60 },
    ],
  };
  assert.deepEqual(
    ai.readSeenFoods(unnamed, "Domino’s, 2 slices").map((food) => [food.brand, food.name]),
    [
      ["Domino's", "Pepperoni pizza"],
      ["", "Garlic knots"],
    ]
  );
  assert.equal(ai.readSeenFoods(unnamed).length, 3, "without a chain, every food stays");
  const other = ai.readSeenFoods({
    items: [
      { brand: "", name: "Starbucks grande latte", quantity: 1, unit: "cup", grams: 470 },
      { brand: "", name: "Chipotle mayo", quantity: 1, unit: "tbsp", grams: 15 },
      { brand: "mcdonalds", name: "Big Mac", quantity: 1, unit: "sandwich", grams: 215 },
    ],
  });
  assert.deepEqual(
    other.map((food) => [food.brand, food.name]),
    [
      ["Starbucks", "grande latte"],
      ["", "Chipotle mayo"],
      ["McDonald's", "Big Mac"],
    ]
  );
});

test("a chain item the model split into parts is logged whole", () => {
  const parts = ["Hamburger bun", "Beef patties", "Cheese slice", "Shredded lettuce", "Pickles"];
  const reply = {
    items: [
      ...parts.map((name) => ({
        brand: "McDonald's",
        name,
        quantity: 2,
        unit: "piece",
        grams: 40,
      })),
      { brand: "", name: "Cola", quantity: 1, unit: "cup", grams: 350 },
    ],
  };
  assert.deepEqual(
    ai.readSeenFoods(reply, "big mac from mcdonalds").map((food) => [food.brand, food.name]),
    [
      ["McDonald's", "big mac"],
      ["", "Cola"],
    ]
  );
  // Without a dish in the description the parts are all we know, so they stay.
  assert.equal(ai.readSeenFoods(reply).length, 6);
});

test("catalog queries are safe FTS expressions from specific to broad", () => {
  for (const name of ['" OR - NEAR ( *', "crème brûlée", "Domino's 14\" pizza", "x", "🍕"]) {
    for (const expression of ai.catalogQueries(seen(name, { brand: "Mc'Test" })))
      for (const database of catalogs)
        assert.doesNotThrow(
          () =>
            database.prepare("SELECT 1 FROM food_search WHERE food_search MATCH ?").all(expression),
          expression
        );
  }
  const queries = ai.catalogQueries(seen("Hamburger bun", { brand: "Wendy's" }));
  // Stems prefix-match every form: "wend"* finds "WENDY'S".
  assert.match(queries[0], /^"wend"\* AND /);
  assert.ok(queries.some((query) => query.includes('("bun"* OR "roll"*)')));
  // Count words are not searched as foods.
  assert.equal(ai.catalogQueries(seen("tomato slice"))[0], '"tomato"*');
  assert.equal(ai.stem("tomatoes"), "tomato");
  assert.equal(ai.stem("berries"), "berr");
  assert.equal(ai.stem("strawberry"), "strawberr");
  assert.equal(ai.stem("hummus"), "hummus");
});

test("restaurant and packaged foods are recognized as branded", () => {
  const usda = (name) => ({ name, brand: "", source: "usda" });
  assert.ok(ai.isBranded(usda("McDONALD'S, french fries")));
  assert.ok(ai.isBranded(usda("T.G.I. FRIDAY'S, french fries")));
  assert.ok(ai.isBranded(usda("DOMINO'S 14\" Pepperoni Pizza, Classic Hand-Tossed Crust")));
  assert.ok(ai.isBranded({ name: "Ketchup", brand: "", source: "off" }));
  assert.ok(!ai.isBranded(usda("Fast foods, potato, french fried in vegetable oil")));
  assert.ok(!ai.isBranded(usda("Tomatoes, red, ripe, raw, year round average")));
});

test("seen foods match the everyday catalog food, not a variation", async () => {
  const { drafts } = await draft([
    { brand: "", name: "lettuce", quantity: 1, unit: "leaf", grams: 10 },
    { brand: "", name: "tomato slice", quantity: 2, unit: "slice", grams: 30 },
    { brand: "", name: "hamburger bun", quantity: 1, unit: "piece", grams: 55 },
    { brand: "", name: "bacon", quantity: 2, unit: "strip", grams: 20 },
    { brand: "", name: "french fries", quantity: 1, unit: "serving", grams: 115 },
    { brand: "", name: "black coffee", quantity: 1, unit: "cup", grams: 240 },
    { brand: "", name: "egg", quantity: 2, unit: "piece", grams: 100 },
    { brand: "", name: "chicken", quantity: 1, unit: "piece", grams: 150 },
    { brand: "", name: "white rice", quantity: 1, unit: "cup", grams: 160 },
    { brand: "", name: "cheese", quantity: 1, unit: "slice", grams: 20 },
  ]);
  const picked = drafts.map((row) => row.item.food.name);
  assert.match(picked[0], /^Lettuce, .*raw/);
  assert.match(picked[1], /^Tomatoes, red, ripe/);
  assert.match(picked[2], /^Rolls, hamburger/);
  assert.match(picked[3], /bacon/i);
  assert.doesNotMatch(picked[3], /meatless|turkey|bits|sticks/i);
  assert.ok(!ai.isBranded(drafts[4].item.food), picked[4]);
  assert.match(picked[4], /french fr/i);
  assert.match(picked[5], /^Beverages, coffee, brewed/);
  assert.match(picked[6], /^Egg, whole/);
  assert.match(picked[7], /^Chicken/);
  assert.doesNotMatch(picked[7], /feet|giblets|liver|skin/i);
  assert.match(picked[8], /long-grain/);
  assert.match(picked[9], /cheddar|american/i);
  // Every draft offers alternatives to swap to.
  for (const row of drafts) assert.ok(row.options.length > 1, row.seen.name);
});

test("a weak best match is offered but not chosen", async () => {
  const { drafts } = await draft([
    { brand: "", name: "salmon sashimi", quantity: 4, unit: "piece", grams: 120 },
  ]);
  assert.equal(drafts[0].item, null, "the catalog has no sashimi, so nothing is logged unasked");
  assert.ok(drafts[0].options.some((food) => /salmon/i.test(food.name)));
});

test("a named chain's item is logged whole, with plain foods kept as alternatives", async () => {
  const { drafts } = await draft(
    [
      { brand: "Domino's", name: "Pepperoni pizza", quantity: 3, unit: "slice", grams: 300 },
      { brand: "", name: "Pepperoni", quantity: 12, unit: "slice", grams: 30 },
    ],
    { description: "large pepperoni from dominos, ate 3 slices" }
  );
  assert.equal(drafts.length, 1);
  const pizza = drafts[0];
  assert.match(pizza.item.food.name, /^DOMINO'S .*Pepperoni/);
  const slice = pizza.item.food.portions.find((portion) => portion.label === "1 slice").amount;
  assert.equal(pizza.item.amount, 3 * slice);
  assert.equal(pizza.item.portionLabel, `≈ 3 slices · ${3 * slice} g`);
  assert.equal(
    pizza.item.nutrients.calories,
    (pizza.item.food.nutrients.calories * 3 * slice) / 100
  );
  assert.ok(
    pizza.options.some((food) => !ai.isBranded(food) && /pizza/i.test(food.name)),
    "a misread brand is one tap from a plain pizza"
  );
});

test("amounts come from catalog portions, checked against the model's weight", () => {
  const food = (portions, basis = "g") => ({
    id: "usda:test",
    name: "Test",
    brand: "",
    barcode: null,
    basis,
    source: "usda",
    sourceVersion: "1",
    nutrients: { calories: 100, protein: 1, carbs: 1, fat: 1, fiber: null, sodium: null },
    portions,
  });
  const egg = food([
    { label: "1 cup", amount: 243 },
    { label: "1 large", amount: 46 },
  ]);
  assert.deepEqual(ai.resolveAmount(seen("egg", { quantity: 2, grams: 100 }), egg), {
    amount: 92,
    portionLabel: "≈ 2 large · 92 g",
  });
  // A lettuce "piece" is a leaf's weight, not the catalog's whole head.
  const lettuce = food([{ label: "1 head, large", amount: 755 }]);
  assert.equal(ai.resolveAmount(seen("lettuce", { grams: 20 }), lettuce).amount, 20);
  // The portion named after the food wins: a chicken breast is one "breast".
  const breast = food([
    { label: "1 unit (yield from 1 lb ready-to-cook chicken)", amount: 52 },
    { label: "0.5 breast, bone and skin removed", amount: 86 },
  ]);
  assert.equal(
    ai.resolveAmount(seen("chicken breast", { grams: 170 }), breast).portionLabel,
    "≈ 1 breast · 172 g"
  );
  // Named units match the portion's own noun, not a word inside it.
  const mushrooms = food([
    { label: "1 cup pieces", amount: 156 },
    { label: "1 mushroom", amount: 12 },
  ]);
  assert.equal(
    ai.resolveAmount(seen("mushroom", { quantity: 3, grams: 30 }), mushrooms).amount,
    36
  );
  const rolls = food([
    { label: "1 oz", amount: 28.35 },
    { label: "1 roll 1 serving", amount: 44 },
  ]);
  assert.equal(ai.resolveAmount(seen("bun", { grams: 55 }), rolls).portionLabel, "≈ 1 roll · 44 g");
  assert.equal(
    ai.resolveAmount(seen("steak", { quantity: 8, unit: "oz" }), food([])).amount,
    226.8
  );
  assert.equal(ai.resolveAmount(seen("milk", { unit: "cup" }), food([], "ml")).amount, 240);
  const serving = food([{ label: "1 bar", amount: 1 }], "serving");
  assert.deepEqual(ai.resolveAmount(seen("bar", { quantity: 2 }), serving), {
    amount: 2,
    portionLabel: "≈ 2 bars",
  });
  // Without portions or a weight, 100 g per unit is the last resort and stays within limits.
  assert.equal(ai.resolveAmount(seen("mystery", { quantity: 80 }), food([])).amount, 2000);
  // Ten nigiri are small pieces, even when the fish's only unit is a 396 g fillet and the
  // model's own weight is inflated.
  const salmon = food([
    { label: "3 oz", amount: 85 },
    { label: "0.5 fillet", amount: 198 },
  ]);
  assert.deepEqual(ai.resolveAmount(seen("salmon nigiri", { quantity: 10, grams: 1100 }), salmon), {
    amount: 750,
    portionLabel: "≈ 10 pieces · 750 g",
  });
  // A portion that is only a weight names no unit.
  const patties = food([{ label: "1 151.0g", amount: 151 }]);
  assert.equal(
    ai.resolveAmount(seen("beef patty", { quantity: 2, grams: 220 }), patties).amount,
    220
  );
});

test("the second pass settles near-ties only, and bad answers are ignored", async () => {
  const pools = [[{ name: "A" }, { name: "B" }, { name: "C" }], [{ name: "D" }], []];
  const foods = [seen("x"), seen("y"), seen("z")];
  assert.equal(ai.pickRequest(foods, pools, []), null);
  const request = ai.pickRequest(foods, pools, [0]);
  assert.match(request.prompt, /Food 1: x\n {2}1\. A\n {2}2\. B\n {2}3\. C/);
  assert.doesNotMatch(request.prompt, /Food 2/);
  assert.equal(request.schema.properties.picks.minItems, 1);
  assert.deepEqual(ai.readPicks({ picks: [{ food: 1, entry: 3 }] }, pools, [0]), [2, 0, -1]);
  for (const reply of [
    { picks: [{ food: 1, entry: 9 }] },
    { picks: [{ food: 2, entry: 1 }] },
    { picks: [{ food: 1, entry: 1.5 }] },
    { picks: "?" },
    null,
  ])
    assert.deepEqual(ai.readPicks(reply, pools, [0]), [0, 0, -1]);

  // A pick applied through the whole analysis moves that entry to the front.
  const { drafts, requests } = await draft(
    [{ brand: "", name: "lettuce", quantity: 1, unit: "leaf", grams: 10 }],
    { picks: () => ({ picks: [{ food: 1, entry: 2 }] }) }
  );
  assert.equal(requests.length, 2);
  assert.equal(requests[1].imageUri, undefined);
  const second = requests[1].prompt
    .split("\n")
    .find((line) => /^\s+2\. /.test(line))
    .trim()
    .slice(3);
  assert.equal(drafts[0].item.food.name, second);
  assert.equal(drafts[0].options[0].name, second);
});

test("analysis asks for a photo or description and prefers the person's own foods", async () => {
  await assert.rejects(
    ai.analyzeMeal({ description: "  " }, { generate: async () => ({}), search, known: [] }),
    /photo or describe/
  );
  const empty = await draft([]);
  assert.deepEqual(empty.drafts, []);
  assert.equal(empty.requests.length, 1);

  const oats = {
    id: "custom:oats",
    name: "My overnight oats",
    brand: "",
    barcode: null,
    basis: "serving",
    source: "custom",
    sourceVersion: "1",
    nutrients: { calories: 380, protein: 20, carbs: 50, fat: 10, fiber: 8, sodium: null },
    portions: [{ label: "1 jar", amount: 1 }],
  };
  const { drafts, requests } = await draft(
    [{ brand: "", name: "overnight oats", quantity: 1, unit: "jar", grams: 300 }],
    { description: "my overnight oats", imageUri: "file:///meal.jpg", known: [oats] }
  );
  assert.equal(drafts[0].item.food.id, "custom:oats");
  assert.equal(drafts[0].item.amount, 1);
  assert.equal(requests[0].imageUri, "file:///meal.jpg");
  assert.match(requests[0].prompt, /The person says: "my overnight oats"/);
  assert.equal(requests[0].schema, ai.MEAL_SCHEMA);
});

test("JSON helpers describe a schema for models without constrained decoding", () => {
  const sketch = modelJson.describeJson(ai.MEAL_SCHEMA);
  assert.match(
    sketch,
    /\{"items":\[\{"brand":"","name":"","quantity":0\.1,"unit":"","grams":1\}\]\}/
  );
  assert.match(sketch, /items\[\]\.grams: Estimated total edible weight in grams/);
  assert.deepEqual(modelJson.extractJson('Sure!\n```json\n{"items": []}\n```'), { items: [] });
  assert.throws(() => modelJson.extractJson("I can't help with that."), /did not return JSON/);
  assert.throws(() => modelJson.extractJson("{not json}"));
});
