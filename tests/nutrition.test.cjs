const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, readdirSync } = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createHash } = require("node:crypto");
const ts = require("typescript");
const { drizzle } = require(
  path.join(path.dirname(require.resolve("drizzle-orm/expo-sqlite")), "driver.cjs")
);

function load(file, dependencies = {}, compile = false) {
  let source = readFileSync(file, "utf8");
  if (compile) {
    const expoRequire = require("node:module").createRequire(require.resolve("babel-preset-expo"));
    source = expoRequire("@babel/core").transformSync(source, {
      filename: file,
      configFile: false,
      babelrc: false,
      parserOpts: { plugins: ["typescript", "jsx"] },
      plugins: [expoRequire("babel-plugin-react-compiler")],
    }).code;
  }
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
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
const metrics = load("src/lib/metrics.ts");
const schema = load("src/db/schema.ts");
const food = {
  id: "custom:test",
  name: "Test food",
  brand: "",
  barcode: "00036000291452",
  source: "custom",
  sourceVersion: "1",
  basis: "g",
  nutrients: { calories: 180, protein: 10, carbs: 20, fat: 6, fiber: null, sodium: 125 },
  portions: [{ label: "1 serving", amount: 30 }],
};

// Exercise the actual compiler output with persistent hook/cache slots. Native
// rendering is substituted; database reads/writes and compiler caching are real.
function screenHarness(diary) {
  const slots = [];
  let cursor = 0;
  const context = { revision: 0, refresh: () => context.revision++ };
  const react = {
    createContext: () => ({}),
    useContext: () => context,
    useEffect: () => {},
    useState(initial) {
      const slot = cursor++;
      if (!(slot in slots)) slots[slot] = typeof initial === "function" ? initial() : initial;
      return [
        slots[slot],
        (next) => {
          slots[slot] = typeof next === "function" ? next(slots[slot]) : next;
        },
      ];
    },
    useRef(initial) {
      const [ref] = react.useState(() => ({ current: initial }));
      return ref;
    },
    useMemo(read, deps) {
      const slot = cursor++;
      const previous = slots[slot];
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i])))
        slots[slot] = { deps, value: read() };
      return slots[slot].value;
    },
  };
  const jsx = (type, props) => ({ type, props });
  const dependencies = {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react/compiler-runtime": {
      c(size) {
        const [cache] = react.useState(() =>
          Array(size).fill(Symbol.for("react.memo_cache_sentinel"))
        );
        return cache;
      },
    },
    "react-native": { View: "View", AppState: {} },
    "expo-router": { router: {} },
    "@/components/system": {
      SystemButton: "Button",
      SystemPanel: { Body: "PanelBody" },
      SystemText: "Text",
    },
    "@/components/ui": {
      Editor: "Editor",
      Field: "Field",
      Choices: "Choices",
      DateInput: "DateInput",
      ErrorText: "Error",
      Screen: "Screen",
    },
    "@/lib/diary": diary,
    "@/lib/metrics": metrics,
    "@/lib/nutrition": nutrition,
    "./food-editor": { FoodEditor: "FoodEditor", FoodRow: "FoodRow" },
    "./meal-editor": { MealEditor: "MealEditor" },
    "./recipe-editor": { RecipeEditor: "RecipeEditor" },
    "expo-camera": { CameraView: "CameraView", useCameraPermissions: () => [] },
    "@/lib/food-catalog": {
      catalogManifest: JSON.parse(readFileSync("assets/food/manifest.json", "utf8")),
    },
  };
  const store = { number: (n) => String(n), date: (day) => day };
  dependencies["@/lib/store"] = { useStore: () => store };
  dependencies["@/lib/nutrition-store"] = load("src/lib/nutrition-store.tsx", dependencies, true);
  return {
    context,
    load: (file) => load(file, dependencies, true),
    render(Component, props) {
      cursor = 0;
      return Component(props);
    },
  };
}

