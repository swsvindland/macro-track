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
const foodTime = load("src/lib/food-time.ts", { "./nutrition": nutrition });
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
function screenHarness(diary, storeOverrides = {}, extraDependencies = {}) {
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
    "./metrics": metrics,
    "@/lib/nutrition": nutrition,
    "@/lib/food-time": foodTime,
    "./food-editor": { FoodEditor: "FoodEditor", FoodRow: "FoodRow" },
    "./time-field": { TimeField: "TimeField" },
    "./quick-add": { QuickAdd: "QuickAdd" },
    "./copy-day": { CopyDay: "CopyDay" },
    "./meal-editor": { MealEditor: "MealEditor" },
    "./recipe-editor": { RecipeEditor: "RecipeEditor" },
    "expo-camera": { CameraView: "CameraView", useCameraPermissions: () => [] },
    "@/lib/food-catalog": {
      catalogManifest: JSON.parse(readFileSync("assets/food/manifest.json", "utf8")),
    },
  };
  Object.assign(dependencies, extraDependencies);
  const store = {
    diaryLayout: "meals",
    hideEmptyHours: true,
    number: (n) => String(n),
    date: (day) => day,
    ...storeOverrides,
  };
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
    "./food-time": foodTime,
  });
  const backup = load("src/lib/backup-data.ts", {
    "@/db": { db, ...schema },
    "./nutrition": nutrition,
    "./food-time": foodTime,
  });
  const fastLog = load("src/lib/fast-log.ts", {
    "@/db": { db, ...schema },
    "./diary": diary,
    "./nutrition": nutrition,
    "./metrics": metrics,
    "./food-time": foodTime,
  });
  return { sqlite, diary, backup, db, fastLog };
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

test("portable backup round-trips nutrition and weights while preserving excluded data", () => {
  const { diary, sqlite, backup } = diaryDatabase();
  diary.saveCustomFood(food);
  diary.saveEntry({ day: "2024-01-01", meal: "Breakfast", food, amount: 50, portionLabel: "50 g" });
  diary.toggleFavorite(food);
  diary.saveMeal("Breakfast", "2024-01-01", "Breakfast");
  diary.saveRecipe({ name: "Batch", servings: 4, ingredients: [{ food, amount: 100 }] });
  diary.saveTargets("2024-01-01", { calories: 2200, protein: 100, carbs: 250, fat: 75 });
  diary.setDayStatus("2024-01-01", "complete");
  sqlite.exec(
    "INSERT INTO weight_entries (weight_kg, measured_at, created_at, updated_at) VALUES (80, '2024-01-01T12:00:00.000Z', 1704110400, 1704110400)"
  );
  const original = backup.createBackup();
  diary.deleteEntry(diary.entriesForDay("2024-01-01")[0]);
  sqlite.exec(
    "INSERT INTO preferences VALUES ('theme', 'dark'); INSERT INTO preferences VALUES ('healthSyncEnabled', 'true'); INSERT INTO photos VALUES (1, 'private-photo.jpg', 'front', '2024-01-01');"
  );
  backup.restoreBackup(backup.parseBackup(JSON.stringify(original)));
  assert.deepEqual(backup.createBackup().data, original.data);
  assert.equal(
    sqlite.prepare("SELECT value FROM preferences WHERE key='theme'").get().value,
    "dark"
  );
  assert.equal(
    sqlite.prepare("SELECT value FROM preferences WHERE key='healthSyncEnabled'").get().value,
    "false"
  );
  assert.ok(
    sqlite.prepare("SELECT value FROM preferences WHERE key='weightSyncEpoch'").get().value
  );
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM photos").get().n, 1);
  sqlite.close();
});

