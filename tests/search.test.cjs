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
const rank = load("src/lib/food-rank.ts");

// The production catalog module over the bundled catalogs; only expo-sqlite is substituted.
const manifest = JSON.parse(readFileSync("assets/food/manifest.json", "utf8"));
const files = {
  [`${manifest.usda.version}.db`]: "assets/food/usda.db",
  [`${manifest.off.version}.db`]: "assets/food/off.db",
};
let reads = 0;
const catalog = load("src/lib/food-catalog.ts", {
  "expo-sqlite": {
    importDatabaseFromAssetAsync: async () => {},
    openDatabaseAsync: async (name) => {
      const database = new DatabaseSync(files[name], { readOnly: true });
      return {
        getAllAsync: async (sql, ...params) => {
          reads++;
          return database.prepare(sql).all(...params);
        },
        getFirstAsync: async (sql, ...params) => database.prepare(sql).get(...params),
        execAsync: async () => {},
        closeAsync: async () => database.close(),
      };
    },
  },
  "../../assets/food/manifest.json": manifest,
  "../../assets/food/usda.db": 1,
  "../../assets/food/off.db": 2,
  "./nutrition": nutrition,
  "./food-rank": rank,
});
const top = async (query, known) =>
  (await catalog.searchFoods(query, known)).slice(0, 3).map((food) => food.name);

test("search expressions keep the food words as stemmed prefixes", () => {
  for (const [query, expression] of [
    ["eggs", '"egg"*'],
    ["cherry", '"cherr"*'],
    ["blueberries", '"blueberr"*'],
    ["mcdonalds", '"mcdonald"*'],
    ["McDonald's", '"mcdonald"*'],
    ["Wendy's", '"wend"*'],
    ["cookies", '"cookie"*'],
    ["cup of coffee", '"coffee"*'],
    ["2 eggs", '"egg"*'],
    ["200 g chicken breast", '"chicken"* AND "breast"*'],
    ["200g chicken breast", '"chicken"* AND "breast"*'],
    ["1.5 cups rice", '"rice"*'],
    ["1/2 cup oats", '"oat"*'],
    ["8 fl oz milk", '"milk"*'],
    ["slice of pizza", '"pizza"*'],
    ["large egg", '"egg"*'],
    ["2 large eggs", '"egg"*'],
    ["2 cups", '"cup"*'],
    ["12", ""],
    // Numbers written into a name stay, and match only themselves.
    ["2% milk", '"2" AND "milk"*'],
    ["3.25% milk", '"3" AND "25" AND "milk"*'],
    ["93/7 ground beef", '"93" AND "7" AND "ground"* AND "beef"*'],
    ["7-up", '"7" AND "up"*'],
    ["7up", '"7up"*'],
    // Count and unit words stay when they name the food.
    ["cup", '"cup"*'],
    ["cup noodles", '"cup"* AND "noodle"*'],
    ["k cup", '"k"* AND "cup"*'],
    ["peanut butter cups", '"peanut"* AND "butter"* AND "cup"*'],
    ["mini wheats", '"mini"* AND "wheat"*'],
    ["or", '"or"*'],
    ["crème brûlée", '"creme"* AND "brulee"*'],
    // The model's looser wordings don't take over a typed word.
    ["fries", '"fries"*'],
    ["pop", '"pop"*'],
    ["ketchup", '("ketchup"* OR "catsup"*)'],
    ['" OR - NEAR ( *', '"near"*'],
    ["", ""],
  ])
    assert.equal(rank.searchExpression(query), expression, query);
});

test("typed searches match the person's own foods by word, not by substring", () => {
  const named = (name, brand = "") => ({ name, brand });
  assert.ok(rank.matchesQuery("eggs", named("Egg, whole, cooked, hard-boiled")));
  assert.ok(rank.matchesQuery("chicken breast", named("Chicken, broilers or fryers, breast")));
  assert.ok(rank.matchesQuery("chic", named("Chicken thigh")), "a half-typed word counts");
  assert.ok(rank.matchesQuery("or", named("Orange juice")), "a short word may be a prefix");
  assert.ok(rank.matchesQuery("cup of coffee", named("Coffee, brewed")));
  assert.ok(rank.matchesQuery("tyson", named("Chicken breast", "Tyson")));
  assert.ok(rank.matchesQuery("oat", named("Oat breakfast")));
  assert.ok(!rank.matchesQuery("oat", named("Goat cheese")));
  assert.ok(!rank.matchesQuery("rice", named("Licorice")));
  assert.ok(!rank.matchesQuery("chicken breast", named("Chicken thigh")));
  assert.ok(!rank.matchesQuery("", named("Anything")));
  // A number in the search is the variety asked for.
  assert.ok(rank.matchesQuery("2% milk", named("Milk, reduced fat, fluid, 2% milkfat")));
  assert.ok(!rank.matchesQuery("2% milk", named("Milk, whole, 3.25% milkfat")));
  assert.ok(!rank.matchesQuery("2% milk", named("Whole milk")));
  assert.ok(rank.matchesQuery("93/7 beef", named("Ground beef 93/7")));
  assert.ok(!rank.matchesQuery("93/7 beef", named("Ground beef 80/20")));
});