function nodes(tree) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}
function diaryDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  for (const migration of readdirSync("drizzle")
    .filter((name) => name.endsWith(".sql"))
    .sort())
    sqlite.exec(readFileSync(`drizzle/${migration}`, "utf8"));
  const client = {
    prepareSync(sql) {
      return {
        executeSync(params) {
          const statement = sqlite.prepare(sql);
          if (!statement.columns().length) {
            const result = statement.run(...params);
            return { changes: result.changes, lastInsertRowId: result.lastInsertRowid };
          }
          const rows = statement.all(...params);
          return { getAllSync: () => rows, getFirstSync: () => rows[0] };
        },
        executeForRawResultSync(params) {
          const statement = sqlite.prepare(sql);
          statement.setReturnArrays(true);
          const rows = statement.all(...params);
          return { getAllSync: () => rows };
        },
      };
    },
  };
  const db = drizzle(client, { schema });
  const diary = load("src/lib/diary.ts", {
    "@/db": { db, ...schema },
    "./metrics": metrics,
    "./nutrition": nutrition,
  });
  return { sqlite, diary };
}

test("barcode identity preserves leading zeroes and validates check digits", () => {
  for (const code of ["036000291452", "0036000291452", "00036000291452"])
    assert.equal(nutrition.normalizeBarcode(code), "00036000291452");
  for (const code of ["036000291453", "abcd", "36000291452", "123", "00036000291452 OR 1=1"])
    assert.equal(nutrition.normalizeBarcode(code), null);
});

test("portion arithmetic handles mass, volume and servings without replacing unknown nutrients", () => {
  assert.deepEqual(nutrition.scaleNutrients(food, 50), {
    calories: 90,
    protein: 5,
    carbs: 10,
    fat: 3,
    fiber: null,
    sodium: 62.5,
  });
  assert.equal(nutrition.scaleNutrients({ ...food, basis: "ml" }, 250).calories, 450);
  assert.equal(nutrition.scaleNutrients({ ...food, basis: "serving" }, 2).calories, 360);
  for (const invalid of [0, -1, NaN, Infinity, 100001])
    assert.throws(() => nutrition.scaleNutrients(food, invalid));
  const total = nutrition.totalNutrients([food.nutrients, { ...food.nutrients, fiber: 5 }]);
  assert.equal(total.fiber, null);
  assert.equal(total.calories, 360);
  assert.equal(total.sodium, 250);
});

test("diary snapshots survive custom-food edits; updates move entries and reopen affected days", () => {
  const { diary, sqlite } = diaryDatabase();
  diary.saveCustomFood(food);
  diary.saveEntry({ day: "2024-01-01", meal: "Breakfast", food, amount: 50, portionLabel: "50 g" });
  diary.setDayStatus("2024-01-01", "complete");
  diary.saveCustomFood({
    ...food,
    name: "Corrected food",
    nutrients: { ...food.nutrients, calories: 220 },
  });
  const original = diary.entriesForDay("2024-01-01")[0];
  assert.equal(original.food.name, "Test food");
  assert.equal(original.nutrients.calories, 90);
  diary.saveEntry({
    ...original,
    day: "2024-01-02",
    meal: "Lunch",
    amount: 100,
    portionLabel: "100 g",
  });
  assert.equal(diary.entriesForDay("2024-01-01").length, 0);
  assert.equal(diary.entriesForDay("2024-01-02")[0].nutrients.calories, 180);
  assert.equal(diary.dayStatus("2024-01-01"), "in-progress");
  assert.equal(diary.dayStatus("2024-01-02"), "in-progress");
  assert.throws(() => diary.saveEntry({ ...original, day: "2999-01-01" }));
  assert.throws(() => diary.saveEntry({ ...original, id: 999 }));
  sqlite.close();
});

test("blank days, fasting and partial logging remain distinct", () => {
  const { diary, sqlite } = diaryDatabase();
  assert.throws(() => diary.setDayStatus("2024-02-01", "complete"));
  diary.setDayStatus("2024-02-01", "fasting");
  diary.saveEntry({ day: "2024-02-01", meal: "Dinner", food, amount: 100, portionLabel: "100 g" });
  assert.equal(diary.dayStatus("2024-02-01"), "in-progress");
  assert.throws(() => diary.setDayStatus("2024-02-01", "fasting"));
  diary.setDayStatus("2024-02-01", "partial");
  const entry = diary.entriesForDay("2024-02-01")[0];
  diary.saveEntry({ ...entry, amount: 200 });
  assert.equal(diary.dayStatus("2024-02-01"), "partial");
  diary.deleteEntry(entry);
  assert.equal(diary.dayStatus("2024-02-01"), "in-progress");
  assert.equal(diary.entriesForDay("2024-02-01").length, 0);
  sqlite.close();
});