test("invalid backup and failed restore preserve every existing record", () => {
  const { diary, sqlite, backup } = diaryDatabase();
  diary.saveEntry({ day: "2024-01-01", meal: "Breakfast", food, amount: 50, portionLabel: "50 g" });
  const original = backup.createBackup();
  for (const invalid of [
    { ...original, version: 99 },
    {
      ...original,
      data: { ...original.data, entries: [...original.data.entries, ...original.data.entries] },
    },
    {
      ...original,
      data: { ...original.data, entries: [{ ...original.data.entries[0], amount: -1 }] },
    },
    { ...original, data: { ...original.data, recipes: [{ id: "broken" }] } },
  ]) {
    assert.throws(() => backup.restoreBackup(invalid));
    assert.deepEqual(backup.createBackup().data, original.data);
  }
  sqlite.exec(
    "CREATE TRIGGER fail_restore BEFORE INSERT ON food_entries BEGIN SELECT RAISE(ABORT, 'No storage'); END;"
  );
  assert.throws(() => backup.restoreBackup(original));
  assert.deepEqual(backup.createBackup().data, original.data);
  sqlite.close();
});

test("backup encryption authenticates the password and rejects tampering", async () => {
  const crypto = load("src/lib/backup-crypto.ts");
  const random = async (length) => new Uint8Array(require("node:crypto").randomBytes(length));
  const password = "correct horse battery staple";
  const encrypted = await crypto.encryptBackupText('{"private":"food diary"}', password, random);
  assert.ok(!encrypted.includes("food diary"));
  assert.equal(await crypto.decryptBackupText(encrypted, password), '{"private":"food diary"}');
  await assert.rejects(
    () => crypto.decryptBackupText(encrypted, "wrong password"),
    /Wrong password/
  );
  const damaged = JSON.parse(encrypted);
  damaged.ciphertext = (damaged.ciphertext[0] === "0" ? "1" : "0") + damaged.ciphertext.slice(1);
  await assert.rejects(
    () => crypto.decryptBackupText(JSON.stringify(damaged), password),
    /damaged backup/
  );
  damaged.iterations = 1e9;
  await assert.rejects(
    () => crypto.decryptBackupText(JSON.stringify(damaged), password),
    /not a supported/
  );
});

test("restore requires a readable recovery file before any replacement", async () => {
  const { db, diary, sqlite, backup } = diaryDatabase();
  diary.saveEntry({ day: "2024-01-01", meal: "Breakfast", food, amount: 50, portionLabel: "50 g" });
  const previous = backup.createBackup();
  const incoming = structuredClone(previous);
  incoming.data.entries[0].amount = 100;
  incoming.data.entries[0].nutrients = nutrition.scaleNutrients(food, 100);
  const files = new Map();
  let sharedUri;
  let writeFails = false;
  let readFails = false;
  class Directory {
    constructor(parent, name) {
      this.uri = `${parent.uri}/${name}`;
    }
    create() {}
  }
  class File {
    constructor(parent, name) {
      this.uri = name ? `${parent.uri}/${name}` : parent;
    }
    get exists() {
      return files.has(this.uri);
    }
    write(text) {
      if (writeFails) throw new Error("disk full");
      files.set(this.uri, text);
    }
    async text() {
      return readFails ? "corrupted" : files.get(this.uri);
    }
    delete() {
      files.delete(this.uri);
    }
  }
  const service = load("src/lib/backup-files.ts", {
    "@/db": { db, ...schema },
    "./backup-data": backup,
    "expo-file-system": {
      File,
      Directory,
      Paths: { document: { uri: "file:///documents" }, cache: { uri: "file:///cache" } },
    },
    "expo-document-picker": {},
    "expo-sharing": {
      isAvailableAsync: async () => true,
      shareAsync: async (uri) => {
        sharedUri = uri;
      },
    },
    "expo-crypto": {},
    "./backup-crypto": {
      encryptBackupText: async (text) => text,
      decryptBackupText: async (text) => text,
    },
    "./health": { withHealthPaused: async (work) => work() },
    "./health-schedule": { configureHealthSchedule: async () => {} },
  });
  writeFails = true;
  await assert.rejects(() => service.restoreWithRecovery(incoming, "password"), /disk full/);
  assert.deepEqual(backup.createBackup().data, previous.data);
  writeFails = false;
  readFails = true;
  await assert.rejects(() => service.restoreWithRecovery(incoming, "password"));
  assert.deepEqual(backup.createBackup().data, previous.data);
  readFails = false;
  await service.restoreWithRecovery(incoming, "password");
  assert.deepEqual(backup.createBackup().data, incoming.data);
  const recoveryUri = service.recoveryBackupUri();
  assert.deepEqual(JSON.parse(files.get(recoveryUri)).data, previous.data);
  await service.exportBackup("password");
  assert.ok(
    files.has(sharedUri),
    "Shared encrypted file must remain available to the receiving app"
  );
  sqlite.close();
});