test("everyday searches put a plain staple in the top three", async () => {
  const basket = [
    ["egg", /^Egg, whole, /],
    ["eggs", /^Egg, whole, /],
    ["2 eggs", /^Egg, whole, /],
    ["rice", /^Rice, white, long-grain, .*cooked/],
    ["white rice", /^Rice, white, long-grain, .*cooked/],
    ["brown rice", /^Rice, brown, .*cooked/],
    ["chicken", /^Chicken, broilers or fryers, .*cooked, roasted/],
    ["chicken breast", /^Chicken, broilers or fryers, breast, .*cooked, roasted/],
    ["200g chicken breast", /^Chicken, broilers or fryers, breast, .*cooked/],
    ["apple", /^Apples, raw/],
    ["apples", /^Apples, raw/],
    ["banana", /^Bananas, raw/],
    ["blueberry", /^Blueberries, raw$/],
    ["strawberries", /^Strawberries, raw$/],
    ["cherry", /^Cherries, sweet, raw/],
    ["avocado", /^Avocados, raw/],
    ["broccoli", /^Broccoli, (raw|cooked)/],
    ["coffee", /^Beverages, coffee, brewed/],
    ["cup of coffee", /^Beverages, coffee, brewed/],
    ["potato", /^Potatoes, (baked|boiled)/],
    ["sweet potato", /^Sweet potato, cooked, (baked|boiled)/],
    ["salmon", /^Fish, salmon, .*cooked/],
    ["tuna", /^Fish, tuna, /],
    ["ground beef", /^Beef, ground, /],
    ["milk", /^Milk, whole, /],
    ["whole milk", /^Milk, whole, /],
    ["greek yogurt", /^Yogurt, Greek, plain/],
    ["cheese", /^Cheese, cheddar/],
    ["cream cheese", /^Cheese, cream$/],
    ["cottage cheese", /^Cheese, cottage, /],
    ["oatmeal", /^Cereals, oats, .*cooked/],
    ["pasta", /^Pasta, cooked/],
    ["peanut butter", /^Peanut butter, (smooth|chunk)/],
    ["almonds", /^Nuts, almonds/],
    ["black beans", /^Beans, black, mature seeds, cooked/],
    ["orange juice", /^Orange juice, raw/],
    ["slice of pizza", /^Pizza, cheese topping/],
    ["mcdonalds", /^McDONALD'S, /],
    ["big mac", /^McDONALD'S, BIG MAC$/],
    ["wendys", /^WENDY'S, /],
    // Fat levels and other numbers written into a name.
    ["2% milk", /^Milk, reduced fat, fluid, 2% milkfat/],
    ["1% milk", /^Milk, lowfat, fluid, 1% milkfat/],
    ["85% lean ground beef", /^Beef, ground, 85% lean/],
    ["93/7 ground beef", /^Beef, ground, 93% lean meat \/ ?7% fat/],
    ["80/20 ground beef", /^Beef, ground, 80% lean meat \/ ?20% fat/],
    ["0% greek yogurt", /\b0%/],
    ["2% cottage cheese", /^Cheese, cottage, lowfat, 2% milkfat/],
    ["12 grain bread", /^12 grain bread/i],
    ["7-up", /^7 up$/i],
    // Count and unit words that name the food.
    ["cup noodles", /cup noodle/i],
    ["glass noodles", /glass noodle/i],
    ["k cup", /k-cup/i],
    ["peanut butter cups", /peanut butter cup/i],
    ["mini wheats", /mini.wheats/i],
    ["strip steak", /strip steak/i],
    ["potato wedges", /potato wedges/i],
    ["fries", /fries/i],
    ["pop tarts", /pop.?tart/i],
    ["burger", /burger/i],
  ];
  const misses = [];
  for (const [query, expected] of basket) {
    const names = await top(query);
    if (!names.some((name) => expected.test(name))) misses.push(`${query}: ${names.join(" | ")}`);
  }
  assert.deepEqual(misses, []);
  // The first row for a plain food is the everyday one, not a dish that contains it.
  assert.match((await top("eggs"))[0], /^Egg, whole, cooked/);
  assert.match((await top("rice"))[0], /^Rice, white, long-grain, .*cooked/);
  assert.match((await top("mcdonalds big mac"))[0], /^McDONALD'S, BIG MAC$/);
  // The top row is the one typed: its fat level, the named product, not a looser wording.
  for (const [query, expected] of [
    ["2% milk", /^Milk, reduced fat, fluid, 2% milkfat/],
    ["milk 2%", /^Milk, reduced fat, fluid, 2% milkfat/],
    ["93% lean ground beef", /^Beef, ground, 93% lean/],
    ["90/10 ground beef", /^Beef, ground, 90% lean meat \/ ?10% fat/],
    ["cup noodles", /cup noodle/i],
    ["peanut butter cups", /peanut butter cups/i],
    ["fries", /fries/i],
    ["pop tarts", /pop.?tarts/i],
    ["burger", /burger/i],
    ["pop", /^Snacks, popcorn/],
  ])
    assert.match((await top(query))[0], expected, query);
  // A count before a food only ranks a name that has it: "2 eggs" are still plain eggs.
  assert.match((await top("2 eggs"))[0], /^Egg, whole, cooked/);
});

test("branded foods stay reachable, and a named brand is not marked down", async () => {
  const oreo = (await catalog.searchFoods("oreo"))[0];
  assert.equal(oreo.source, "off");
  assert.match(oreo.brand, /oreo/i);
  const cola = (await catalog.searchFoods("coca cola"))[0];
  assert.match(`${cola.name} ${cola.brand}`, /coca.cola/i);
  // A brand only resembling the search ("Pizzah") does not outrank plain pizza.
  assert.equal((await catalog.searchFoods("pizza"))[0].source, "usda");
  // Plain searches keep generic foods ahead of packaged ones.
  for (const query of ["chicken breast", "greek yogurt", "peanut butter"])
    assert.equal((await catalog.searchFoods(query))[0].source, "usda", query);
});

test("the person's own foods lead a search, more so the more often they are eaten", async () => {
  const pool = await catalog.searchFoods("eggs");
  const boiled = pool.find((food) => food.name === "Egg, whole, cooked, hard-boiled");
  const scrambled = pool.find((food) => food.name === "Egg, whole, cooked, scrambled");
  assert.ok(boiled && scrambled);
  assert.notEqual(pool[0].id, boiled.id);
  assert.equal((await catalog.searchFoods("eggs", new Set([boiled.id])))[0].id, boiled.id);
  const known = new Map([
    [boiled.id, 1],
    [scrambled.id, 20],
  ]);
  assert.deepEqual(
    (await catalog.searchFoods("eggs", known)).slice(0, 2).map((food) => food.id),
    [scrambled.id, boiled.id]
  );
  // A known food still has to match the search.
  const other = await catalog.searchFoods("banana", new Set([boiled.id]));
  assert.ok(!other.some((food) => food.id === boiled.id));
});

test("search waits for a second letter and falls back to the food's own name", async () => {
  reads = 0;
  assert.deepEqual(await catalog.searchFoods("c"), []);
  assert.deepEqual(await catalog.searchFoods("a"), []);
  assert.deepEqual(await catalog.searchFoods("   "), []);
  assert.equal(reads, 0, "a single letter never reaches the catalog");
  // A half-typed last word is searched once it has two letters; until then, the rest is.
  assert.match((await top("chicken b"))[0], /^Chicken, /);
  assert.match((await top("chicken br"))[0], /^Chicken, broilers or fryers, breast/);
  // Words the catalog doesn't know fall back to the last word, which names the food.
  assert.match((await top("zesty homestyle banana"))[0], /^Bananas, raw/);
  assert.deepEqual(await catalog.searchFoods("qqqzzz"), []);
});

test("a keystroke search with reranking stays within its budget", async () => {
  await catalog.searchFoods("warm");
  for (const query of ["ch", "co", "ba", "sa", "po", "chicken", "cheese", "2% milk", "2 eggs"]) {
    let best = Infinity;
    for (let run = 0; run < 3; run++) {
      const start = performance.now();
      await catalog.searchFoods(query);
      best = Math.min(best, performance.now() - start);
    }
    assert.ok(best < 60, `${query} took ${best.toFixed(1)} ms`);
  }
});