test("compiled diary refreshes same-day meals, totals, targets and status after writes", () => {
  const { diary, sqlite } = diaryDatabase();
  const harness = screenHarness(diary);
  const { TodayScreen } = harness.load("src/components/nutrition/today-screen.tsx");
  const render = () => nodes(harness.render(TodayScreen));
  const mealRows = (tree) =>
    tree.filter((node) => node.props?.accessibilityLabel === "Edit Test food");
  assert.equal(mealRows(render()).length, 0);
  const day = metrics.localDay();
  diary.saveEntry({ day, meal: "Breakfast", food, amount: 50, portionLabel: "50 g" });
  harness.context.refresh();
  let tree = render();
  assert.equal(mealRows(tree).length, 1, "saved breakfast must appear without changing the date");
  assert.ok(tree.some((node) => node.type === "Text" && node.props.children?.[0] === "90"));
  diary.saveTargets(day, { calories: 2000, protein: 100, carbs: 250, fat: 60 });
  diary.setDayStatus(day, "complete");
  harness.context.refresh();
  tree = render();
  assert.ok(tree.some((node) => node.type === "Choices" && node.props.value === "complete"));
  assert.ok(
    tree.some((node) => node.props?.children === "1910 kcal remaining to your 2000 target")
  );
  const entry = diary.entriesForDay(day)[0];
  diary.saveEntry({ ...entry, amount: 100, portionLabel: "100 g" });
  harness.context.refresh();
  tree = render();
  assert.ok(tree.some((node) => node.type === "Text" && node.props.children?.[0] === "180"));
  diary.deleteEntry(entry);
  harness.context.refresh();
  assert.equal(mealRows(render()).length, 0);
  sqlite.close();
});

test("compiled library refreshes personal, saved and recent foods while mounted", () => {
  const { diary, sqlite } = diaryDatabase();
  const harness = screenHarness(diary);
  const { LibraryScreen } = harness.load("src/components/nutrition/library-screen.tsx");
  const rows = () => nodes(harness.render(LibraryScreen)).filter((node) => node.type === "FoodRow");
  assert.equal(rows().length, 0);
  diary.saveCustomFood(food);
  diary.toggleFavorite(food);
  diary.saveEntry({
    day: metrics.localDay(),
    meal: "Breakfast",
    food,
    amount: 50,
    portionLabel: "50 g",
  });
  harness.context.refresh();
  assert.equal(rows().length, 3);
  diary.toggleFavorite(food);
  harness.context.refresh();
  assert.equal(rows().length, 2);
  sqlite.close();
});

test("target revisions preserve earlier days and do not invent targets before setup", () => {
  const { diary, sqlite } = diaryDatabase();
  const original = { calories: 2200, protein: 150, carbs: 250, fat: 65 };
  diary.saveTargets("2024-01-01", original);
  diary.saveTargets("2024-01-08", { ...original, calories: 2300 });
  assert.equal(diary.targetsForDay("2023-12-31"), null);
  assert.deepEqual(diary.targetsForDay("2024-01-07"), original);
  assert.equal(diary.targetsForDay("2024-01-08").calories, 2300);
  assert.throws(() => diary.saveTargets("2024-01-09", { ...original, protein: NaN }));
  assert.equal(diary.findPersonalBarcode("036000291452"), null);
  diary.saveCustomFood(food);
  assert.equal(diary.findPersonalBarcode("036000291452").id, food.id);
  diary.toggleFavorite(food);
  assert.equal(diary.favoriteFoods().length, 1);
  diary.toggleFavorite(food);
  assert.equal(diary.favoriteFoods().length, 0);
  sqlite.close();
});