const program = load("src/lib/program.ts", { "./nutrition": nutrition, "./metrics": metrics });
const coaching = load("src/lib/coaching.ts", { "./nutrition": nutrition });
function coachingInput() {
  const day = "2024-02-01";
  const days = Array.from({ length: 21 }, (_, i) => ({
    day: nutrition.shiftDay(day, i - 21),
    status: "complete",
  }));
  return {
    day,
    goal: { mode: "lose", pace: 0.25, startedDay: "2024-01-01" },
    targets: { calories: 2200, protein: 150, carbs: 250, fat: 66.667 },
    days,
    entries: days.map((row) => ({ day: row.day, nutrients: { calories: 2400 } })),
    weights: days.map((row) => ({ day: row.day, kg: 80 })),
  };
}
test("coaching caps changes, aligns 21 days, excludes today and averages duplicate weigh-ins", () => {
  const input = coachingInput();
  const result = coaching.reviewWeek(input);
  assert.equal(result.status, "ready");
  assert.equal(result.expenditure, 2400);
  assert.equal(result.proposed.calories, 2180);
  assert.equal(result.desiredWeeklyKg, -0.2);
  input.weights.push(...input.weights, { day: input.day, kg: 150 });
  input.entries.push({ day: input.day, nutrients: { calories: 9999 } });
  assert.deepEqual(coaching.reviewWeek(input), result);
  input.entries = input.entries.map((row) => ({ ...row, nutrients: { calories: 3000 } }));
  assert.equal(coaching.reviewWeek(input).proposed.calories, 2300);
});
test("coaching holds on incomplete weekends, fasting, calibration, sparse weights and water jumps", () => {
  for (const mutate of [
    (input) => (input.days[6].status = "partial"),
    (input) => (input.days[6].status = "fasting"),
    (input) => input.entries.splice(6, 1),
    (input) => (input.goal.startedDay = "2024-01-20"),
    (input) => (input.weights = input.weights.filter((_, i) => i < 14)),
    (input) => (input.weights[20].kg = 85),
    (input) => input.weights.forEach((row, i) => (row.kg += i > 10 ? 3 : 0)),
    (input) => (input.targets.calories = 1000),
  ]) {
    const input = coachingInput();
    mutate(input);
    assert.equal(coaching.reviewWeek(input).proposed, null);
  }
});
test("check-in acceptance is atomic, weekly, preserved in backups, and keeps past targets", () => {
  const { sqlite, diary, db, backup } = diaryDatabase();
  const fakeMetrics = { ...metrics, localDay: () => "2024-02-01" };
  const store = load("src/lib/coaching-store.ts", {
    "@/db": { db, ...schema },
    "./metrics": fakeMetrics,
    "./nutrition": nutrition,
    "./food-time": foodTime,
    "./diary": diary,
    "./coaching": coaching,
    "./program": program,
  });
  const input = coachingInput();
  db.insert(schema.coachingGoals).values(input.goal).run();
  diary.saveTargets("2024-01-01", input.targets);
  for (const row of input.days) {
    diary.saveEntry({
      day: row.day,
      meal: "Breakfast",
      food: { ...food, basis: "serving", nutrients: { ...food.nutrients, calories: 2400 } },
      amount: 1,
      portionLabel: "1 serving",
    });
    diary.setDayStatus(row.day, "complete");
    db.insert(schema.weightEntries)
      .values({ weightKg: 80, measuredAt: row.day + "T12:00:00Z" })
      .run();
  }
  store.finishCheckIn("accepted");
  assert.equal(diary.targetsForDay("2024-02-01").calories, 2180);
  assert.equal(diary.targetsForDay("2024-01-31").calories, 2200);
  assert.throws(() => store.finishCheckIn("accepted"));
  assert.equal(store.nextCheckInDay(), "2024-02-08");
  const saved = backup.createBackup();
  backup.restoreBackup(saved);
  assert.equal(store.checkInHistory().length, 1);
  const legacy = structuredClone(saved);
  delete legacy.data.goals;
  delete legacy.data.checkIns;
  assert.deepEqual(backup.validateBackup(legacy).data.goals, []);
  sqlite.close();
});