test("bundled catalogs have valid provenance, exact barcode lookup and working FTS", () => {
  const manifest = JSON.parse(readFileSync("assets/food/manifest.json", "utf8"));
  for (const source of ["usda", "off"]) {
    const filename = `assets/food/${source}.db`;
    assert.equal(
      createHash("sha256").update(readFileSync(filename)).digest("hex"),
      manifest[source].sha256
    );
    const database = new DatabaseSync(filename, { readOnly: true });
    assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.equal(
      database.prepare("SELECT count(*) AS n FROM foods").get().n,
      manifest[source].included
    );
    for (const row of database.prepare("SELECT data FROM foods").iterate()) {
      const food = JSON.parse(row.data);
      assert.doesNotThrow(() => nutrition.validateFood(food), food.id);
      assert.ok(food.nutrients.fiber === null || food.nutrients.fiber <= 100, food.id);
    }
    assert.equal(
      database.prepare("SELECT value FROM catalog_meta WHERE key='version'").get().value,
      manifest[source].version
    );
    for (const query of ["chicken breast", '" OR - NEAR ( *', "crème", "rice"]) {
      const expression = nutrition.searchExpression(query);
      if (expression)
        assert.doesNotThrow(() =>
          database
            .prepare("SELECT name FROM food_search WHERE food_search MATCH ? LIMIT 5")
            .all(expression)
        );
    }
    if (source === "usda")
      assert.ok(
        database
          .prepare("SELECT name FROM food_search WHERE food_search MATCH ? LIMIT 5")
          .all(nutrition.searchExpression("chicken breast")).length
      );
    else {
      const row = database
        .prepare("SELECT barcode FROM foods WHERE barcode IS NOT NULL LIMIT 1")
        .get();
      assert.equal(nutrition.normalizeBarcode(row.barcode), row.barcode);
      assert.ok(database.prepare("SELECT data FROM foods WHERE barcode = ?").get(row.barcode));
    }
    database.close();
  }
});

test("saved meals preserve snapshots and scale quantities without changing previous entries", () => {
  const { diary, sqlite } = diaryDatabase();
  diary.saveEntry({
    day: "2024-01-01",
    meal: "Breakfast",
    food,
    amount: 50,
    portionLabel: "Half serving",
  });
  diary.saveEntry({
    day: "2024-01-01",
    meal: "Breakfast",
    food: { ...food, id: "custom:second", name: "Second food" },
    amount: 100,
    portionLabel: "100 g",
  });
  const saved = diary.saveMeal("  Usual breakfast  ", "2024-01-01", "Breakfast");
  assert.equal(saved.name, "Usual breakfast");
  assert.equal(saved.items.length, 2);
  const original = diary.entriesForDay("2024-01-01");
  diary.saveEntry({
    ...original[0],
    amount: 200,
    food: { ...food, nutrients: { ...food.nutrients, calories: 999 } },
  });
  diary.setDayStatus("2024-01-02", "fasting");
  assert.equal(diary.logSavedMeal(saved.id, "2024-01-02", "Lunch", 0.5), 2);
  const logged = diary.entriesForDay("2024-01-02");
  assert.deepEqual(
    logged.map((entry) => entry.nutrients.calories),
    [45, 90]
  );
  assert.equal(logged[0].amount, 25);
  assert.equal(logged[0].nutrients.fiber, null);
  assert.equal(logged[0].food.nutrients.calories, 180);
  assert.equal(diary.dayStatus("2024-01-02"), "in-progress");
  diary.deleteSavedMeal(saved.id);
  assert.equal(diary.listSavedMeals().length, 0);
  assert.equal(diary.entriesForDay("2024-01-02").length, 2);
  assert.throws(() => diary.logSavedMeal(saved.id, "2024-01-03", "Dinner"));
  sqlite.close();
});

test("copying a meal appends independent entries and only reopens the destination day", () => {
  const { diary, sqlite } = diaryDatabase();
  diary.saveEntry({ day: "2024-02-01", meal: "Breakfast", food, amount: 50, portionLabel: "50 g" });
  diary.setDayStatus("2024-02-01", "complete");
  diary.saveEntry({ day: "2024-02-02", meal: "Lunch", food, amount: 100, portionLabel: "100 g" });
  diary.setDayStatus("2024-02-02", "partial");
  diary.copyMeal("2024-02-01", "Breakfast", "2024-02-02", "Dinner");
  const entries = diary.entriesForDay("2024-02-02");
  assert.equal(entries.length, 2);
  assert.equal(entries[1].meal, "Dinner");
  assert.equal(entries[1].nutrients.calories, 90);
  assert.equal(diary.dayStatus("2024-02-01"), "complete");
  assert.equal(diary.dayStatus("2024-02-02"), "partial");
  diary.deleteEntry(entries[1]);
  assert.equal(diary.entriesForDay("2024-02-01").length, 1);
  diary.copyMeal("2024-02-01", "Breakfast", "2024-02-01", "Breakfast");
  assert.equal(diary.entriesForDay("2024-02-01").length, 2);
  assert.equal(diary.dayStatus("2024-02-01"), "in-progress");
  sqlite.close();
});

test("meal validation and a failed batch leave the destination unchanged", () => {
  const { diary, sqlite } = diaryDatabase();
  assert.throws(() => diary.saveMeal("Empty", "2024-03-01", "Breakfast"));
  diary.saveEntry({ day: "2024-03-01", meal: "Breakfast", food, amount: 50, portionLabel: "50 g" });
  diary.saveEntry({
    day: "2024-03-01",
    meal: "Breakfast",
    food,
    amount: 100,
    portionLabel: "100 g",
  });
  assert.throws(() => diary.saveMeal(" ", "2024-03-01", "Breakfast"));
  const saved = diary.saveMeal("Usual", "2024-03-01", "Breakfast");
  for (const factor of [0, -1, NaN, Infinity, 101])
    assert.throws(() => diary.logSavedMeal(saved.id, "2024-03-02", "Lunch", factor));
  assert.throws(() => diary.copyMeal("2024-03-01", "Breakfast", "2999-01-01", "Lunch"));
  diary.setDayStatus("2024-03-02", "fasting");
  sqlite.exec(`CREATE TRIGGER fail_second_food BEFORE INSERT ON food_entries
    WHEN NEW.day = '2024-03-02' AND NEW.amount = 100
    BEGIN SELECT RAISE(ABORT, 'Simulated storage failure'); END;`);
  assert.throws(() => diary.logSavedMeal(saved.id, "2024-03-02", "Lunch"));
  assert.equal(diary.entriesForDay("2024-03-02").length, 0);
  assert.equal(diary.dayStatus("2024-03-02"), "fasting");
  sqlite.close();
});

test("compiled saved-meal form logs the chosen quantity once and closes after success", () => {
  const { diary, sqlite } = diaryDatabase();
  diary.saveEntry({
    day: "2024-01-01",
    meal: "Breakfast",
    food,
    amount: 100,
    portionLabel: "100 g",
  });
  const saved = diary.saveMeal("My breakfast", "2024-01-01", "Breakfast");
  const harness = screenHarness(diary);
  const { MealEditor } = harness.load("src/components/nutrition/meal-editor.tsx");
  let closed = 0;
  let selectedDay;
  const props = {
    saved,
    initialDay: "2024-01-02",
    initialMeal: "Lunch",
    close: () => closed++,
    onLogged: (day) => (selectedDay = day),
  };
  let tree = nodes(harness.render(MealEditor, props));
  tree
    .find((node) => node.type === "Field" && node.props.label === "Meal quantity")
    .props.onChange("0.5");
  tree = nodes(harness.render(MealEditor, props));
  const submit = tree.find(
    (node) => node.type === "Button" && node.props.children === "Add to lunch"
  ).props.onPress;
  submit();
  submit();
  assert.equal(closed, 1);
  assert.equal(selectedDay, "2024-01-02");
  assert.equal(harness.context.revision, 1);
  const logged = diary.entriesForDay("2024-01-02");
  assert.equal(logged.length, 1);
  assert.equal(logged[0].amount, 50);
  assert.equal(logged[0].nutrients.calories, 90);
  sqlite.close();
});

test("recipe yield computes per-serving nutrients and preserves unknown values", () => {
  const recipe = {
    id: "test",
    revision: 1,
    name: "Batch",
    servings: 4,
    ingredients: [
      { food, amount: 200 },
      { food: { ...food, basis: "ml" }, amount: 100 },
    ],
  };
  const portion = nutrition.recipeFood(recipe);
  assert.equal(portion.basis, "serving");
  assert.equal(portion.nutrients.calories, 135);
  assert.equal(portion.nutrients.protein, 7.5);
  assert.equal(portion.nutrients.fiber, null);
  assert.equal(nutrition.scaleNutrients(portion, 0.5).calories, 67.5);
  for (const servings of [0, -1, NaN, Infinity, 1001])
    assert.throws(() => nutrition.recipeFood({ ...recipe, servings }));
  assert.throws(() => nutrition.recipeFood({ ...recipe, ingredients: [] }));
  assert.throws(() => nutrition.recipeFood({ ...recipe, ingredients: [{ food, amount: 0 }] }));
});