test("cooked batch mass supports weighed and equal portions and survives backups", () => {
  const { diary, sqlite, backup } = diaryDatabase();
  const recipe = diary.saveRecipe({
    name: "Cooked rice bowl",
    servings: 4,
    yieldGrams: 800,
    ingredients: [{ food, amount: 1000 }],
  });
  const cooked = nutrition.recipeFood(recipe);
  assert.equal(cooked.basis, "g");
  assert.equal(cooked.portions[0].amount, 200);
  assert.equal(nutrition.scaleNutrients(cooked, 200).calories, 450);
  assert.equal(nutrition.scaleNutrients(cooked, 400).calories, 900);
  backup.restoreBackup(backup.createBackup());
  assert.equal(diary.listRecipes()[0].yieldGrams, 800);
  assert.throws(() => nutrition.recipeFood({ ...recipe, yieldGrams: 0 }));
  sqlite.close();
});
test("whole-day copy preserves meal snapshots, appends, reopens only destination and rolls back failures", () => {
  const { diary, sqlite } = diaryDatabase();
  for (const meal of ["Breakfast", "Dinner"])
    diary.saveEntry({ day: "2024-01-01", meal, food, amount: 100, portionLabel: "100 g" });
  diary.setDayStatus("2024-01-01", "complete");
  diary.saveEntry({ day: "2024-01-02", meal: "Snacks", food, amount: 50, portionLabel: "50 g" });
  diary.setDayStatus("2024-01-02", "complete");
  assert.equal(diary.copyDay("2024-01-01", "2024-01-02"), 2);
  assert.equal(diary.entriesForDay("2024-01-02").length, 3);
  assert.equal(diary.dayStatus("2024-01-01"), "complete");
  assert.equal(diary.dayStatus("2024-01-02"), "in-progress");
  assert.throws(() => diary.copyDay("2024-01-01", "2024-01-01"));
  sqlite.exec(
    "CREATE TRIGGER fail_day_copy BEFORE INSERT ON food_entries WHEN NEW.day = '2024-01-03' AND NEW.meal = 'Dinner' BEGIN SELECT RAISE(ABORT, 'disk failure'); END"
  );
  assert.throws(() => diary.copyDay("2024-01-01", "2024-01-03"));
  assert.equal(diary.entriesForDay("2024-01-03").length, 0);
  sqlite.close();
});
test("compiled quick add logs entered calories once and keeps unknown nutrients", () => {
  const { diary, sqlite } = diaryDatabase();
  const harness = screenHarness(diary);
  const { QuickAdd } = harness.load("src/components/nutrition/quick-add.tsx");
  let closed = 0;
  const render = () =>
    nodes(harness.render(QuickAdd, { day: "2024-01-01", close: () => closed++ }));
  render()
    .find((node) => node.props.label === "Calories (kcal)")
    .props.onChange("650");
  const button = render().find(
    (node) => node.type === "Button" && node.props.children === "Add to diary"
  );
  button.props.onPress();
  button.props.onPress();
  assert.equal(closed, 1);
  assert.equal(diary.entriesForDay("2024-01-01")[0].nutrients.calories, 650);
  assert.equal(diary.entriesForDay("2024-01-01")[0].nutrients.fiber, null);
  sqlite.close();
});