test("recipe edits refresh future portions and favorites without rewriting diary history", () => {
  const { diary, sqlite } = diaryDatabase();
  const recipe = diary.saveRecipe({
    name: "Original batch",
    servings: 2,
    ingredients: [{ food, amount: 200 }],
  });
  const original = nutrition.recipeFood(recipe);
  diary.toggleFavorite(original);
  diary.saveEntry({
    day: "2024-01-01",
    meal: "Dinner",
    food: original,
    amount: 1.5,
    portionLabel: "1.5 servings",
  });
  const revised = diary.saveRecipe({ ...recipe, name: "Revised batch", servings: 4 });
  assert.equal(revised.revision, 2);
  assert.equal(diary.recipeFoods()[0].nutrients.calories, 90);
  assert.equal(diary.favoriteFoods()[0].nutrients.calories, 90);
  assert.equal(diary.recentFoods()[0].name, "Revised batch");
  assert.equal(diary.entriesForDay("2024-01-01")[0].nutrients.calories, 270);
  assert.equal(diary.entriesForDay("2024-01-01")[0].food.name, "Original batch");
  assert.throws(() => diary.saveRecipe({ ...revised, servings: 0 }));
  assert.equal(diary.listRecipes()[0].revision, 2);
  diary.deleteRecipe(recipe.id);
  assert.equal(diary.recipeFoods().length, 0);
  assert.equal(diary.favoriteFoods().length, 0);
  assert.equal(diary.recentFoods().length, 0);
  assert.equal(diary.entriesForDay("2024-01-01")[0].nutrients.calories, 270);
  assert.throws(() => diary.saveRecipe({ ...recipe }));
  sqlite.close();
});

test("compiled recipe form retains draft while picking ingredients and saves once", () => {
  const { diary, sqlite } = diaryDatabase();
  const harness = screenHarness(diary);
  const { RecipeEditor } = harness.load("src/components/nutrition/recipe-editor.tsx");
  let closed = 0;
  const props = { close: () => closed++ };
  let tree = nodes(harness.render(RecipeEditor, props));
  tree
    .find((node) => node.type === "Field" && node.props.label === "Recipe name")
    .props.onChange("Chili");
  tree
    .find((node) => node.type === "Button" && node.props.children === "Add ingredient")
    .props.onPress();
  const picker = harness.render(RecipeEditor, props);
  assert.equal(picker.type, "FoodEditor");
  picker.props.onPick(food, 200);
  picker.props.close();
  tree = nodes(harness.render(RecipeEditor, props));
  assert.equal(
    tree.find((node) => node.type === "Field" && node.props.label === "Recipe name").props.value,
    "Chili"
  );
  const save = tree.find((node) => node.type === "Button" && node.props.children === "Save recipe")
    .props.onPress;
  save();
  save();
  assert.equal(closed, 1);
  assert.equal(diary.listRecipes().length, 1);
  assert.equal(diary.recipeFoods()[0].nutrients.calories, 90);
  assert.equal(diary.entriesForDay(metrics.localDay()).length, 0);
  sqlite.close();
});

test("ingredient picker returns the chosen amount without adding diary food", () => {
  const { diary, sqlite } = diaryDatabase();
  const harness = screenHarness(diary);
  const { FoodEditor } = harness.load("src/components/nutrition/food-editor.tsx");
  let picked;
  let closed = 0;
  const tree = nodes(
    harness.render(FoodEditor, {
      initialFood: food,
      initialAmount: 75,
      close: () => closed++,
      onPick: (food, amount) => (picked = { food, amount }),
    })
  );
  tree
    .find((node) => node.type === "Button" && node.props.children === "Use ingredient")
    .props.onPress();
  assert.equal(picked.amount, 75);
  assert.equal(closed, 1);
  assert.equal(diary.entriesForDay(metrics.localDay()).length, 0);
  sqlite.close();
});