test("CSV preserves unknown nutrients, quotes names and neutralizes spreadsheet formulas", () => {
  const { diary, sqlite, db } = diaryDatabase();
  const ownership = load("src/lib/data-ownership.ts", { "@/db": { db, ...schema } });
  diary.saveEntry({
    day: "2024-01-01",
    meal: "Breakfast",
    food: { ...food, name: '=HYPERLINK("bad")' },
    amount: 100,
    portionLabel: "100 g",
  });
  const exported = ownership.exportDiaryCsv();
  assert.ok(exported.includes('"\'=HYPERLINK(""bad"")"'));
  assert.ok(exported.includes('"6","","125"'));
  assert.ok(exported.includes('"in-progress"'));
  assert.equal(ownership.csv([["a\nb", "c,d", -5]]), '\uFEFF"a\nb","c,d","-5"\r\n');
  sqlite.close();
});
test("erase clears all personal tables, disables sync and rolls back database failure", () => {
  const { diary, sqlite, db } = diaryDatabase();
  const ownership = load("src/lib/data-ownership.ts", { "@/db": { db, ...schema } });
  diary.saveCustomFood(food);
  diary.saveEntry({
    day: "2024-01-01",
    meal: "Breakfast",
    food,
    amount: 100,
    portionLabel: "100 g",
  });
  db.insert(schema.preferences).values({ key: "healthSyncEnabled", value: "true" }).run();
  sqlite.exec(
    "CREATE TRIGGER fail_erase BEFORE DELETE ON custom_foods BEGIN SELECT RAISE(ABORT, 'disk failure'); END"
  );
  assert.throws(() => ownership.erasePersonalRecords());
  assert.equal(diary.entriesForDay("2024-01-01").length, 1);
  sqlite.exec("DROP TRIGGER fail_erase");
  ownership.erasePersonalRecords();
  assert.equal(diary.entriesForDay("2024-01-01").length, 0);
  assert.equal(diary.personalFoods().length, 0);
  assert.equal(
    db
      .select()
      .from(schema.preferences)
      .all()
      .find((row) => row.key === "healthSyncEnabled").value,
    "false"
  );
  sqlite.close();
});

const profile = {
  age: 30,
  heightCm: 180,
  weightKg: 80,
  formula: "male",
  activity: "moderate",
  protein: 1.6,
  diet: "balanced",
  targetWeightKg: 75,
  initialExpenditure: 2600,
  checkInDay: 1,
};
test("automatic programs generate starting targets and preserve weight-based protein during calorie changes", () => {
  assert.equal(program.initialExpenditure(profile), 2759);
  const goal = { mode: "lose", pace: 0.5, startedDay: "2024-01-01" };
  const cut = program.startingTargets(goal, profile);
  assert.equal(cut.calories, 2160);
  assert.equal(cut.protein, 128);
  assert.equal(program.programMacros(2400, 80, profile).protein, 128);
  assert.equal(
    program.startingTargets(
      { ...goal, mode: "gain", pace: 0.25 },
      { ...profile, targetWeightKg: 85 }
    ).calories,
    2820
  );
  assert.throws(() => program.startingTargets(goal, { ...profile, targetWeightKg: 50 }));
  assert.throws(() =>
    program.startingTargets({ ...goal, mode: "maintain" }, { ...profile, targetWeightKg: 50 })
  );
});
test("maintenance uses normalized target weight and stops chasing a completed cut or bulk", () => {
  const maintain = { mode: "maintain", pace: 0, startedDay: "2024-01-01" };
  assert.equal(program.goalRate(maintain, 80.4, 80), 0);
  assert.ok(program.goalRate(maintain, 82, 80) < 0);
  assert.ok(program.goalRate(maintain, 78, 80) > 0);
  assert.equal(program.goalRate({ ...maintain, mode: "lose", pace: 0.5 }, 75, 75), 0);
  assert.equal(program.goalRate({ ...maintain, mode: "gain", pace: 0.25 }, 85, 85), 0);
});
test("adaptive programs use normalized weight and complete intervals without resetting on goal changes", () => {
  const input = coachingInput();
  input.weights.unshift({ day: nutrition.shiftDay(input.days[0].day, -1), kg: 80 });
  const config = {
    ...input,
    goal: { ...input.goal, startedDay: input.day },
    program: profile,
    priorExpenditure: 2600,
  };
  const result = program.reviewProgram(config);
  assert.equal(result.status, "ready");
  assert.equal(result.trendWeightKg, 80);
  assert.equal(result.expenditure, 2530);
  assert.equal(result.proposed.protein, 128);
  config.days[10].status = "partial";
  const gap = program.reviewProgram(config);
  assert.equal(gap.status, "ready");
  assert.equal(gap.observedDays, 20);
  config.entries[10].nutrients.calories = 9000;
  assert.deepEqual(program.reviewProgram(config), gap);
  config.days.slice(0, 15).forEach((row) => (row.status = "partial"));
  assert.equal(program.reviewProgram(config).proposed, null);
});
test("program setup writes generated targets atomically and preserves learned expenditure in backup", () => {
  const { sqlite, diary, db, backup } = diaryDatabase();
  const store = load("src/lib/coaching-store.ts", {
    "@/db": { db, ...schema },
    "./metrics": { ...metrics, localDay: () => "2024-02-01" },
    "./nutrition": nutrition,
    "./food-time": foodTime,
    "./diary": diary,
    "./coaching": coaching,
    "./program": program,
  });
  const target = store.createProgram("lose", 0.25, profile);
  assert.equal(diary.targetsForDay("2024-02-01").calories, target.calories);
  assert.equal(store.currentGoal().program.targetWeightKg, 75);
  const saved = backup.createBackup();
  backup.restoreBackup(saved);
  assert.equal(store.currentGoal().program.protein, 1.6);
  const expense = store.currentGoal().program.initialExpenditure;
  store.createProgram("maintain", 0.25, { ...profile, targetWeightKg: 80, activity: "high" });
  assert.equal(store.currentGoal().program.initialExpenditure, expense);
  assert.equal(diary.targetsForDay("2024-01-31"), null);
  sqlite.close();
});

test("food timeline groups by time, sorts minutes and preserves untimed historical meals", () => {
  const entries = [
    { id: 1, meal: "Breakfast", loggedTime: "08:45" },
    { id: 2, meal: "Snacks", loggedTime: "08:15" },
    { id: 3, meal: "Dinner", loggedTime: null },
    { id: 4, meal: "Lunch", loggedTime: "23:59" },
  ];
  const groups = foodTime.timelineGroups(entries, true, false);
  assert.deepEqual(
    groups.map((row) => row.key),
    ["08", "23", "untimed-Dinner"]
  );
  assert.deepEqual(
    groups[0].entries.map((row) => row.id),
    [2, 1]
  );
  assert.equal(foodTime.timelineGroups(entries, false, false).length, 25);
  for (const value of ["00:00", "08:45", "23:59"]) assert.ok(foodTime.validFoodTime(value));
  for (const value of ["24:00", "08:60", "8:00", "1 PM", ""])
    assert.equal(foodTime.validFoodTime(value), false);
});
test("moving and reusing timeline hours preserves snapshots and separates legacy entries", () => {
  const { diary, sqlite, backup } = diaryDatabase();
  for (const [meal, loggedTime] of [
    ["Breakfast", "08:15"],
    ["Snacks", "08:45"],
    ["Breakfast", "10:30"],
    ["Breakfast", null],
  ])
    diary.saveEntry({
      day: "2024-01-01",
      meal,
      loggedTime,
      food,
      amount: 100,
      portionLabel: "100 g",
    });
  const saved = diary.saveMeal("Morning", "2024-01-01", "Breakfast", "08");
  assert.equal(saved.items.length, 2);
  assert.equal(
    diary.saveMeal("Legacy breakfast", "2024-01-01", "Breakfast", "untimed").items.length,
    1
  );
  diary.logSavedMeal(saved.id, "2024-01-02", "Dinner", 1, "18:35");
  assert.deepEqual(
    diary.entriesForDay("2024-01-02").map((row) => row.loggedTime),
    ["18:35", "18:35"]
  );
  diary.copyDay("2024-01-01", "2024-01-03");
  assert.deepEqual(
    diary.entriesForDay("2024-01-03").map((row) => row.loggedTime),
    ["08:15", "08:45", "10:30", null]
  );
  const entry = diary.entriesForDay("2024-01-01")[0];
  diary.saveEntry({ ...entry, loggedTime: "12:15" });
  assert.equal(diary.entriesForDay("2024-01-01")[0].loggedTime, "12:15");
  assert.throws(() => diary.saveEntry({ ...entry, loggedTime: "25:00" }));
  backup.restoreBackup(backup.createBackup());
  assert.equal(diary.entriesForDay("2024-01-01")[0].loggedTime, "12:15");
  const legacy = backup.createBackup();
  legacy.data.entries.forEach((row) => delete row.loggedTime);
  backup.restoreBackup(legacy);
  assert.ok(diary.entriesForDay("2024-01-01").every((row) => row.loggedTime === null));
  sqlite.close();
});
test("compiled timeline moves an edited entry between hours without changing the day", () => {
  const { diary, sqlite } = diaryDatabase();
  const day = metrics.localDay();
  diary.saveEntry({
    day,
    meal: "Breakfast",
    loggedTime: "08:15",
    food,
    amount: 100,
    portionLabel: "100 g",
  });
  const harness = screenHarness(diary, { diaryLayout: "timeline", hideEmptyHours: true });
  const { TodayScreen } = harness.load("src/components/nutrition/today-screen.tsx");
  const render = () => nodes(harness.render(TodayScreen));
  assert.ok(render().some((node) => node.props.children === "Food timeline"));
  assert.ok(render().some((node) => node.props.children === "08:00"));
  const entry = diary.entriesForDay(day)[0];
  diary.saveEntry({ ...entry, loggedTime: "17:25" });
  harness.context.refresh();
  const tree = render();
  assert.ok(tree.some((node) => node.props.children === "17:00"));
  assert.equal(tree.filter((node) => node.props.accessibilityLabel === "Edit Test food").length, 1);
  const add = tree.find((node) => node.props.accessibilityLabel === "Add food to 17:00");
  add.props.onPress();
  assert.equal(render().find((node) => node.type === "FoodEditor").props.initialTime, "17:00");
  sqlite.close();
});

test("compiled guided setup previews generated targets and starts the program once", () => {
  const { diary, sqlite, db } = diaryDatabase();
  const store = load("src/lib/coaching-store.ts", {
    "@/db": { db, ...schema },
    "./metrics": metrics,
    "./nutrition": nutrition,
    "./food-time": foodTime,
    "./diary": diary,
    "./coaching": coaching,
    "./program": program,
  });
  const harness = screenHarness(
    diary,
    { weights: [], units: "metric" },
    { "@/lib/coaching-store": store, "@/lib/program": program }
  );
  const { ProgramEditor } = harness.load("src/components/nutrition/program-editor.tsx");
  let closed = 0;
  const render = () => nodes(harness.render(ProgramEditor, { close: () => closed++ }));
  for (const [label, value] of [
    ["Age", "30"],
    ["Height (cm)", "180"],
    ["Starting weight (kg)", "80"],
    ["Goal weight (kg)", "75"],
  ])
    render()
      .find((node) => node.type === "Field" && node.props.label === label)
      .props.onChange(value);
  render()
    .find((node) => node.type === "Choices" && node.props.values.includes("female"))
    .props.onChange("male");
  const initial = render().find(
    (node) => node.type === "Button" && node.props.children === "Start this program"
  );
  assert.equal(initial.props.isDisabled, true);
  render()
    .find((node) => node.type === "Button" && node.props.accessibilityState?.checked === false)
    .props.onPress();
  const start = render().find(
    (node) => node.type === "Button" && node.props.children === "Start this program"
  );
  assert.equal(start.props.isDisabled, false);
  start.props.onPress();
  start.props.onPress();
  assert.equal(closed, 1);
  assert.equal(db.select().from(schema.coachingGoals).all().length, 1);
  assert.ok(diary.targetsForDay(metrics.localDay()).calories > 1500);
  sqlite.close();
});

test("batch logging is atomic and undo restores prior diary completeness without touching other logs", () => {
  const { diary, sqlite, fastLog } = diaryDatabase();
  const item = fastLog.portionFor(food);
  const first = fastLog.logBatch([item], { day: "2024-01-01", time: "08:00", complete: true });
  const receipt = fastLog.logBatch([item, { ...item, portionLabel: "Second food" }], {
    day: "2024-01-01",
    time: "13:10",
  });
  assert.equal(diary.entriesForDay("2024-01-01").length, 3);
  assert.equal(diary.dayStatus("2024-01-01"), "in-progress");
  fastLog.undoLog(receipt);
  assert.deepEqual(diary.entriesForDay("2024-01-01"), first.entries);
  assert.equal(diary.dayStatus("2024-01-01"), "complete");
  assert.throws(() => fastLog.undoLog(receipt));
  const newer = fastLog.logBatch([item], { day: "2024-01-01", time: "19:00" });
  diary.saveEntry({ ...newer.entries[0], amount: 200 });
  assert.throws(() => fastLog.undoLog(newer));
  assert.equal(diary.entriesForDay("2024-01-01").length, 2);
  sqlite.exec(
    "CREATE TRIGGER fail_batch BEFORE INSERT ON food_entries WHEN NEW.portion_label = 'Second food' BEGIN SELECT RAISE(ABORT, 'disk failure'); END"
  );
  assert.throws(() =>
    fastLog.logBatch([item, { ...item, portionLabel: "Second food" }], {
      day: "2024-01-02",
      time: "12:00",
    })
  );
  assert.equal(diary.entriesForDay("2024-01-02").length, 0);
  sqlite.close();
});
test("remembered portions follow current food definitions and quick choices favor similar meal times", () => {
  const { diary, sqlite, fastLog } = diaryDatabase();
  diary.saveEntry({
    day: "2024-01-01",
    meal: "Breakfast",
    loggedTime: "08:30",
    food,
    amount: 75,
    portionLabel: "75 g",
  });
  diary.saveEntry({
    day: "2024-01-01",
    meal: "Dinner",
    loggedTime: "19:30",
    food: { ...food, id: "other", name: "Dinner food" },
    amount: 200,
    portionLabel: "200 g",
  });
  const choices = fastLog.loggingChoices("08:00");
  assert.equal(choices.quick[0].title, food.name);
  assert.equal(choices.quick[0].items[0].amount, 75);
  const previous = diary.entriesForDay("2024-01-01")[0];
  assert.equal(fastLog.portionFor({ ...food, basis: "serving", portions: [] }, previous).amount, 1);
  assert.equal(
    fastLog.portionFor({ ...food, source: "recipe", sourceVersion: "2" }, previous).amount,
    30
  );
  sqlite.close();
});
