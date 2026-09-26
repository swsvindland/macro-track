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
const rank = load("src/lib/food-rank.ts");
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
  // The latest render's effects, which a test may run itself; none run otherwise.
  const effects = [];
  let cursor = 0;
  const context = { revision: 0, refresh: () => context.revision++ };
  const react = {
    createContext: () => ({}),
    useContext: () => context,
    useEffect: (effect) => effects.push(effect),
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
    "react-native": {
      View: "View",
      TextInput: "TextInput",
      AppState: {},
      Platform: { OS: "ios" },
      Alert: { alert: () => {} },
      Keyboard: { dismiss: () => {} },
      AccessibilityInfo: {
        announceForAccessibility: () => {},
        isScreenReaderEnabled: async () => false,
      },
    },
    "expo-router": { router: {}, useIsFocused: () => true },
    "@/lib/app-actions": load("src/lib/app-actions.ts", { react }),
    "@/components/system": {
      SystemButton: "Button",
      SystemIconButton: "IconButton",
      SystemIcon: "Icon",
      SystemLabel: "Label",
      SystemPanel: { Body: "PanelBody" },
      SystemText: "Text",
      PaceBar: "PaceBar",
      MiniBar: "MiniBar",
    },
    "@/components/ui": {
      Editor: "Editor",
      Field: "Field",
      Choices: "Choices",
      DateInput: "DateInput",
      ErrorText: "Error",
      Screen: "Screen",
      ActionMenu: "ActionMenu",
      DayPicker: "DayPicker",
      SearchInput: "SearchInput",
    },
    "@/lib/diary": diary,
    "@/lib/metrics": metrics,
    "./metrics": metrics,
    "@/lib/nutrition": nutrition,
    "@/lib/food-time": foodTime,
    "@/lib/fast-log": { loggingChoices: () => ({ quick: [] }) },
    "@/components/measurements/use-measurement-log": {
      useMeasurementLog: () => ({ launch: () => {}, open: false }),
    },
    "@/components/measurements/weight-form": { WeightForm: "WeightForm" },
    "./fast-logger": { FastLogger: "FastLogger" },
    "./home-check-in": { HomeCheckIn: "HomeCheckIn" },
    "./check-in-adjuster": { CheckInAdjuster: "CheckInAdjuster" },
    "./weigh-in-card": { WeighInCard: "WeighInCard" },
    "./week-strip": { WeekStrip: "WeekStrip" },
    "./quick-log-bar": { QuickLogBar: "QuickLogBar" },
    "@/lib/weigh-in": { weighInDue: () => false, undoWeight: () => {} },
    "./food-editor": { FoodEditor: "FoodEditor", FoodRow: "FoodRow" },
    "./amount-picker": {
      AmountPicker: "AmountPicker",
      PortionPreview: "PortionPreview",
      DayRing: "DayRing",
    },
    "./time-field": { TimeField: "TimeField" },
    "./quick-add": { QuickAdd: "QuickAdd" },
    "./photo-logger": {
      PhotoLogger: "PhotoLogger",
      photoLoggingOffered: (status) => status?.state === "available",
    },
    "@/lib/local-ai": {
      modelStatus: async () => ({ state: "unavailable", engine: "none", vision: false }),
      prewarmModel: () => {},
      textRecognitionAvailable: () => false,
      recognizeText: async () => [],
    },
    "@/lib/nutrition-label": load("src/lib/nutrition-label.ts"),
    "./photo-capture": { PhotoCapture: "PhotoCapture", discardPhoto: () => {} },
    "./copy-day": { CopyDay: "CopyDay" },
    "./meal-editor": { MealEditor: "MealEditor" },
    "./recipe-editor": { RecipeEditor: "RecipeEditor" },
    "expo-camera": { CameraView: "CameraView", useCameraPermissions: () => [] },
    "@/lib/food-catalog": {
      catalogManifest: JSON.parse(readFileSync("assets/food/manifest.json", "utf8")),
    },
    "@/lib/food-rank": rank,
    "@/lib/food-icons": load("src/lib/food-icons.ts"),
    "./food-icon": { FoodIcon: "FoodIcon" },
  };
  Object.assign(dependencies, extraDependencies);
  const store = {
    diaryLayout: "meals",
    hideEmptyHours: true,
    number: (n) => String(n),
    date: (day) => day,
    ...storeOverrides,
  };
  dependencies["@/lib/store"] = dependencies["./store"] = { useStore: () => store };
  dependencies["@/lib/nutrition-store"] = load("src/lib/nutrition-store.tsx", dependencies, true);
  return {
    context,
    store,
    effects,
    load: (file) => load(file, dependencies, true),
    render(Component, props) {
      cursor = 0;
      effects.length = 0;
      return Component(props);
    },
  };
}

function nodes(tree) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [
    tree,
    ...nodes(tree.props?.children),
    ...nodes(tree.props?.footer),
    ...nodes(tree.props?.header),
  ];
}
/** Types into a portion screen's amount field, optionally in another of the food's units. */
function enterAmount(tree, text, unit) {
  const picker = tree.find((node) => node.type === "AmountPicker");
  picker.props.onChange({ unit: unit ?? picker.props.value.unit, text, fresh: false });
}
const amountAction = (tree, label) =>
  tree
    .find((node) => node.type === "AmountPicker")
    .props.actions.find((action) => action.label === label);

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
    "./metrics": metrics,
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
  assert.equal(diary.dayStatus("2024-02-01"), "partial");
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
  assert.ok(tree.some((node) => node.props?.children === "Day complete"));
  assert.ok(tree.some((node) => node.type === "Text" && node.props.children?.[0] === "1910"));
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
      const expression = rank.searchExpression(query);
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
          .all(rank.searchExpression("chicken breast")).length
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
  assert.equal(diary.logSavedMeal(saved.id, "2024-01-02", "Lunch", 0.5).inserted.length, 2);
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
    onLogged: (receipt) => (selectedDay = receipt.inserted[0].day),
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

test("compiled recipe form closes for a link while its ingredient picker takes its place", () => {
  const { diary, sqlite } = diaryDatabase();
  // Outside Home, as in Library, with the app-action hook's effects run by hand.
  const effects = [];
  const actions = load("src/lib/app-actions.ts", {
    react: {
      createContext: () => ({}),
      useContext: () => false,
      useEffect: (effect) => effects.push(effect),
    },
  });
  const harness = screenHarness(diary, {}, { "@/lib/app-actions": actions });
  const { RecipeEditor } = harness.load("src/components/nutrition/recipe-editor.tsx");
  let closed = 0;
  const props = { close: () => closed++ };
  nodes(harness.render(RecipeEditor, props))
    .find((node) => node.type === "Button" && node.props.children === "Add ingredient")
    .props.onPress();
  effects.length = 0;
  assert.equal(harness.render(RecipeEditor, props).type, "FoodEditor");
  effects.forEach((effect) => effect());
  actions.requestAppAction("log");
  assert.equal(closed, 1, "the recipe closes with its picker, leaving Home free for the link");
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
  assert.deepEqual(
    tree.find((node) => node.type === "AmountPicker").props.value,
    { unit: "g", text: "75", fresh: true },
    "an ingredient's amount opens in its basis"
  );
  amountAction(tree, "Use ingredient").onPress();
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
  assert.equal(diary.copyDay("2024-01-01", "2024-01-02").inserted.length, 2);
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
  const { diary, sqlite, fastLog } = diaryDatabase();
  const harness = screenHarness(diary, {}, { "@/lib/fast-log": fastLog });
  const { QuickAdd } = harness.load("src/components/nutrition/quick-add.tsx");
  let closed = 0;
  const receipts = [];
  const render = () =>
    nodes(
      harness.render(QuickAdd, {
        day: "2024-01-01",
        close: () => closed++,
        onLogged: (receipt) => receipts.push(receipt),
      })
    );
  render()
    .find((node) => node.props.label === "Calories (kcal)")
    .props.onChange("650");
  const button = render().find(
    (node) => node.type === "Button" && node.props.children === "Add to diary"
  );
  button.props.onPress();
  button.props.onPress();
  assert.equal(closed, 1);
  assert.equal(diary.entriesForDay("2024-01-01").length, 1);
  assert.equal(diary.entriesForDay("2024-01-01")[0].nutrients.calories, 650);
  assert.equal(diary.entriesForDay("2024-01-01")[0].nutrients.fiber, null);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].day, "2024-01-01");
  assert.equal(receipts[0].entries[0].id, diary.entriesForDay("2024-01-01")[0].id);
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
  // Hour headings use the device clock style; only the entry's own hour is shown.
  const eight = foodTime.formatClock("08:00");
  assert.ok(render().some((node) => node.props.children?.[0] === eight));
  const entry = diary.entriesForDay(day)[0];
  diary.saveEntry({ ...entry, loggedTime: "17:25" });
  harness.context.refresh();
  const tree = render();
  const five = foodTime.formatClock("17:00");
  assert.ok(tree.some((node) => node.props.children?.[0] === five));
  assert.ok(!tree.some((node) => node.props.children?.[0] === eight));
  assert.equal(tree.filter((node) => node.props.accessibilityLabel === "Edit Test food").length, 1);
  tree.find((node) => node.props.accessibilityLabel === `Log food at ${five}`).props.onPress();
  assert.equal(render().find((node) => node.type === "FastLogger").props.initialTime, "17:25");
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
    {
      "@/lib/coaching-store": store,
      "@/lib/program": program,
      "@/components/plan/calorie-shift": { CalorieShiftPicker: "CalorieShiftPicker" },
    }
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
test("remembered portions follow current food definitions and logger choices favor similar meal times", () => {
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
  assert.equal(choices.choices[0].title, food.name);
  assert.equal(choices.choices[0].items[0].amount, 75);
  assert.equal(fastLog.loggingChoices("19:00").choices[0].title, "Dinner food");
  const previous = diary.entriesForDay("2024-01-01")[0];
  assert.equal(fastLog.portionFor({ ...food, basis: "serving", portions: [] }, previous).amount, 1);
  assert.equal(
    fastLog.portionFor({ ...food, source: "recipe", sourceVersion: "2" }, previous).amount,
    30
  );
  sqlite.close();
});

const bread = {
  ...food,
  id: "custom:bread",
  name: "Sandwich bread",
  barcode: null,
  nutrients: { calories: 250, protein: 9, carbs: 47, fat: 3, fiber: 2.5, sodium: null },
  portions: [{ label: "2 SLICES (56 g)", amount: 56 }],
};

test("portion units offer weights, volumes the food converts, its own portions and kcal", () => {
  const labels = (item) => nutrition.portionUnits(item).map((unit) => unit.label);
  const perUnit = (item, key) =>
    nutrition.portionUnits(item).find((unit) => unit.key === key).perUnit;
  assert.deepEqual(labels(bread), ["g", "oz", "slice", "kcal"]);
  assert.equal(perUnit(bread, "portion:0"), 28);
  // A cup of the food gives its density, so every volume converts.
  const rice = {
    ...bread,
    portions: [
      { label: "1 cup", amount: 158 },
      { label: "1 serving (approximate serving size)", amount: 186 },
    ],
  };
  assert.deepEqual(labels(rice), [
    "g",
    "oz",
    "ml",
    "fl oz",
    "cup",
    "tbsp",
    "tsp",
    "serving",
    "kcal",
  ]);
  assert.equal(perUnit(rice, "cup"), 158);
  assert.equal(perUnit(rice, "tbsp"), 158 / 16);
  // A per-serving label with a weight and a measure converts both.
  const bar = {
    ...bread,
    basis: "serving",
    portions: [
      { label: "1 serving (2/3 cup (40 g))", amount: 1 },
      { label: "1 bar", amount: 1 },
    ],
  };
  assert.deepEqual(labels(bar), [
    "g",
    "oz",
    "ml",
    "fl oz",
    "cup",
    "tbsp",
    "tsp",
    "serving",
    "bar",
    "kcal",
  ]);
  assert.equal(perUnit(bar, "g"), 1 / 40);
  assert.equal(perUnit(bar, "cup"), 1.5);
  // A drink counts in volumes and its own fluid ounces, and has no grams without a weight.
  const drink = { ...bread, basis: "ml", portions: [{ label: "12 f oz (360 ml)", amount: 360 }] };
  assert.deepEqual(labels(drink), ["ml", "fl oz", "cup", "tbsp", "tsp", "kcal"]);
  assert.deepEqual(nutrition.defaultPortion(drink), { unit: "floz", count: 12 });
  assert.deepEqual(nutrition.defaultPortion(bread), { unit: "portion:0", count: 2 });
  assert.deepEqual(nutrition.defaultPortion({ ...bread, portions: [] }), { unit: "g", count: 100 });
  assert.ok(!labels({ ...drink, nutrients: { ...drink.nutrients, calories: 0 } }).includes("kcal"));
});

test("portion units keep exact weights and name qualified measures in full", () => {
  const units = (item) =>
    nutrition.portionUnits(item).map((unit) => [unit.key, unit.label, unit.perUnit]);
  // "1 oz, dry, yields" is what an ounce of dry couscous makes, so an ounce stays 28.35 g.
  const couscous = {
    ...bread,
    portions: [
      { label: "1 cup, dry, yields", amount: 528 },
      { label: "1 cup, cooked", amount: 157 },
      { label: "1 oz, dry, yields", amount: 86 },
    ],
  };
  assert.deepEqual(units(couscous).slice(0, 5), [
    ["g", "g", 1],
    ["oz", "oz", 28.3495],
    ["portion:0", "cup, dry, yields", 528],
    ["portion:1", "cup, cooked", 157],
    ["portion:2", "oz, dry, yields", 86],
  ]);
  assert.equal(nutrition.portionItem(couscous, "oz", 4).portionLabel, "4 oz · 113 g");
  assert.deepEqual(nutrition.defaultPortion(couscous), { unit: "portion:0", count: 1 });
  assert.equal(nutrition.portionLabelFor(couscous, "portion:0", 1), "1 cup, dry, yields · 528 g");
  // Each way of cutting a cup is offered; an unqualified cup gives the density for volumes.
  const strawberries = {
    ...bread,
    portions: [
      { label: "1 cup, pureed", amount: 232 },
      { label: "1 cup, sliced", amount: 166 },
      { label: "1 cup", amount: 144 },
      { label: '1 large (1-3/8" dia)', amount: 18 },
    ],
  };
  assert.deepEqual(
    nutrition.portionUnits(strawberries).map((unit) => unit.label),
    ["g", "oz", "ml", "fl oz", "cup", "tbsp", "tsp", "cup, pureed", "cup, sliced", "large", "kcal"]
  );
  assert.equal(nutrition.portionLabelFor(strawberries, "portion:1", 2), "2 cups, sliced · 332 g");
  assert.equal(nutrition.portionLabelFor(strawberries, "cup", 1), "1 cup · 144 g");
  // A label whose count disagrees with its weight ("4 oz. (28.349 g)") is left out, so the
  // food opens at the weight and an ounce stays an ounce.
  const tenders = { ...bread, portions: [{ label: "4 oz. (28.349 g)", amount: 28.349 }] };
  assert.deepEqual(units(tenders), [
    ["g", "g", 1],
    ["oz", "oz", 28.3495],
    ["kcal", "kcal", 0.4],
  ]);
  assert.deepEqual(nutrition.defaultPortion(tenders), { unit: "g", count: 28.349 });
  // A label ounce of 28 g is still one ounce.
  const snack = { ...bread, portions: [{ label: "1 oz (28 g)", amount: 28 }] };
  assert.deepEqual(nutrition.defaultPortion(snack), { unit: "oz", count: 1 });
});

test("amount labels count units, keep the estimate mark and never say serving(s)", () => {
  const label = (item, unit, count, estimate) =>
    nutrition.portionLabelFor(item, unit, count, { estimate });
  assert.equal(label(bread, "portion:0", 2), "2 slices · 56 g");
  assert.equal(label(bread, "portion:0", 0.5), "½ slice · 14 g");
  assert.equal(label(bread, "portion:0", 1.5), "1½ slices · 42 g");
  assert.equal(label(bread, "g", 120), "120 g");
  assert.equal(label(bread, "oz", 2), "2 oz · 57 g");
  assert.equal(label(bread, "kcal", 300, true), "≈ 300 kcal · 120 g");
  const serving = { ...bread, basis: "serving", portions: [] };
  assert.equal(label(serving, "serving", 0.5), "½ serving");
  assert.equal(label(serving, "serving", 2), "2 servings");
  assert.equal(label(serving, "kcal", 375), "375 kcal · 1½ servings");
  assert.equal(nutrition.countLabel(3, "patty"), "3 patties");
  // A doubled saved meal keeps each food's unit and estimate mark.
  const item = nutrition.portionItem(bread, "portion:0", 2, { estimate: true });
  assert.equal(item.portionLabel, "≈ 2 slices · 56 g");
  const doubled = nutrition.scaleItem(item, 2);
  assert.deepEqual(
    [doubled.amount, doubled.portionCount, doubled.portionLabel, doubled.nutrients.calories],
    [112, 4, "≈ 4 slices · 112 g", 280]
  );
  const older = {
    ...item,
    food: serving,
    amount: 1,
    portionLabel: "1 serving",
    portionUnit: null,
    portionCount: null,
  };
  assert.equal(nutrition.scaleItem(older, 1.5).portionLabel, "1½ servings");
  // A saved meal from before units doubles in the unit its label names.
  const toast = { ...item, portionLabel: "2 slices · 56 g", portionUnit: undefined };
  assert.deepEqual(
    [nutrition.scaleItem(toast, 2).portionLabel, nutrition.scaleItem(toast, 2).portionUnit],
    ["4 slices · 112 g", "portion:0"]
  );
});

test("amounts take fractions and mixed numbers and convert between units", () => {
  for (const [text, value] of [
    ["2", 2],
    [".5", 0.5],
    ["2,5", 2.5],
    ["1/2", 0.5],
    ["1 1/2", 1.5],
    ["½", 0.5],
    ["1½", 1.5],
    ["1 ¾", 1.75],
  ])
    assert.equal(nutrition.parseAmount(text), value, text);
  for (const text of ["", "abc", "1/0", "1 1", "-2", "2/"])
    assert.ok(Number.isNaN(nutrition.parseAmount(text)), text);
  assert.ok(Number.isNaN(metrics.parseNumber("1/2")), "weigh-ins keep plain decimals");
  // The keyboard types "1 1/2" one character at a time and can't type text that isn't an amount.
  let text = "";
  for (const next of ["1", "1 ", "1 1", "1 1/", "1 1/2", "1 1/2/", "1 1/2."])
    text = nutrition.editAmount(text, next);
  assert.equal(text, "1 1/2");
  assert.equal(nutrition.editAmount("1½", "1"), "1");
  assert.equal(nutrition.editAmount("1", "1,5"), "1.5");
  assert.equal(nutrition.editAmount("12", "12a"), "12");
  const units = nutrition.portionUnits(bread);
  const convert = (count, from, to) => nutrition.convertCount(units, from, count, to);
  assert.equal(convert(120, "g", "oz"), 4.2);
  assert.equal(convert(4.2, "oz", "g"), 119);
  assert.equal(convert(84, "g", "portion:0"), 3);
  assert.equal(convert(100, "g", "portion:0"), 3.5, "counts round to the nearest quarter");
  assert.equal(convert(1.5, "portion:0", "g"), 42);
  assert.equal(convert(2, "portion:0", "kcal"), 140);
  assert.equal(convert(300, "kcal", "g"), 120);
  // "300 kcal" of a food is the weight that has 300 kcal.
  const kcal = nutrition.portionItem(food, "kcal", 300);
  assert.ok(Math.abs(kcal.amount - 500 / 3) < 1e-9);
  assert.ok(Math.abs(kcal.nutrients.calories - 300) < 1e-9);
  assert.equal(kcal.portionLabel, "300 kcal · 167 g");
});

test("logging again remembers the unit and count, following the food's current portions", () => {
  const { diary, sqlite, fastLog } = diaryDatabase();
  diary.saveCustomFood(bread);
  fastLog.logBatch([nutrition.portionItem(bread, "portion:0", 2)], {
    day: metrics.localDay(),
    time: "08:00",
  });
  const first = () => fastLog.loggingChoices("08:00").choices[0];
  const read = (choice) => [
    choice.detail,
    choice.items[0].amount,
    choice.items[0].portionUnit,
    choice.items[0].portionCount,
  ];
  assert.deepEqual(read(first()), ["2 slices · 56 g", 56, "portion:0", 2]);
  // Thicker slices are still 2 slices.
  diary.saveCustomFood({ ...bread, portions: [{ label: "1 slice", amount: 32 }] });
  assert.deepEqual(read(first()), ["2 slices · 64 g", 64, "portion:0", 2]);
  // Without slices, the last amount in grams.
  diary.saveCustomFood({ ...bread, portions: [] });
  assert.deepEqual(read(first()), ["56 g", 56, "g", 56]);
  sqlite.close();
});

test("an entry from before units reopens in the unit its label names, round after round", () => {
  const { diary, sqlite, fastLog } = diaryDatabase();
  const day = metrics.localDay();
  const catalog = (id, portions) => ({
    ...food,
    id,
    name: id,
    barcode: null,
    source: "usda",
    portions,
  });
  const egg = catalog("usda:egg", [
    { label: "1 large", amount: 50 },
    { label: "1 medium", amount: 44 },
  ]);
  const milk = catalog("usda:milk", [{ label: "1 serving", amount: 244 }]);
  diary.saveEntry({
    day,
    meal: "Breakfast",
    loggedTime: "08:00",
    food: egg,
    amount: 88,
    portionLabel: "2 medium · 88 g",
  });
  // "ml" is no unit of this milk, so the label is kept as it is.
  diary.saveEntry({
    day,
    meal: "Breakfast",
    loggedTime: "08:00",
    food: milk,
    amount: 254.2,
    portionLabel: "≈ 250 ml · 254 g",
  });
  const choices = () =>
    fastLog.loggingChoices("08:00").choices.sort((a, b) => a.title.localeCompare(b.title));
  const read = () =>
    choices().map(({ detail, items: [item] }) => [
      detail,
      item.amount,
      item.portionUnit ?? null,
      item.portionCount ?? null,
    ]);
  for (let round = 0; round < 3; round++) {
    assert.deepEqual(read(), [
      ["2 medium · 88 g", 88, "portion:1", 2],
      ["≈ 250 ml · 254 g", 254.2, null, null],
    ]);
    fastLog.logBatch(
      choices().flatMap((choice) => choice.items),
      { day, time: `08:0${round + 1}` }
    );
  }
  // Older labels spell measures out, name qualified ones and may no longer fit the food.
  const jam = catalog("usda:jam", [
    { label: "1 tablespoon", amount: 17 },
    { label: "1 oz, boneless", amount: 28 },
  ]);
  const older = (portionLabel, amount) => nutrition.portionOf({ food: jam, amount, portionLabel });
  assert.deepEqual(older("2 tablespoon · 34 g", 34), { unit: "tbsp", count: 2 });
  assert.deepEqual(older("1 oz, boneless · 28 g", 28), { unit: "portion:1", count: 1 });
  assert.deepEqual(older("≈ 1½ tbsp · 26 g", 25.5), { unit: "tbsp", count: 1.5 });
  assert.deepEqual(older("3 tablespoon · 60 g", 60), { unit: "g", count: 60 });
  // Confirming it unchanged on the portion screen keeps it too.
  const kept = choices()[1].items[0];
  const same = nutrition.portionItem(milk, "g", 254.2, { previous: kept });
  assert.deepEqual(
    [same.portionLabel, same.portionUnit, same.amount],
    ["≈ 250 ml · 254 g", null, 254.2]
  );
  sqlite.close();
});

test("copied and saved meals keep each food's unit and count", () => {
  const { diary, sqlite, fastLog } = diaryDatabase();
  const day = metrics.localDay(),
    yesterday = nutrition.shiftDay(day, -1);
  diary.saveEntry({
    day: yesterday,
    meal: "Breakfast",
    loggedTime: "08:00",
    ...nutrition.portionItem(bread, "portion:0", 2),
  });
  diary.copyMeal(yesterday, "Breakfast", day, "Breakfast", "08:00");
  const saved = diary.saveMeal("Toast", yesterday, "Breakfast");
  assert.deepEqual([saved.items[0].portionUnit, saved.items[0].portionCount], ["portion:0", 2]);
  diary.logSavedMeal(saved.id, day, "Lunch", 2, "12:00");
  assert.deepEqual(
    diary
      .entriesForDay(day)
      .map((entry) => [entry.portionLabel, entry.amount, entry.portionUnit, entry.portionCount]),
    [
      ["2 slices · 56 g", 56, "portion:0", 2],
      ["4 slices · 112 g", 112, "portion:0", 4],
    ]
  );
  const [choice] = fastLog.loggingChoices("12:00").choices;
  assert.deepEqual(
    [choice.detail, choice.items[0].portionUnit, choice.items[0].portionCount],
    ["4 slices · 112 g", "portion:0", 4]
  );
  sqlite.close();
});

test("an entry's unit and count survive a backup, and older backups restore without them", () => {
  const { diary, sqlite, backup } = diaryDatabase();
  diary.saveEntry({
    day: "2024-01-01",
    meal: "Breakfast",
    ...nutrition.portionItem(bread, "portion:0", 1.5),
  });
  const original = backup.createBackup();
  const [saved] = original.data.entries;
  assert.deepEqual([saved.portionUnit, saved.portionCount], ["portion:0", 1.5]);
  backup.restoreBackup(backup.parseBackup(JSON.stringify(original)));
  assert.deepEqual(backup.createBackup().data, original.data);
  const older = JSON.parse(JSON.stringify(original));
  for (const entry of older.data.entries) {
    delete entry.portionUnit;
    delete entry.portionCount;
  }
  backup.restoreBackup(older);
  const [restored] = diary.entriesForDay("2024-01-01");
  assert.deepEqual(
    [restored.portionUnit, restored.portionCount, restored.portionLabel, restored.amount],
    [null, null, "1½ slices · 42 g", 42]
  );
  sqlite.close();
});

test("compiled entry editor keeps the amount and label when only the time changes", () => {
  const { diary, sqlite } = diaryDatabase();
  const day = metrics.localDay();
  diary.saveEntry({
    day,
    meal: "Breakfast",
    loggedTime: "08:00",
    ...nutrition.portionItem(bread, "portion:0", 2, { estimate: true }),
  });
  diary.saveEntry({
    day,
    meal: "Breakfast",
    loggedTime: "08:05",
    food,
    amount: 50,
    portionLabel: "1 large · 50 g",
  });
  const edit = (entry, change) => {
    const harness = screenHarness(diary, { diaryLayout: "timeline" });
    const { FoodEditor } = harness.load("src/components/nutrition/food-editor.tsx");
    const render = () => nodes(harness.render(FoodEditor, { entry, close: () => {} }));
    change(render);
    amountAction(render(), "Save changes").onPress();
  };
  const time = (value) => (render) =>
    render()
      .find((node) => node.type === "TimeField")
      .props.onChange(value);
  let [estimate, older] = diary.entriesForDay(day);
  edit(estimate, (render) => {
    const tree = render();
    const at = (type) => tree.findIndex((node) => node.type === type);
    assert.ok(at("TimeField") < at("PortionPreview"), "a correction starts with the time");
    time("09:15")(render);
  });
  edit(older, time("09:20"));
  [estimate, older] = diary.entriesForDay(day);
  assert.deepEqual(
    [estimate.loggedTime, estimate.amount, estimate.portionLabel, estimate.portionCount],
    ["09:15", 56, "≈ 2 slices · 56 g", 2]
  );
  assert.deepEqual(
    [older.loggedTime, older.amount, older.portionLabel],
    ["09:20", 50, "1 large · 50 g"]
  );
  // A new amount is the person's own, so it is labeled afresh.
  edit(estimate, (render) => {
    assert.deepEqual(render().find((node) => node.type === "AmountPicker").props.value, {
      unit: "portion:0",
      text: "2",
      fresh: true,
    });
    enterAmount(render(), "3");
  });
  [estimate] = diary.entriesForDay(day);
  assert.deepEqual(
    [estimate.amount, estimate.portionLabel, estimate.portionCount],
    [84, "3 slices · 84 g", 3]
  );
  sqlite.close();
});

/** Types a keypad key into the amount field as the system keyboard would: a selected amount is replaced. */
function typeKey(input, key) {
  const { value, selection } = input.props;
  const selected = !!selection && selection.end > selection.start;
  input.props.onChangeText(
    key === "⌫" ? (selected ? "" : value.slice(0, -1)) : (selected ? "" : value) + key
  );
}
/** FastLogger with the real, compiled amount picker, whose keys and chips a test can press. */
function keypadLogger(diary, fastLog) {
  const keypad = screenHarness(
    diary,
    {},
    {
      "react-native-svg": { __esModule: true, default: "Svg", Circle: "Circle" },
      "heroui-native": { useThemeColor: () => "#000000" },
    }
  );
  const picker = keypad.load("src/components/nutrition/amount-picker.tsx");
  const harness = screenHarness(
    diary,
    {},
    { "@/lib/fast-log": fastLog, "./amount-picker": picker }
  );
  const { FastLogger } = harness.load("src/components/nutrition/fast-logger.tsx");
  const state = { closed: 0 };
  const render = () =>
    nodes(
      harness.render(FastLogger, {
        initialDay: metrics.localDay(),
        initialTime: "08:10",
        close: () => state.closed++,
        onLogged: () => {},
      })
    );
  const props = (type) => render().find((node) => node.type === type).props;
  const pad = () => nodes(keypad.render(picker.AmountPicker, props(picker.AmountPicker)));
  return {
    state,
    render,
    value: () => props(picker.AmountPicker).value,
    preview: () => props(picker.PortionPreview),
    ring: () => props(picker.DayRing),
    press: (...keys) => {
      for (const key of keys)
        typeKey(
          pad().find((node) => node.type === "TextInput"),
          key
        );
    },
    chip: (label) => pad().find((node) => node.props.unit?.label === label),
    button: (label) =>
      pad().find(
        (node) =>
          (node.type === "Button" && node.props.children === label) ||
          (node.type === "IconButton" && node.props.accessibilityLabel === label)
      ),
  };
}

test("compiled amount field logs 1 1/2 slices, converts a prefilled amount and logs 300 kcal as grams", () => {
  const { diary, sqlite, fastLog } = diaryDatabase();
  const day = metrics.localDay();
  diary.saveCustomFood(bread);
  diary.saveTargets(day, { calories: 2000, protein: 150, carbs: 200, fat: 70 });
  diary.saveEntry({
    day: nutrition.shiftDay(day, -1),
    meal: "Breakfast",
    loggedTime: "08:00",
    ...nutrition.portionItem(bread, "g", 60),
  });
  let logger = keypadLogger(diary, fastLog);
  logger
    .render()
    .find((node) => node.props.accessibilityLabel === `Adjust ${bread.name}`)
    .props.onPress();
  assert.deepEqual(logger.value(), { unit: "g", text: "60", fresh: true });
  // A prefilled amount converts, so the preview hardly moves: 60 g is about 2¼ slices.
  logger.chip("slice").props.onPress();
  assert.deepEqual(logger.value(), { unit: "portion:0", text: "2¼", fresh: true });
  assert.equal(logger.chip("slice").props.selected, true);
  assert.equal(logger.chip("g").props.selected, false);
  // A typed number keeps its value when a unit is picked after it.
  logger.chip("g").props.onPress();
  logger.press("1", " ", "1", "/", "2");
  assert.equal(logger.value().text, "1 1/2");
  logger.chip("slice").props.onPress();
  assert.deepEqual(logger.value(), { unit: "portion:0", text: "1 1/2", fresh: true });
  assert.equal(logger.preview().nutrients.calories, 105);
  assert.equal(logger.preview().targets.calories, 2000, "rings use the day's targets");
  assert.deepEqual(logger.ring(), { calories: 105, target: 2000 });
  logger.button("Add").props.onPress();
  assert.deepEqual(
    logger.ring(),
    { calories: 105, target: 2000 },
    "the header counts the selection"
  );
  logger
    .render()
    .find((node) => node.props.children === "Log 1 food")
    .props.onPress();
  let [entry] = diary.entriesForDay(day);
  assert.deepEqual(
    [entry.amount, entry.portionLabel, entry.portionUnit, entry.portionCount],
    [42, "1½ slices · 42 g", "portion:0", 1.5]
  );
  assert.equal(logger.state.closed, 1);

  // Next time it opens at 1½ slices; − then two taps on + make 2, and kcal converts them.
  logger = keypadLogger(diary, fastLog);
  logger
    .render()
    .find((node) => node.props.accessibilityLabel === `Adjust ${bread.name}`)
    .props.onPress();
  assert.deepEqual(logger.value(), { unit: "portion:0", text: "1½", fresh: true });
  logger.button("Decrease by ½ slice").props.onPress();
  logger.button("Increase by ½ slice").props.onPress();
  logger.button("Increase by ½ slice").props.onPress();
  assert.equal(logger.value().text, "2");
  logger.chip("kcal").props.onPress();
  assert.deepEqual(logger.value(), { unit: "kcal", text: "140", fresh: true });
  logger.press("3", "0", "0");
  logger.button("Log").props.onPress();
  entry = diary.entriesForDay(day)[1];
  assert.deepEqual(
    [entry.amount, entry.nutrients.calories, entry.portionLabel, entry.portionUnit],
    [120, 300, "300 kcal · 120 g", "kcal"]
  );
  sqlite.close();
});

test("the portion screen saves a catalog food as a saved food", () => {
  const { diary, sqlite, render } = fastLoggerHarness();
  const catalog = { ...bread, id: "usda:bread", source: "usda", barcode: null };
  diary.saveEntry({
    day: metrics.localDay(),
    meal: "Breakfast",
    loggedTime: "08:00",
    ...nutrition.portionItem(catalog, "portion:0", 2),
  });
  render()
    .find((node) => node.props.accessibilityLabel === `Adjust ${catalog.name}`)
    .props.onPress();
  const icon = (label) => render().find((node) => node.props.accessibilityLabel === label);
  icon("Save food").props.onPress();
  assert.deepEqual(
    diary.favoriteFoods().map((row) => row.id),
    [catalog.id]
  );
  assert.ok(icon("Remove from saved foods"));
  // Without a way to edit or delete one's own foods, a copy would only clutter search.
  assert.equal(icon("Save as my food"), undefined);
  sqlite.close();
});

/** Writes diary history straight to SQLite, dated `daysAgo` and created when it was eaten. */
function historyWriter(sqlite) {
  const insert = sqlite.prepare(
    "INSERT INTO food_entries (day, meal, logged_time, food, amount, portion_label, nutrients, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  return (item, daysAgo, time, amount = 100) => {
    const day = nutrition.shiftDay(metrics.localDay(), -daysAgo);
    insert.run(
      day,
      "Breakfast",
      time,
      JSON.stringify(item),
      amount,
      `${amount} g`,
      JSON.stringify(nutrition.scaleNutrients(item, amount)),
      new Date(`${day}T${foodTime.validFoodTime(time ?? "") ? time : "12:00"}:00`).getTime()
    );
  };
}
const named = (name) => ({ ...food, id: `custom:${name.toLowerCase()}`, name, barcode: null });

test("log again ranks foods by how often, how recently and how near this time they are eaten", () => {
  const { sqlite, fastLog } = diaryDatabase();
  const eat = historyWriter(sqlite);
  const oats = named("Oats"),
    once = named("Once"),
    weekly = named("Weekly"),
    stale = named("Stale");
  for (let day = 1; day <= 30; day++) eat(oats, day, "08:00");
  eat(once, 1, "08:05");
  // Eaten every week until eight weeks ago.
  for (let day = 56; day <= 175; day += 7) eat(weekly, day, "12:00", 55);
  eat(stale, 70, "12:00");
  const titles = (time) => fastLog.loggingChoices(time).choices.map((choice) => choice.title);
  assert.deepEqual(titles("08:00").slice(0, 2), ["Oats", "Once"], "a daily food beats a one-off");
  const noon = fastLog.loggingChoices("12:00");
  const order = noon.choices.map((choice) => choice.title);
  assert.ok(order.indexOf("Weekly") >= 0 && order.indexOf("Weekly") < order.indexOf("Stale"));
  assert.ok(noon.known.get(weekly.id) > noon.known.get(stale.id));
  assert.equal(noon.latest.get(weekly.id).amount, 55);
  assert.equal(noon.choices.find((choice) => choice.title === "Weekly").items[0].amount, 55);
  sqlite.close();
});

test("log again ranking survives invalid times without NaN", () => {
  const { sqlite, fastLog } = diaryDatabase();
  const eat = historyWriter(sqlite);
  const often = named("Often"),
    rare = named("Rare");
  for (let day = 1; day <= 10; day++) eat(often, day, "13:00");
  eat(rare, 2, "07:00");
  // A time saved by an older version, and an entry without one.
  eat(rare, 3, "7:5");
  eat(rare, 4, null);
  // An unreadable time ranks like now, the time field's default.
  const titles = (time) => fastLog.loggingChoices(time).choices.map((choice) => choice.title);
  assert.deepEqual(titles("13:00"), ["Often", "Rare"]);
  for (const time of ["25:99", "", "8:0", "noon"]) {
    const { known } = fastLog.loggingChoices(time);
    assert.ok([...known.values()].every(Number.isFinite), time);
    assert.deepEqual(titles(time), titles(foodTime.currentFoodTime()), time);
  }
  sqlite.close();
});

test("saved foods stay visible above a long history and add in one tap", () => {
  const { diary, sqlite, fastLog } = diaryDatabase();
  const eat = historyWriter(sqlite);
  for (let i = 0; i < 40; i++) eat(named(`Food ${i}`), 1 + (i % 5), "12:00");
  const never = named("Never eaten");
  const old = named("Old favorite");
  eat(old, 150, "20:00", 42);
  eat(named("Food 0"), 1, "12:05");
  diary.toggleFavorite(never);
  diary.toggleFavorite(old);
  diary.toggleFavorite(named("Food 0"));
  const choices = fastLog.loggingChoices("12:00");
  assert.deepEqual(choices.saved.map((choice) => choice.title).sort(), [
    "Food 0",
    "Never eaten",
    "Old favorite",
  ]);
  assert.equal(
    choices.saved.find((choice) => choice.title === "Old favorite").items[0].amount,
    42,
    "a favorite outside the top foods keeps its portion"
  );
  const harness = screenHarness(diary, {}, { "@/lib/fast-log": fastLog });
  const { FastLogger } = harness.load("src/components/nutrition/fast-logger.tsx");
  const render = () =>
    nodes(
      harness.render(FastLogger, {
        initialDay: metrics.localDay(),
        initialTime: "12:00",
        close: () => {},
        onLogged: () => {},
      })
    );
  let tree = render();
  const rows = tree
    .filter((node) => node.props.accessibilityLabel?.startsWith("Adjust "))
    .map((node) => node.props.accessibilityLabel.slice(7));
  assert.equal(rows.length, 14);
  assert.ok(!rows.includes("Food 0"), "a saved food is listed once, in its row");
  const tile = tree.find((node) => node.props.accessibilityLabel === "Add Never eaten");
  assert.ok(tile, "a never-eaten saved food is visible");
  assert.match(tile.props.accessibilityValue.text, /^[\d.]+ kcal$/, "VoiceOver hears its calories");
  assert.ok(tree.some((node) => node.props.children === "Saved foods"));
  tile.props.onPress();
  tree = render();
  assert.ok(tree.some((node) => node.props.accessibilityLabel === "Remove Never eaten"));
  assert.ok(tree.some((node) => node.props.children === "Log 1 food"));
  tree.find((node) => node.props.accessibilityLabel === "Add Old favorite").props.onLongPress();
  assert.deepEqual(render().find((node) => node.type === "AmountPicker").props.value, {
    unit: "g",
    text: "42",
    fresh: true,
  });
  sqlite.close();
});

test("log again rows show calories and macros before the portion", () => {
  const { diary, sqlite, fastLog } = diaryDatabase();
  historyWriter(sqlite)(food, 1, "08:00", 50);
  const harness = screenHarness(diary, {}, { "@/lib/fast-log": fastLog });
  const { FastLogger } = harness.load("src/components/nutrition/fast-logger.tsx");
  const texts = nodes(
    harness.render(FastLogger, {
      initialDay: metrics.localDay(),
      initialTime: "08:00",
      close: () => {},
      onLogged: () => {},
    })
  )
    .filter((node) => node.type === "Text")
    .map((node) => node.props.children);
  assert.ok(texts.includes("90 kcal 5P 3F 10C · "));
  assert.ok(texts.includes("50 g"));
  sqlite.close();
});

test("search finds foods eaten beyond the top 40 with their last portion at any time", async () => {
  const { diary, sqlite, fastLog } = diaryDatabase();
  const eat = historyWriter(sqlite);
  for (let i = 0; i < 45; i++)
    for (let day = 1; day <= 3; day++) eat(named(`Food ${i}`), day, "08:00");
  const catalog = (id, name, brand, source) => ({
    ...food,
    id,
    name,
    brand,
    source,
    barcode: null,
  });
  const yogurt = catalog("off:5200", "Greek Yogurt Plain", "Fage", "off");
  const salmon = catalog("usda:175168", "Salmon, cooked", "", "usda");
  const strawberry = catalog("off:5300", "Strawberry Yogurt", "Chobani", "off");
  eat(yogurt, 2, "15:00", 170);
  eat(salmon, 1, "19:00", 200);
  const yogurtMatch = (named) => rank.matchesQuery("yogurt", named);
  for (const time of ["08:00", "15:00"]) {
    const data = fastLog.loggingChoices(time);
    const recalled = [
      ...data.choices.filter((choice) => yogurtMatch(choice.items[0].food)),
      ...data.recall(yogurtMatch),
    ];
    assert.deepEqual(
      recalled.map((choice) => [choice.title, choice.items[0].amount]),
      [["Greek Yogurt Plain", 170]],
      time
    );
    assert.deepEqual(
      data.choose([salmon, strawberry]).map((choice) => choice.items[0].amount),
      [200, 30],
      `${time}: a catalog result reuses the last portion of a food eaten beyond the top ones`
    );
  }
  assert.ok(
    !fastLog.loggingChoices("08:00").choices.some((choice) => choice.title === yogurt.name)
  );
  const harness = screenHarness(
    diary,
    {},
    {
      "@/lib/fast-log": fastLog,
      "@/lib/food-catalog": { searchFoods: async () => [strawberry, yogurt] },
    }
  );
  const { FastLogger } = harness.load("src/components/nutrition/fast-logger.tsx");
  const render = () =>
    nodes(
      harness.render(FastLogger, {
        initialDay: metrics.localDay(),
        initialTime: "08:00",
        close: () => {},
        onLogged: () => {},
      })
    );
  const titles = (tree) =>
    tree
      .filter((node) => node.props.accessibilityLabel?.startsWith("Adjust "))
      .map((node) => node.props.accessibilityLabel.slice(7));
  render()
    .find((node) => node.type === "SearchInput")
    .props.onChange("yogurt");
  let tree = render();
  assert.deepEqual(titles(tree), [yogurt.name], "the eaten yogurt is listed before the catalog");
  harness.effects.forEach((effect) => effect());
  await new Promise((resolve) => setTimeout(resolve, 200));
  tree = render();
  assert.deepEqual(titles(tree), [yogurt.name, strawberry.name], "listed once, first");
  const texts = tree.filter((node) => node.type === "Text").map((node) => node.props.children);
  assert.ok(texts.includes("Fage · 170 g"));
  assert.ok(texts.includes("Chobani · 1 serving · 30 g"));
  sqlite.close();
});

test("log again ranks 13k diary entries quickly from a light indexed read", () => {
  const { sqlite, fastLog } = diaryDatabase();
  const eat = historyWriter(sqlite);
  const foods = Array.from({ length: 400 }, (_, i) => named(`Food ${i}`));
  // Three years of logging about 12 foods a day.
  sqlite.exec("BEGIN");
  for (let i = 0; i < 13000; i++)
    eat(
      foods[(i * 7919) % foods.length],
      i % 1095,
      `${String(i % 24).padStart(2, "0")}:${String((i * 13) % 60).padStart(2, "0")}`
    );
  sqlite.exec("COMMIT");
  const statements = [];
  const prepare = sqlite.prepare.bind(sqlite);
  sqlite.prepare = (sql) => {
    statements.push(sql);
    return prepare(sql);
  };
  fastLog.loggingChoices("08:00");
  const times = [];
  for (let run = 0; run < 5; run++) {
    const start = performance.now();
    const { choices } = fastLog.loggingChoices("12:30");
    times.push(performance.now() - start);
    assert.ok(choices.length >= 40);
  }
  // A search reads the other foods' names, then full rows for the ones it matches.
  const data = fastLog.loggingChoices("12:30");
  const start = performance.now();
  const recalled = data.recall((named) => named.name.endsWith("7"));
  const recall = performance.now() - start;
  assert.ok(recall < 20, `search recall took ${recall.toFixed(1)} ms`);
  assert.ok(recalled.length && recalled.every((choice) => choice.title.endsWith("7")));
  assert.equal(
    recalled.length + data.choices.filter((choice) => choice.title.endsWith("7")).length,
    40
  );
  sqlite.prepare = prepare;
  const median = times.sort((a, b) => a - b)[2];
  assert.ok(median < 20, `ranking took ${median.toFixed(1)} ms`);
  const light = statements.find((sql) => sql.includes("json_extract"));
  const plan = sqlite
    .prepare(`EXPLAIN QUERY PLAN ${light}`)
    .all(...Array(light.split("?").length - 1).fill(0));
  assert.ok(plan.some((row) => row.detail.includes("food_entries_recent_idx")));
  assert.ok(plan.every((row) => !row.detail.includes("TEMP B-TREE")));
  // Full rows are read only for the top foods and search matches, by id.
  const full = statements.filter(
    (sql) => sql.includes('from "food_entries"') && sql.includes('"nutrients"')
  );
  assert.ok(full.length && full.every((sql) => /"id" in \(/.test(sql)), full.join("\n"));
  sqlite.close();
});

test("compiled fast logger logs a whole meal once, remembers quantities, and closes immediately", () => {
  const { diary, sqlite, fastLog } = diaryDatabase();
  const day = metrics.localDay();
  const second = { ...food, id: "custom:second", name: "Second food" };
  for (const [item, amount] of [
    [food, 75],
    [second, 120],
  ])
    diary.saveEntry({
      day: "2024-01-01",
      meal: "Breakfast",
      food: item,
      amount,
      portionLabel: `${amount} g`,
    });
  const harness = screenHarness(diary, { diaryLayout: "timeline" }, { "@/lib/fast-log": fastLog });
  const { FastLogger } = harness.load("src/components/nutrition/fast-logger.tsx");
  let closed = 0,
    receipt;
  const render = () =>
    nodes(
      harness.render(FastLogger, {
        initialDay: day,
        initialTime: "12:35",
        close: () => closed++,
        onLogged: (value) => {
          receipt = value;
        },
      })
    );
  for (const name of [food.name, second.name])
    render()
      .find((node) => node.props.accessibilityLabel === `Add ${name}`)
      .props.onPress();
  assert.equal(
    diary.entriesForDay(day).length,
    0,
    "selection is a draft until the one save action"
  );
  // Completing a day belongs to Home's morning card and day menu, not the logger.
  assert.ok(
    render().every((node) => !/finish day|day complete/i.test(node.props.accessibilityLabel ?? ""))
  );
  const submit = render().find(
    (node) => node.type === "Button" && node.props.children === "Log 2 foods"
  );
  assert.ok(!submit.props.isDisabled);
  submit.props.onPress();
  submit.props.onPress();
  const entries = diary.entriesForDay(day);
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((row) => row.amount).sort((a, b) => a - b),
    [75, 120]
  );
  assert.ok(entries.every((row) => row.loggedTime === "12:35" && row.meal === "Lunch"));
  assert.equal(nutrition.totalNutrients(entries.map((row) => row.nutrients)).calories, 351);
  assert.equal(diary.dayStatus(day), "in-progress");
  assert.equal(closed, 1);
  fastLog.undoLog(receipt);
  assert.equal(diary.entriesForDay(day).length, 0);
  assert.equal(diary.dayStatus(day), "in-progress");
  sqlite.close();
});

test("compiled fast logger keeps selected foods through scanning and permits quantity correction", () => {
  const { diary, sqlite, fastLog } = diaryDatabase();
  diary.saveCustomFood(food);
  const harness = screenHarness(diary, {}, { "@/lib/fast-log": fastLog });
  const { FastLogger } = harness.load("src/components/nutrition/fast-logger.tsx");
  const day = metrics.localDay();
  const render = () =>
    nodes(
      harness.render(FastLogger, {
        initialDay: day,
        initialTime: "09:10",
        close: () => {},
        onLogged: () => {},
      })
    );
  render()
    .find((node) => node.props.accessibilityLabel === `Adjust ${food.name}`)
    .props.onPress();
  enterAmount(render(), "90", "g");
  amountAction(render(), "Add").onPress();
  assert.equal(diary.entriesForDay(day).length, 0, "Add keeps a draft");
  render()
    .find((node) => node.props.children === "Scan")
    .props.onPress();
  const picker = render().find((node) => node.type === "FoodEditor");
  assert.equal(picker.props.initialMode, "barcode");
  assert.equal(picker.props.pickLabel, undefined, "a scan joins the selected foods");
  const scanned = { ...food, id: "off:scan", name: "Scanned food", source: "off" };
  picker.props.onPick(scanned, 50, nutrition.portionItem(scanned, "g", 50));
  picker.props.close();
  render()
    .find((node) => node.props.children === "Log 2 foods")
    .props.onPress();
  assert.deepEqual(
    diary.entriesForDay(day).map((row) => row.amount),
    [90, 50]
  );
  sqlite.close();
});

test("compiled Home opens the logger in place, refreshes totals and offers safe undo", () => {
  const { diary, sqlite, fastLog } = diaryDatabase();
  const harness = screenHarness(diary, { diaryLayout: "timeline" }, { "@/lib/fast-log": fastLog });
  const { TodayScreen } = harness.load("src/components/nutrition/today-screen.tsx");
  const render = () => nodes(harness.render(TodayScreen));
  const bar = () => render().find((node) => node.type === "QuickLogBar").props;
  bar().onAction("search");
  let logger = render().find((node) => node.type === "FastLogger");
  assert.equal(logger.props.start, "typing");
  logger.props.close();
  bar().onAction("scan");
  logger = render().find((node) => node.type === "FastLogger");
  assert.equal(logger.props.start, "barcode");
  const receipt = fastLog.logBatch([fastLog.portionFor(food)], { time: "12:00" });
  harness.context.refresh();
  logger.props.onLogged(receipt);
  logger.props.close();
  const tree = render();
  assert.ok(tree.some((node) => node.props.accessibilityLabel === `Edit ${food.name}`));
  assert.ok(tree.some((node) => node.type === "Text" && node.props.children?.[0] === "54"));
  const undo = tree.find((node) => node.props.children === "Undo");
  undo.props.onPress();
  undo.props.onPress();
  assert.equal(diary.entriesForDay(metrics.localDay()).length, 0);
  assert.ok(render().some((node) => node.props.children === "Log undone."));
  sqlite.close();
});

// Counts SQLite statements, so tests can tell a cached render from a fresh read.
function countReads(sqlite) {
  const counter = { reads: 0 };
  const prepare = sqlite.prepare;
  sqlite.prepare = function (sql) {
    counter.reads++;
    return prepare.call(this, sql);
  };
  return counter;
}

test("compiled Home reads the diary once per write; re-renders and the clock reuse it", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: new Date(2024, 0, 10, 12, 0, 10) });
  const { diary, sqlite, db, fastLog } = diaryDatabase();
  const today = metrics.localDay();
  assert.equal(today, "2024-01-10");
  diary.saveTargets("2024-01-01", { calories: 2000, protein: 100, carbs: 250, fat: 60 });
  // Three usual days: 600 kcal just after noon and 700 in the evening, logged in real time.
  for (const day of ["2024-01-07", "2024-01-08", "2024-01-09"]) {
    for (const [loggedTime, calories] of [
      ["08:00", 500],
      ["12:01", 600],
      ["19:00", 700],
    ])
      db.insert(schema.foodEntries)
        .values({
          day,
          meal: "Lunch",
          loggedTime,
          food,
          amount: 1,
          portionLabel: "1",
          nutrients: { ...food.nutrients, calories },
          createdAt: new Date(`${day}T${loggedTime}:00`).getTime(),
        })
        .run();
    db.insert(schema.diaryDays).values({ day, status: "complete" }).run();
  }
  diary.saveEntry({
    day: today,
    meal: "Breakfast",
    food: { ...food, basis: "serving", nutrients: { ...food.nutrients, calories: 500 } },
    amount: 1,
    portionLabel: "1 serving",
    loggedTime: "08:00",
  });
  const listeners = [];
  const harness = screenHarness(
    diary,
    { diaryLayout: "timeline" },
    {
      "@/lib/fast-log": fastLog,
      "@/lib/food-catalog": { openCatalogs: async () => {} },
      "react-native": {
        View: "View",
        Platform: { OS: "ios" },
        AccessibilityInfo: { announceForAccessibility: () => {} },
        AppState: {
          addEventListener: (_, listener) => {
            listeners.push(listener);
            return { remove: () => {} };
          },
        },
      },
    }
  );
  const { TodayScreen } = harness.load("src/components/nutrition/today-screen.tsx");
  const render = () => nodes(harness.render(TodayScreen));
  const text = (tree, value) => tree.some((node) => node.props?.children === value);
  const counter = countReads(sqlite);
  let tree = render();
  const stop = harness.effects[0]();
  const settled = counter.reads;
  assert.ok(settled > 0);
  assert.ok(text(tree, "On pace for ~1800"), "the usual 1300 kcal after 12:00");

  render()
    .find((node) => node.type === "QuickLogBar")
    .props.onAction("search");
  render()
    .find((node) => node.type === "FastLogger")
    .props.close();
  // Back in the app within the same minute.
  listeners.forEach((listener) => listener("active"));
  render();
  assert.equal(counter.reads, settled, "opening a sheet or returning doesn't re-read the diary");

  t.mock.timers.tick(50_000);
  tree = render();
  assert.equal(counter.reads, settled, "the minute tick only moves the pace cutoff");
  assert.ok(text(tree, "On pace for ~1200"), "the 12:01 food no longer counts as still to come");

  fastLog.logBatch([fastLog.portionFor(food)], { time: "12:01" });
  harness.context.refresh();
  tree = render();
  assert.ok(counter.reads > settled);
  assert.ok(tree.some((node) => node.type === "Text" && node.props.children?.[0] === "1446"));
  assert.ok(text(tree, "On pace for ~1250"));
  stop();
  sqlite.close();
});

for (const enoughData of [true, false])
  test(`compiled Home check-in ${enoughData ? "accepts new" : "keeps current"} targets in one action and clears when finished`, () => {
    const { diary, sqlite, db } = diaryDatabase();
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
    if (enoughData)
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
          .values({ weightKg: 80, measuredAt: `${row.day}T12:00:00Z` })
          .run();
      }
    const harness = screenHarness(
      diary,
      {},
      { "@/lib/coaching-store": store, "@/lib/metrics": fakeMetrics }
    );
    const { HomeCheckIn } = harness.load("src/components/nutrition/home-check-in.tsx");
    let done = 0;
    const render = () =>
      nodes(
        harness.render(HomeCheckIn, {
          onDone: () => done++,
          onWeighIn: () => {},
          onReviewLogs: () => {},
        })
      );
    const action = render().find(
      (node) => node.props.children === (enoughData ? "Accept plan" : "Keep targets this week")
    );
    assert.ok(action);
    action.props.onPress();
    action.props.onPress();
    assert.equal(done, 1);
    assert.equal(store.checkInHistory().length, 1);
    assert.equal(diary.targetsForDay("2024-02-01").calories, enoughData ? 2180 : 2200);
    assert.equal(diary.targetsForDay("2024-01-31").calories, 2200);
    assert.equal(render().length, 0, "finished check-in disappears without navigation or reload");
    sqlite.close();
  });

test("compiled Home check-in reads once per change and refreshes after a weight write", () => {
  const { diary, sqlite, db } = diaryDatabase();
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
  }
  const harness = screenHarness(
    diary,
    { weights: [] },
    { "@/lib/coaching-store": store, "@/lib/metrics": fakeMetrics }
  );
  const { HomeCheckIn } = harness.load("src/components/nutrition/home-check-in.tsx");
  const counter = countReads(sqlite);
  const render = () =>
    nodes(
      harness.render(HomeCheckIn, { onDone: () => {}, onWeighIn: () => {}, onReviewLogs: () => {} })
    );
  const button = (tree, label) => tree.find((node) => node.props.children === label);
  let tree = render();
  assert.ok(button(tree, "Keep targets this week"), "no weigh-ins yet");
  const settled = counter.reads;
  render();
  assert.equal(counter.reads, settled);
  // Log weight and Health save through the store alone; its new weights array is the signal.
  for (const row of input.days)
    db.insert(schema.weightEntries)
      .values({ weightKg: 80, measuredAt: `${row.day}T12:00:00Z` })
      .run();
  harness.store.weights = db.select().from(schema.weightEntries).all();
  tree = render();
  assert.ok(button(tree, "Accept plan"));
  sqlite.close();
});

test("the store keeps its value and weights until they change, so cached reads stay valid", () => {
  const { diary, sqlite, db } = diaryDatabase();
  const harness = screenHarness(
    diary,
    {},
    {
      "@/db": { db, ...schema },
      "./nutrition": nutrition,
      "./translations": load("src/lib/translations.ts"),
      "./health-schedule": {},
      uniwind: { Uniwind: { setTheme: () => {} } },
      "expo-localization": { useLocales: () => [{ languageCode: "en" }] },
    }
  );
  const { StoreProvider } = harness.load("src/lib/store.tsx");
  const value = () => harness.render(StoreProvider, { children: null }).props.value;
  const first = value();
  assert.equal(value(), first, "a re-render keeps the context value");
  first.setPreference("units", "imperial");
  const second = value();
  assert.equal(second.units, "imperial");
  assert.equal(second.weights, first.weights, "a preference change keeps diary reads cached");
  db.insert(schema.weightEntries)
    .values({ weightKg: 80, measuredAt: new Date().toISOString() })
    .run();
  second.refresh();
  const third = value();
  assert.notEqual(third.weights, second.weights, "a weight write invalidates coaching reads");
  assert.equal(third.weights.length, 1);
  assert.equal(third.number(1234.56), "1,234.6");
  assert.equal(third.number(1234.56, 0), "1,235");
  sqlite.close();
});

test("compiled Plan check-in waits for the last open day, then accepts once in the user's units", () => {
  const { diary, sqlite, db } = diaryDatabase();
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
    // Yesterday stays open, so the review can't use it yet.
    if (row.day !== "2024-01-31") diary.setDayStatus(row.day, "complete");
    db.insert(schema.weightEntries)
      .values({ weightKg: 80, measuredAt: `${row.day}T12:00:00Z` })
      .run();
  }
  const harness = screenHarness(
    diary,
    { units: "imperial", language: "en" },
    {
      "@/lib/coaching-store": store,
      "@/lib/metrics": fakeMetrics,
      "./program-editor": { ProgramEditor: "ProgramEditor" },
      "@/components/plan/calorie-shift": { ShiftWeek: "ShiftWeek" },
      "@/components/plan/strategy": { CheckInRing: "CheckInRing", ProgramCard: "ProgramCard" },
    }
  );
  const { CoachingPanel } = harness.load("src/components/nutrition/coaching-panel.tsx");
  let changed = 0;
  const render = () => nodes(harness.render(CoachingPanel, { onTargetsChanged: () => changed++ }));
  const button = (label) =>
    render().find((node) => node.type === "Button" && node.props.children === label);
  assert.equal(button("Keep current plan").props.isDisabled, true);
  assert.equal(button("Accept this week’s plan"), undefined);
  button("Complete").props.onPress();
  const accept = button("Accept this week’s plan");
  assert.equal(accept.props.isDisabled, false);
  assert.match(
    render().find((node) => node.props.title === "Goal pace").props.value,
    /^−0\.44\d* lb\/wk$/
  );
  accept.props.onPress();
  accept.props.onPress();
  assert.equal(changed, 1);
  assert.equal(store.checkInHistory().length, 1);
  assert.equal(diary.targetsForDay("2024-02-01").calories, 2180);
  assert.deepEqual(
    render()
      .filter((node) => node.type === "Error")
      .map((node) => node.props.message),
    ["", ""],
    "a repeated tap is ignored instead of reporting that the check-in isn't due"
  );
  assert.equal(button("Keep current plan"), undefined, "the next check-in is a week away");
  sqlite.close();
});

test("recent-food lookup uses the history index instead of sorting the full diary", () => {
  const { sqlite } = diaryDatabase();
  const plan = sqlite
    .prepare(
      "EXPLAIN QUERY PLAN SELECT * FROM food_entries ORDER BY created_at DESC, id DESC LIMIT 200"
    )
    .all();
  assert.ok(plan.some((row) => row.detail.includes("USING INDEX food_entries_recent_idx")));
  assert.ok(plan.every((row) => !row.detail.includes("TEMP B-TREE")));
  sqlite.close();
});

test("weight history and check-in ranges use the weight time index", () => {
  const { sqlite } = diaryDatabase();
  for (const query of [
    "SELECT * FROM weight_entries ORDER BY measured_at DESC, id DESC",
    "SELECT * FROM weight_entries WHERE measured_at >= '2024-01-01' AND measured_at <= '2024-02-01'",
  ]) {
    const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all();
    assert.ok(
      plan.some((row) => row.detail.includes("weight_entries_measured_idx")),
      query
    );
    assert.ok(
      plan.every((row) => !row.detail.includes("TEMP B-TREE")),
      query
    );
  }
  sqlite.close();
});

function fastLoggerHarness(storeOverrides = {}) {
  const { diary, sqlite, fastLog } = diaryDatabase();
  diary.saveCustomFood(food);
  const harness = screenHarness(diary, storeOverrides, { "@/lib/fast-log": fastLog });
  const { FastLogger } = harness.load("src/components/nutrition/fast-logger.tsx");
  const state = { closed: 0, receipts: [] };
  const render = (props = {}) =>
    nodes(
      harness.render(FastLogger, {
        initialDay: metrics.localDay(),
        initialTime: "12:10",
        close: () => state.closed++,
        onLogged: (receipt) => state.receipts.push(receipt),
        ...props,
      })
    );
  return { diary, sqlite, fastLog, state, render, context: harness.context };
}

test("compiled fast logger logs a single adjusted portion in one tap and backs out to the list", () => {
  const { diary, sqlite, state, render } = fastLoggerHarness();
  const day = metrics.localDay();
  render()
    .find((node) => node.props.accessibilityLabel === `Adjust ${food.name}`)
    .props.onPress();
  const picker = render().find((node) => node.type === "AmountPicker");
  assert.deepEqual(
    picker.props.value,
    { unit: "portion:0", text: "1", fresh: true },
    "the usual portion, selected so the first key replaces it"
  );
  assert.deepEqual(
    picker.props.units.map((unit) => unit.label),
    ["g", "oz", "serving", "kcal"]
  );
  assert.equal(
    render().find((node) => node.type === "PortionPreview").props.nutrients.calories,
    54
  );
  enterAmount(render(), "90", "g");
  assert.equal(
    render().find((node) => node.type === "PortionPreview").props.nutrients.calories,
    162
  );
  const log = amountAction(render(), "Log");
  log.onPress();
  log.onPress();
  assert.deepEqual(
    diary.entriesForDay(day).map((row) => [row.amount, row.loggedTime]),
    [[90, "12:10"]]
  );
  assert.equal(state.closed, 1);
  assert.equal(state.receipts.length, 1);
  sqlite.close();

  // Backing out of a portion returns to the list rather than closing the logger.
  const other = fastLoggerHarness();
  other
    .render()
    .find((node) => node.props.accessibilityLabel === `Adjust ${food.name}`)
    .props.onPress();
  other
    .render()
    .find((node) => node.type === "Editor")
    .props.close();
  assert.equal(other.state.closed, 0);
  assert.ok(other.render().some((node) => node.type === "SearchInput"));
  other.sqlite.close();
});

test("compiled fast logger logs a scan or new food directly when nothing else is selected", () => {
  const { diary, sqlite, state, render } = fastLoggerHarness();
  render()
    .find((node) => node.props.children === "Scan")
    .props.onPress();
  const picker = render().find((node) => node.type === "FoodEditor");
  assert.equal(picker.props.pickLabel, "Log");
  const scanned = { ...food, id: "off:scan", name: "Scanned food", source: "off" };
  const pick = () => picker.props.onPick(scanned, 50, nutrition.portionItem(scanned, "g", 50));
  pick();
  pick();
  picker.props.close();
  assert.deepEqual(
    diary.entriesForDay(metrics.localDay()).map((row) => [row.food.name, row.amount]),
    [["Scanned food", 50]]
  );
  assert.equal(state.closed, 1, "the editor's own close after a direct log is ignored");
  assert.equal(state.receipts.length, 1);
  sqlite.close();

  // A scan opened from Home that is cancelled goes straight back to Home.
  const home = fastLoggerHarness();
  home
    .render({ start: "barcode" })
    .find((node) => node.type === "FoodEditor")
    .props.close();
  assert.equal(home.state.closed, 1);
  home.sqlite.close();

  // On another day the scan joins the draft so the day is visible before saving.
  const past = fastLoggerHarness();
  const yesterday = nutrition.shiftDay(metrics.localDay(), -1);
  const pastPicker = past
    .render({ start: "barcode", initialDay: yesterday })
    .find((node) => node.type === "FoodEditor");
  assert.equal(pastPicker.props.pickLabel, undefined);
  pastPicker.props.onPick(scanned, 50, nutrition.portionItem(scanned, "g", 50));
  pastPicker.props.close();
  assert.equal(past.diary.entriesForDay(yesterday).length, 0);
  assert.equal(past.state.closed, 0, "the draft stays open");
  const logOne = past
    .render({ start: "barcode", initialDay: yesterday })
    .find((node) => node.type === "Button" && node.props.children === "Log 1 food");
  logOne.props.onPress();
  assert.equal(past.diary.entriesForDay(yesterday).length, 1);
  past.sqlite.close();
});

test("compiled fast logger merges saved meals into usual foods and search, and clears search after adding", () => {
  const { diary, sqlite, state, render, context } = fastLoggerHarness();
  diary.saveEntry({
    day: "2024-01-01",
    meal: "Breakfast",
    loggedTime: "08:00",
    food,
    amount: 60,
    portionLabel: "60 g",
  });
  diary.saveMeal("Oat breakfast", "2024-01-01", "Breakfast");
  const titles = (tree) =>
    tree
      .filter((node) => node.props.accessibilityLabel?.startsWith("Adjust "))
      .map((node) => node.props.accessibilityLabel.slice(7));
  let tree = render();
  assert.ok(!tree.some((node) => node.props.children === "Meals"), "no Foods | Meals toggle");
  assert.deepEqual(titles(tree), ["Oat breakfast", food.name]);
  assert.ok(tree.some((node) => node.type === "Text" && node.props.children === "Meal"));
  // Choices are cached between keystrokes but follow diary writes.
  diary.saveCustomFood({ ...food, id: "custom:later", name: "Later food" });
  assert.ok(!titles(render()).includes("Later food"));
  context.refresh();
  assert.ok(titles(render()).includes("Later food"));
  tree.find((node) => node.type === "SearchInput").props.onChange("oat");
  tree = render();
  assert.equal(titles(tree)[0], "Oat breakfast");
  assert.equal(tree.find((node) => node.type === "SearchInput").props.value, "oat");
  tree.find((node) => node.props.accessibilityLabel === "Add Oat breakfast").props.onPress();
  tree = render();
  assert.equal(tree.find((node) => node.type === "SearchInput").props.value, "");
  tree.find((node) => node.props.children === "Log 1 food").props.onPress();
  assert.equal(diary.entriesForDay(metrics.localDay()).length, 1);
  assert.equal(state.closed, 1);
  sqlite.close();
});

test("compiled fast logger reopens a selected saved meal at its multiple and logs what it shows", () => {
  const { diary, sqlite, render } = fastLoggerHarness();
  diary.saveEntry({
    day: "2024-01-01",
    meal: "Breakfast",
    loggedTime: "08:00",
    food,
    amount: 100,
    portionLabel: "100 g",
  });
  diary.saveMeal("Oats", "2024-01-01", "Breakfast");
  const adjust = () =>
    render()
      .find((node) => node.props.accessibilityLabel === "Adjust Oats")
      .props.onPress();
  const shown = (tree) =>
    tree.some((node) => node.type === "Text" && node.props.children === "3 × saved meal");
  adjust();
  enterAmount(render(), "2");
  amountAction(render(), "Add").onPress();
  adjust();
  assert.deepEqual(render().find((node) => node.type === "AmountPicker").props.value, {
    unit: "meal",
    text: "2",
    fresh: true,
  });
  assert.equal(
    render().find((node) => node.type === "PortionPreview").props.nutrients.calories,
    360
  );
  enterAmount(render(), "3");
  amountAction(render(), "Add").onPress();
  assert.ok(shown(render()));
  render()
    .find((node) => node.props.children === "Log 1 food")
    .props.onPress();
  assert.deepEqual(
    diary.entriesForDay(metrics.localDay()).map((row) => [row.amount, row.nutrients.calories]),
    [[300, 540]]
  );
  sqlite.close();
});

test("compiled fast logger search finds eaten foods by word and names each brand", async () => {
  const { diary, sqlite, fastLog } = diaryDatabase();
  const egg = {
    ...food,
    id: "usda:173424",
    name: "Egg, whole, cooked, hard-boiled",
    source: "usda",
    barcode: null,
  };
  const branded = {
    ...egg,
    id: "off:1",
    name: "Large eggs",
    brand: "Eggland's Best",
    source: "off",
  };
  diary.saveEntry({
    day: nutrition.shiftDay(metrics.localDay(), -1),
    meal: "Breakfast",
    loggedTime: "08:00",
    food: egg,
    amount: 50,
    portionLabel: "1 large · 50 g",
  });
  const searches = [];
  const harness = screenHarness(
    diary,
    {},
    {
      "@/lib/fast-log": fastLog,
      "@/lib/food-catalog": {
        searchFoods: async (query, known) => {
          searches.push({ query, known });
          return [egg, branded];
        },
      },
    }
  );
  const { FastLogger } = harness.load("src/components/nutrition/fast-logger.tsx");
  const render = () =>
    nodes(
      harness.render(FastLogger, {
        initialDay: metrics.localDay(),
        initialTime: "08:10",
        close: () => {},
        onLogged: () => {},
      })
    );
  const titles = (tree) =>
    tree
      .filter((node) => node.props.accessibilityLabel?.startsWith("Adjust "))
      .map((node) => node.props.accessibilityLabel.slice(7));
  const texts = (tree) =>
    tree.filter((node) => node.type === "Text").map((node) => node.props.children);
  let tree = render();
  assert.ok(
    texts(tree).includes("1 large · 50 g"),
    "a familiar food without a brand shows its portion"
  );
  tree.find((node) => node.type === "SearchInput").props.onChange("eggs");
  tree = render();
  // A plural finds the food before the catalog answers; a substring match missed it.
  assert.deepEqual(titles(tree), [egg.name]);
  harness.effects.forEach((effect) => effect());
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(searches.length, 1);
  assert.equal(searches[0].query, "eggs");
  assert.ok(
    searches[0].known.get(egg.id) > 0.9,
    "search boosts foods eaten recently around this time"
  );
  tree = render();
  assert.deepEqual(titles(tree), [egg.name, branded.name], "the eaten food is listed once, first");
  assert.ok(texts(tree).includes("USDA · 1 large · 50 g"));
  assert.ok(texts(tree).includes("Eggland's Best · 1 serving · 30 g"));
  // VoiceOver hears the brand, portion and macros that tell same-named results apart.
  const labelled = (label) => tree.find((node) => node.props.accessibilityLabel === label);
  assert.match(
    labelled(`Adjust ${egg.name}`).props.accessibilityValue.text,
    /^USDA, 1 large · 50 g, [\d.]+ kcal, [\d.]+ g protein, [\d.]+ g fat, [\d.]+ g carbs$/
  );
  assert.match(
    labelled(`Adjust ${branded.name}`).props.accessibilityValue.text,
    /^Eggland's Best, 1 serving · 30 g, [\d.]+ kcal, /
  );
  assert.deepEqual(labelled(`Add ${branded.name}`).props.accessibilityValue, {
    text: "Eggland's Best",
  });
  tree.find((node) => node.props.accessibilityLabel === `Adjust ${branded.name}`).props.onPress();
  assert.ok(texts(render()).includes("Eggland's Best"), "the portion screen names the brand");
  sqlite.close();
});

test("compiled food search lists the person's matching foods first, then the catalog", async () => {
  const { diary, sqlite } = diaryDatabase();
  const egg = {
    ...food,
    id: "usda:173424",
    name: "Egg, whole, cooked, hard-boiled",
    source: "usda",
  };
  const branded = {
    ...egg,
    id: "off:1",
    name: "Large eggs",
    brand: "Eggland's Best",
    source: "off",
  };
  diary.saveEntry({
    day: "2024-01-01",
    meal: "Breakfast",
    food: egg,
    amount: 50,
    portionLabel: "50 g",
  });
  diary.saveCustomFood(food);
  diary.saveCustomFood({ ...food, id: "custom:eggnog", name: "Eggnog" });
  const harness = screenHarness(
    diary,
    {},
    {
      "@/lib/food-catalog": { searchFoods: async () => [branded, egg] },
    }
  );
  const { FoodEditor } = harness.load("src/components/nutrition/food-editor.tsx");
  const render = () => nodes(harness.render(FoodEditor, { close: () => {}, initialQuery: "eggs" }));
  render();
  harness.effects.forEach((effect) => effect());
  await new Promise((resolve) => setTimeout(resolve, 250));
  const rows = render().filter((node) => node.props.food && node.props.onPress);
  assert.deepEqual(
    rows.map((node) => node.props.food.name),
    [egg.name, "Eggnog", branded.name],
    "own foods by match, the eaten egg before a longer word, then the catalog"
  );
  sqlite.close();
});

test("compiled fast logger quick add logs straight away or joins the selected foods", () => {
  const { sqlite, state, render } = fastLoggerHarness();
  render()
    .find((node) => node.props.children === "Quick add")
    .props.onPress();
  let quick = render().find((node) => node.type === "QuickAdd");
  assert.equal(quick.props.onAdd, undefined, "an empty meal logs the estimate directly");
  const receipt = { day: metrics.localDay(), entries: [] };
  quick.props.close();
  quick.props.onLogged(receipt);
  assert.equal(state.closed, 1);
  assert.deepEqual(state.receipts, [receipt]);
  sqlite.close();

  const draft = fastLoggerHarness();
  draft
    .render()
    .find((node) => node.props.accessibilityLabel === `Add ${food.name}`)
    .props.onPress();
  draft
    .render()
    .find((node) => node.props.children === "Quick add")
    .props.onPress();
  quick = draft.render().find((node) => node.type === "QuickAdd");
  assert.equal(quick.props.onLogged, undefined);
  const estimate = { ...food, id: "quick:test", name: "Quick add", basis: "serving", portions: [] };
  quick.props.onAdd({
    food: estimate,
    amount: 1,
    portionLabel: "1 estimated entry",
    nutrients: nutrition.scaleNutrients(estimate, 1),
  });
  quick.props.close();
  draft
    .render()
    .find((node) => node.props.children === "Log 2 foods")
    .props.onPress();
  assert.deepEqual(
    draft.diary
      .entriesForDay(metrics.localDay())
      .map((row) => row.food.name)
      .sort(),
    ["Quick add", food.name]
  );
  assert.equal(draft.state.closed, 1);
  draft.sqlite.close();
});

test("compiled fast logger offers photo logging only where it runs, then logs or joins the meal", () => {
  const plain = fastLoggerHarness();
  assert.ok(!plain.render().some((node) => node.props.children === "Photo"));
  plain.sqlite.close();

  const { sqlite, state, render } = fastLoggerHarness();
  const offered = { photoLogging: true };
  render(offered)
    .find((node) => node.props.children === "Photo")
    .props.onPress();
  let photo = render(offered).find((node) => node.type === "PhotoLogger");
  assert.equal(photo.props.onAdd, undefined, "an empty meal logs the photo's foods directly");
  assert.equal(photo.props.initialTime, "12:10");
  const receipt = { day: metrics.localDay(), entries: [] };
  photo.props.onLogged(receipt);
  assert.equal(state.closed, 1);
  assert.deepEqual(state.receipts, [receipt]);
  sqlite.close();

  const draft = fastLoggerHarness();
  draft
    .render(offered)
    .find((node) => node.props.accessibilityLabel === `Add ${food.name}`)
    .props.onPress();
  draft
    .render(offered)
    .find((node) => node.props.children === "Photo")
    .props.onPress();
  photo = draft.render(offered).find((node) => node.type === "PhotoLogger");
  assert.equal(photo.props.onLogged, undefined, "with foods selected, the photo's foods join them");
  const lettuce = { ...food, id: "usda:lettuce", name: "Lettuce, iceberg, raw", barcode: null };
  const tomato = { ...food, id: "usda:tomato", name: "Tomatoes, red, ripe, raw", barcode: null };
  photo.props.onAdd(
    [
      [lettuce, 15, "≈ 1 leaf · 15 g"],
      [tomato, 30, "≈ 2 slices · 30 g"],
    ].map(([item, amount, portionLabel]) => ({
      food: item,
      amount,
      portionLabel,
      nutrients: nutrition.scaleNutrients(item, amount),
    }))
  );
  photo.props.close();
  draft
    .render(offered)
    .find((node) => node.props.children === "Log 3 foods")
    .props.onPress();
  assert.deepEqual(
    draft.diary
      .entriesForDay(metrics.localDay())
      .map((row) => [row.food.name, row.portionLabel])
      .sort(),
    [
      [food.name, "1 serving · 30 g"],
      [lettuce.name, "≈ 1 leaf · 15 g"],
      [tomato.name, "≈ 2 slices · 30 g"],
    ].sort()
  );
  assert.equal(draft.state.closed, 1);
  draft.sqlite.close();
});

// PhotoLogger against the real meal analysis and diary; each model request waits for the test.
function photoLoggerHarness(status = {}) {
  const { diary, sqlite, fastLog } = diaryDatabase();
  const produce = (id, name, grams) => ({
    ...food,
    id,
    name,
    barcode: null,
    source: "usda",
    portions: [{ label: "1 medium", amount: grams }],
  });
  const banana = produce("usda:banana", "Bananas, raw", 118);
  const apple = produce("usda:apple", "Apples, raw, with skin", 182);
  const requests = [];
  const reply = (name) => ({
    items: [{ brand: "", name, quantity: 1, unit: "piece", grams: 120 }],
  });
  const harness = screenHarness(
    diary,
    {},
    {
      "react-native": {
        View: "View",
        Image: "Image",
        ActivityIndicator: "ActivityIndicator",
        Platform: { OS: "ios" },
      },
      "@/lib/local-ai": {
        modelStatus: async () => ({ state: "available", engine: "apple", vision: true, ...status }),
        prewarmModel: () => {},
        downloadModel: async () => {},
        errorCode: () => "",
        generateJson: (request) =>
          new Promise((resolve, reject) =>
            requests.push({
              request,
              answer: (name) => resolve(reply(name)),
              nothing: () => resolve({ items: [] }),
              fail: reject,
            })
          ),
      },
      "@/lib/meal-ai": load("src/lib/meal-ai.ts", {
        "./nutrition": nutrition,
        "./food-rank": rank,
      }),
      "@/lib/fast-log": fastLog,
      "@/lib/food-catalog": { searchCatalogMatch: async () => [banana, apple] },
    }
  );
  const { PhotoLogger } = harness.load("src/components/nutrition/photo-logger.tsx");
  const state = { closed: 0 };
  const render = () =>
    nodes(
      harness.render(PhotoLogger, {
        initialDay: metrics.localDay(),
        initialTime: "12:30",
        close: () => state.closed++,
      })
    );
  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  const drafted = () =>
    render()
      .filter((node) => node.props.accessibilityLabel?.startsWith("Adjust "))
      .map((node) => node.props.accessibilityLabel.slice(7));
  const field = () => render().find((node) => node.type === "Field");
  const updateButton = () =>
    render().find((node) => node.props.children === "Update with description");
  return { diary, sqlite, harness, requests, render, settle, drafted, field, updateButton, state };
}

test("compiled photo logger analyzes a photo at once and re-runs it for an edited description", async () => {
  const photo = photoLoggerHarness();
  const { requests, harness, render, settle, drafted, field, updateButton } = photo;
  render();
  harness.effects.forEach((effect) => effect());
  await settle();
  assert.equal(field().props.onSubmit, undefined, "return keeps its meaning next to the camera");
  render()
    .find((node) => node.type === "PhotoCapture")
    .props.onPhoto("file:///cache/meal.jpg");
  assert.equal(requests.length, 1, "the shutter starts the analysis; there is no Find foods tap");
  assert.equal(requests[0].request.imageUri, "file:///cache/meal.jpg");
  for (let i = 0; i < 3; i++) {
    render();
    harness.effects.forEach((effect) => effect());
  }
  await settle();
  assert.equal(requests.length, 1, "one photo is one analysis");
  assert.equal(updateButton(), undefined);

  // The description stays editable while the model looks at the photo.
  field().props.onChange("banana from the market");
  updateButton().props.onPress();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].request.imageUri, "file:///cache/meal.jpg");
  assert.match(requests[1].request.prompt, /banana from the market/);
  assert.equal(updateButton(), undefined, "the running analysis has this description");
  // The superseded run answers first and is dropped; the screen waits for the newer one.
  requests[0].answer("Apple");
  await settle();
  assert.deepEqual(drafted(), []);
  assert.ok(render().some((node) => node.props.children === "Cancel"));
  requests[1].answer("Banana");
  await settle();
  assert.deepEqual(drafted(), ["Bananas, raw"]);
  assert.equal(requests.length, 2, "a clear match needs no second request");

  // After the draft, an edited description re-runs the analysis from the review.
  field().props.onChange("an apple, not a banana");
  updateButton().props.onPress();
  assert.equal(requests.length, 3);
  requests[2].answer("Apple");
  await settle();
  assert.deepEqual(drafted(), ["Apples, raw, with skin"]);
  assert.equal(updateButton(), undefined);
  render()
    .find((node) => node.props.children === "Log 1 food")
    .props.onPress();
  assert.deepEqual(
    photo.diary.entriesForDay(metrics.localDay()).map((entry) => entry.food.name),
    ["Apples, raw, with skin"]
  );
  assert.equal(photo.state.closed, 1);
  photo.sqlite.close();
});

test("compiled describe-only logger finds foods on return and re-runs an edited description", async () => {
  const photo = photoLoggerHarness({ vision: false });
  const { requests, harness, render, settle, drafted, field, updateButton } = photo;
  render();
  harness.effects.forEach((effect) => effect());
  await settle();
  assert.equal(field().props.label, "What did you eat?");
  field().props.onSubmit();
  assert.equal(requests.length, 0, "return on an empty description does nothing");
  field().props.onChange("a banana");
  field().props.onSubmit();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].request.imageUri, undefined);
  requests[0].answer("Banana");
  await settle();
  assert.deepEqual(drafted(), ["Bananas, raw"]);
  field().props.onSubmit();
  assert.equal(requests.length, 1, "an unchanged description is not analyzed again");
  field().props.onChange("an apple");
  assert.ok(updateButton());
  field().props.onSubmit();
  assert.equal(requests.length, 2);
  assert.match(requests[1].request.prompt, /an apple/);
  requests[1].answer("Apple");
  await settle();
  assert.deepEqual(drafted(), ["Apples, raw, with skin"]);
  photo.sqlite.close();
});

test("compiled photo logger keeps the reviewed draft when a re-run finds nothing, fails or is cancelled", async () => {
  const photo = photoLoggerHarness();
  const { requests, harness, render, settle, drafted, field, updateButton } = photo;
  render();
  harness.effects.forEach((effect) => effect());
  await settle();
  render()
    .find((node) => node.type === "PhotoCapture")
    .props.onPhoto("file:///cache/meal.jpg");
  requests[0].answer("Banana");
  await settle();
  assert.deepEqual(drafted(), ["Bananas, raw"]);
  // The person corrects the amount before noticing the description could say more.
  render()
    .find((node) => node.props.accessibilityLabel === "Adjust Bananas, raw")
    .props.onPress();
  assert.deepEqual(
    render().find((node) => node.type === "AmountPicker").props.value,
    { unit: "portion:0", text: "1", fresh: true },
    "the photo's one medium banana"
  );
  enterAmount(render(), "200", "g");
  amountAction(render(), "Use").onPress();
  const portion = () =>
    render().some(
      (node) => typeof node.props.children === "string" && /^200 g · /.test(node.props.children)
    );
  const kept = (why) => {
    assert.deepEqual(drafted(), ["Bananas, raw"], why);
    assert.ok(portion(), `${why}: the adjusted amount stays`);
    assert.ok(
      render().some(
        (node) => node.type === "Image" && node.props.source.uri === "file:///cache/meal.jpg"
      )
    );
    assert.equal(
      render().find((node) => node.type === "PhotoCapture"),
      undefined
    );
    assert.ok(updateButton(), `${why}: the edited description can still be tried`);
  };
  const error = () => render().find((node) => node.type === "Error")?.props.message ?? "";

  field().props.onChange("and some pie");
  updateButton().props.onPress();
  assert.deepEqual(drafted(), [], "the re-run is analyzing");
  requests[1].nothing();
  await settle();
  kept("an empty re-run");
  assert.equal(error(), "No food found with that description.");

  updateButton().props.onPress();
  assert.equal(error(), "");
  requests[2].fail(new Error("The on-device model is busy. Try again."));
  await settle();
  kept("a failed re-run");
  assert.equal(error(), "The on-device model is busy. Try again.");

  updateButton().props.onPress();
  render()
    .find((node) => node.props.children === "Cancel")
    .props.onPress();
  kept("a cancelled re-run");
  assert.equal(error(), "");
  requests[3].answer("Apple");
  await settle();
  kept("the cancelled run's late answer");
  assert.equal(requests.length, 4);

  render()
    .find((node) => node.props.children === "Log 1 food")
    .props.onPress();
  assert.deepEqual(
    photo.diary.entriesForDay(metrics.localDay()).map((entry) => [entry.food.name, entry.amount]),
    [["Bananas, raw", 200]]
  );
  photo.sqlite.close();
});

test("compiled Home prewarms the on-device model once available, then at most every 10 minutes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: new Date(2024, 0, 10, 12, 0, 10) });
  const { diary, sqlite } = diaryDatabase();
  let status = { state: "unavailable", engine: "none", vision: false, reason: "disabled" };
  let prewarms = 0,
    reads = 0;
  const listeners = [];
  const harness = screenHarness(
    diary,
    {},
    {
      "@/lib/food-catalog": { openCatalogs: async () => {} },
      "@/lib/local-ai": {
        modelStatus: async () => {
          reads++;
          return { ...status };
        },
        prewarmModel: () => prewarms++,
      },
      "react-native": {
        View: "View",
        Platform: { OS: "ios" },
        AccessibilityInfo: { announceForAccessibility: () => {} },
        AppState: {
          addEventListener: (_, listener) => {
            listeners.push(listener);
            return { remove: () => {} };
          },
        },
      },
    }
  );
  const { TodayScreen } = harness.load("src/components/nutrition/today-screen.tsx");
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  // The mount effect runs once; the others after every render, as often as React may run them.
  const render = () => {
    const tree = nodes(harness.render(TodayScreen));
    harness.effects.slice(1).forEach((effect) => effect());
    return tree;
  };
  const returnToApp = async () => {
    listeners.forEach((listener) => listener("active"));
    await settle();
    render();
  };
  render();
  const stop = harness.effects[0]();
  t.mock.timers.tick(300);
  await settle();
  render();
  assert.equal(reads, 1);
  assert.equal(prewarms, 0, "a model that can't run isn't loaded");

  status = { state: "available", engine: "apple", vision: true };
  await returnToApp();
  render();
  assert.equal(prewarms, 1, "prewarmed once when it became available");
  t.mock.timers.tick(5 * 60000);
  await returnToApp();
  assert.equal(prewarms, 1, "returning soon after doesn't load it again");
  t.mock.timers.tick(6 * 60000);
  await returnToApp();
  assert.equal(prewarms, 2);
  stop();
  sqlite.close();
});

test("compiled quick add hands an estimate to a meal draft without writing the diary", () => {
  const { diary, sqlite } = diaryDatabase();
  const harness = screenHarness(diary);
  const { QuickAdd } = harness.load("src/components/nutrition/quick-add.tsx");
  let closed = 0;
  const added = [];
  const render = () =>
    nodes(
      harness.render(QuickAdd, {
        day: "2024-01-01",
        close: () => closed++,
        onAdd: (item) => added.push(item),
      })
    );
  const tree = render();
  assert.equal(tree.find((node) => node.props.label === "Calories (kcal)").props.autoFocus, true);
  assert.ok(!tree.some((node) => node.type === "TimeField"), "the draft owns the time");
  tree.find((node) => node.props.label === "Calories (kcal)").props.onChange("300");
  const button = render().find(
    (node) => node.type === "Button" && node.props.children === "Add to meal"
  );
  button.props.onPress();
  button.props.onPress();
  assert.equal(closed, 1);
  assert.equal(added.length, 1);
  assert.equal(added[0].nutrients.calories, 300);
  assert.equal(added[0].nutrients.protein, 0);
  assert.equal(added[0].nutrients.fiber, null);
  assert.equal(diary.entriesForDay("2024-01-01").length, 0);
  sqlite.close();
});

test("day projection counts eaten food once and lets planned food replace the usual rest of day", () => {
  const entry = (loggedTime, calories) => ({ loggedTime, calories });
  assert.deepEqual(
    nutrition.projectDay({ entries: [], target: null, typical: 500, now: "12:00" }),
    {
      status: "no-target",
      eaten: 0,
    }
  );
  const breakfast = [entry("08:00", 500)];
  assert.equal(
    nutrition.projectDay({ entries: breakfast, target: 2000, typical: null, now: "12:00" }).status,
    "under",
    "no projection without history"
  );
  assert.equal(
    nutrition.projectDay({ entries: [], target: 2000, typical: 1500, now: "07:00" }).status,
    "under",
    "no projection before the first entry"
  );
  const onPace = nutrition.projectDay({
    entries: breakfast,
    target: 2000,
    typical: 1400,
    now: "12:00",
  });
  assert.deepEqual([onPace.status, onPace.projected, onPace.left], ["on-pace", 1900, 1500]);
  // Within max(100 kcal, 5%) of target still reads as on pace.
  assert.equal(
    nutrition.projectDay({ entries: breakfast, target: 2000, typical: 1600, now: "12:00" }).status,
    "on-pace"
  );
  const heading = nutrition.projectDay({
    entries: breakfast,
    target: 2000,
    typical: 1700,
    now: "12:00",
  });
  assert.deepEqual([heading.status, heading.projected], ["heading-over", 2200]);
  // Dinner already logged for later tonight replaces, rather than adds to, the usual evening.
  const planned = nutrition.projectDay({
    entries: [...breakfast, entry("19:00", 900)],
    target: 2000,
    typical: 700,
    now: "12:00",
  });
  assert.equal(planned.projected, 1400);
  assert.deepEqual(
    nutrition.projectDay({
      entries: [entry("08:00", 2100)],
      target: 2000,
      typical: 0,
      now: "20:00",
    }),
    { status: "over", eaten: 2100, target: 2000, over: 100 }
  );
  assert.equal(nutrition.roughly(149), 150);
  assert.equal(nutrition.roughly(10), 50);
});

test("pace history starts an hour after the last meal eaten, ignoring food planned for later", () => {
  assert.equal(foodTime.paceCutoff([], "12:00"), "12:00");
  assert.equal(foodTime.paceCutoff([{ loggedTime: "11:40" }], "12:00"), "12:40");
  assert.equal(foodTime.paceCutoff([{ loggedTime: "08:00" }], "12:00"), "12:00");
  assert.equal(
    foodTime.paceCutoff(
      [{ loggedTime: "11:30" }, { loggedTime: "19:00" }, { loggedTime: null }],
      "12:00"
    ),
    "12:30"
  );
  assert.equal(foodTime.paceCutoff([{ loggedTime: "23:30" }], "23:45"), "24:00");
  assert.equal(foodTime.clockPlus("22:30", 120), "24:00");
  assert.equal(foodTime.clockPlus("09:05", 60), "10:05");
});

test("typical rest-of-day uses the median of complete, real-time days only", () => {
  const { diary, sqlite, db } = diaryDatabase();
  const today = "2024-03-20";
  const add = (
    day,
    loggedTime,
    calories,
    createdAt = new Date(`${day}T${loggedTime ?? "12:00"}:00`).getTime()
  ) =>
    db
      .insert(schema.foodEntries)
      .values({
        day,
        meal: "Lunch",
        loggedTime,
        food,
        amount: 1,
        portionLabel: "1",
        nutrients: { ...food.nutrients, calories },
        createdAt,
      })
      .run();
  const status = (day, value) =>
    db
      .insert(schema.diaryDays)
      .values({ day, status: value })
      .onConflictDoUpdate({ target: schema.diaryDays.day, set: { status: value } })
      .run();
  // Three usable days with 600, 800 and 1000 kcal after 13:00.
  for (const [day, after] of [
    ["2024-03-19", 600],
    ["2024-03-18", 800],
    ["2024-03-17", 1000],
  ]) {
    add(day, "08:00", 400);
    add(day, "18:30", after);
    status(day, "complete");
  }
  // One read serves every cutoff, as Home's minute clock moves it.
  const days = diary.typicalDays(today);
  assert.equal(days.length, 3);
  assert.equal(diary.typicalAfter(days, "13:00"), 800);
  assert.equal(diary.typicalAfter(days, "19:00"), 0);
  // Back-filled the next day, untimed, partial and today's own entries are ignored.
  add("2024-03-16", "19:00", 5000, new Date("2024-03-17T09:00:00").getTime());
  status("2024-03-16", "complete");
  add("2024-03-15", null, 5000);
  status("2024-03-15", "complete");
  add("2024-03-14", "19:00", 5000);
  status("2024-03-14", "partial");
  add(today, "20:00", 5000);
  status(today, "complete");
  assert.equal(diary.typicalDays(today).length, 3);
  assert.equal(diary.typicalAfter(diary.typicalDays(today), "13:00"), 800);
  // Fewer than three usable days means no estimate.
  assert.equal(diary.typicalDays("2024-03-19").length, 2);
  assert.equal(diary.typicalAfter(diary.typicalDays("2024-03-19"), "13:00"), null);
  sqlite.close();
});

test("the confirm card asks about the latest unanswered day with food and targets", () => {
  const { diary, sqlite } = diaryDatabase();
  const today = metrics.localDay();
  const ago = (n) => nutrition.shiftDay(today, -n);
  const log = (day) =>
    diary.saveEntry({ day, meal: "Lunch", food, amount: 100, portionLabel: "100 g" });
  log(ago(2));
  assert.equal(diary.dayToConfirm(today), null, "no targets, nothing to learn from");
  diary.saveTargets(ago(10), { calories: 2000, protein: 100, carbs: 250, fat: 60 });
  assert.deepEqual(diary.dayToConfirm(today), { day: ago(2), calories: 180 });
  log(ago(1));
  assert.equal(diary.dayToConfirm(today).day, ago(1));
  diary.setDayStatus(ago(1), "complete");
  assert.equal(diary.dayToConfirm(today).day, ago(2));
  diary.setDayStatus(ago(2), "partial");
  assert.equal(diary.dayToConfirm(today), null);
  log(today);
  log(ago(9));
  assert.equal(diary.dayToConfirm(today), null, "today and days older than a week are not asked");
  sqlite.close();
});

test("morning weigh-in shows until noon unless weighed, skipped or synced, and guards typos", () => {
  const { sqlite, db } = diaryDatabase();
  const weighIn = load("src/lib/weigh-in.ts", {
    "@/db": { db, ...schema },
    "./metrics": metrics,
    "./nutrition": nutrition,
  });
  const today = "2024-05-02";
  const at = (day, time = "06:30") => ({ measuredAt: new Date(`${day}T${time}:00`).toISOString() });
  const state = { weights: [at("2024-04-29")], weightsSynced: false, weighInSkippedDay: "" };
  assert.equal(weighIn.weighInDue(state, today, 7, false), true, "weighed recently");
  assert.equal(weighIn.weighInDue({ ...state, weights: [] }, today, 7, true), true, "coached");
  assert.equal(
    weighIn.weighInDue({ ...state, weights: [at("2024-04-01")] }, today, 7, false),
    false,
    "people who don't weigh in aren't asked every morning"
  );
  assert.equal(weighIn.weighInDue(state, today, 12, true), false);
  assert.equal(weighIn.weighInDue(state, today, 0, true), false, "not before 04:00");
  assert.equal(weighIn.weighInDue({ ...state, weightsSynced: true }, today, 7, true), false);
  assert.equal(weighIn.weighInDue({ ...state, weighInSkippedDay: today }, today, 7, true), false);
  assert.equal(
    weighIn.weighInDue({ ...state, weights: [at(today)] }, today, 7, true),
    false,
    "already weighed today"
  );
  assert.equal(weighIn.parseWeight("180", "imperial"), 81.6466);
  assert.equal(weighIn.parseWeight("81,5", "metric"), 81.5);
  assert.throws(() => weighIn.parseWeight("1,824", "metric"), /valid weight/);
  assert.throws(() => weighIn.parseWeight("", "metric"));
  const last = { weightKg: 80, measuredAt: "2024-05-01T06:00:00.000Z" };
  assert.equal(weighIn.unusualWeight(80.4, last, "2024-04-18"), false);
  assert.equal(weighIn.unusualWeight(88, last, "2024-04-18"), true);
  assert.equal(weighIn.unusualWeight(88, last, "2024-05-02"), false, "old weights don't block");
  const saved = weighIn.logWeight(81.2);
  assert.equal(db.select().from(schema.weightEntries).all().length, 1);
  db.update(schema.weightEntries).set({ weightKg: 81.3 }).run();
  assert.throws(() => weighIn.undoWeight(saved), /changed/);
  db.update(schema.weightEntries).set({ weightKg: 81.2 }).run();
  weighIn.undoWeight(saved);
  assert.equal(db.select().from(schema.weightEntries).all().length, 0);
  sqlite.close();
});

test("logger choices skip quick-add estimates and rank foods and saved meals by time of day", () => {
  const { diary, sqlite, fastLog } = diaryDatabase();
  const other = { ...food, id: "custom:other", name: "Other food" };
  diary.saveEntry({
    day: "2024-01-01",
    meal: "Breakfast",
    food,
    amount: 75,
    portionLabel: "75 g",
    loggedTime: "08:00",
  });
  diary.saveEntry({
    day: "2024-01-01",
    meal: "Dinner",
    food: other,
    amount: 50,
    portionLabel: "50 g",
    loggedTime: "19:00",
  });
  const quick = {
    ...food,
    id: "quick:1",
    name: "Quick add",
    source: "custom",
    sourceVersion: "quick-1",
  };
  diary.saveEntry({
    day: "2024-01-01",
    meal: "Lunch",
    food: quick,
    amount: 1,
    portionLabel: "1",
    loggedTime: "12:00",
  });
  const titles = (time) => fastLog.loggingChoices(time).choices.map((choice) => choice.title);
  const meals = (time) => fastLog.loggingChoices(time).meals.map((choice) => choice.title);
  assert.ok(!titles("12:00").includes("Quick add"));
  assert.deepEqual(titles("08:30").slice(0, 2), ["Test food", "Other food"]);
  assert.deepEqual(titles("19:30").slice(0, 2), ["Other food", "Test food"]);
  diary.saveMeal("Breakfast plate", "2024-01-01", "Breakfast", "08");
  diary.saveMeal("Dinner plate", "2024-01-01", "Dinner", "19");
  assert.deepEqual(meals("19:30"), ["Dinner plate", "Breakfast plate"]);
  assert.deepEqual(meals("08:30"), ["Breakfast plate", "Dinner plate"]);
  sqlite.close();
});

test("compiled Home shows one task at a time and logs to the day on screen", async (t) => {
  // Home asks about yesterday only after 04:00, so pin the clock to 09:00 on the real date.
  const real = new Date();
  t.mock.timers.enable({
    apis: ["Date"],
    now: new Date(real.getFullYear(), real.getMonth(), real.getDate(), 9, 0, 0),
  });
  const { diary, sqlite, fastLog, db } = diaryDatabase();
  const today = metrics.localDay();
  const yesterday = nutrition.shiftDay(today, -1);
  db.insert(schema.coachingGoals)
    .values({ mode: "lose", pace: 0.5, startedDay: nutrition.shiftDay(today, -30) })
    .run();
  diary.saveTargets(nutrition.shiftDay(today, -10), {
    calories: 2000,
    protein: 100,
    carbs: 250,
    fat: 60,
  });
  diary.saveEntry({
    day: yesterday,
    meal: "Lunch",
    food,
    amount: 100,
    portionLabel: "100 g",
    loggedTime: "12:00",
  });
  let due = true;
  const harness = screenHarness(
    diary,
    { diaryLayout: "timeline" },
    {
      "@/lib/fast-log": fastLog,
      "@/lib/weigh-in": { weighInDue: () => due, undoWeight: () => {} },
      // Past 04:00, when Home starts asking about yesterday, whatever the real time.
      "@/lib/food-time": { ...foodTime, currentFoodTime: () => "09:00" },
    }
  );
  const { TodayScreen } = harness.load("src/components/nutrition/today-screen.tsx");
  const render = () => nodes(harness.render(TodayScreen));
  let tree = render();
  assert.ok(tree.some((node) => node.type === "WeighInCard"));
  assert.ok(!tree.some((node) => node.type === "HomeCheckIn"));
  assert.ok(!tree.some((node) => node.props.children === "Yes, complete"));
  due = false;
  tree = render();
  const yes = tree.find((node) => node.props.children === "Yes, complete");
  assert.ok(yes, "confirming yesterday comes before the check-in");
  assert.ok(!tree.some((node) => node.type === "HomeCheckIn"));
  yes.props.onPress();
  yes.props.onPress();
  assert.equal(diary.dayStatus(yesterday), "complete");
  harness.context.refresh();
  tree = render();
  assert.ok(tree.some((node) => node.props.children === "Yesterday marked complete."));
  tree.find((node) => node.props.children === "Undo").props.onPress();
  assert.equal(diary.dayStatus(yesterday), "in-progress");
  // A day that reopens later (a forgotten snack) can be answered again.
  // Real time for the press lock, mocked time for the entries written after it.
  await new Promise((resolve) => setTimeout(resolve, 950));
  t.mock.timers.tick(950);
  harness.context.refresh();
  render()
    .find((node) => node.props.children === "Yes, complete")
    .props.onPress();
  assert.equal(diary.dayStatus(yesterday), "complete");
  diary.saveEntry({
    day: yesterday,
    meal: "Snacks",
    food,
    amount: 10,
    portionLabel: "10 g",
    loggedTime: "21:00",
  });
  // Real time for the press lock, mocked time for the entries written after it.
  await new Promise((resolve) => setTimeout(resolve, 950));
  t.mock.timers.tick(950);
  harness.context.refresh();
  render()
    .find((node) => node.props.children === "Yes, complete")
    .props.onPress();
  assert.equal(diary.dayStatus(yesterday), "complete");
  harness.context.refresh();
  tree = render();
  assert.ok(tree.some((node) => node.type === "HomeCheckIn"));
  const bar = (tree) => tree.find((node) => node.type === "QuickLogBar").props;
  assert.equal(bar(tree).label, undefined);
  tree.find((node) => node.type === "WeekStrip").props.onChange(yesterday);
  tree = render();
  assert.ok(!tree.some((node) => node.type === "HomeCheckIn"));
  assert.ok(tree.some((node) => node.props.accessibilityLabel === "Edit Test food"));
  assert.equal(bar(tree).label, "Log to Yesterday");
  bar(tree).onAction("search");
  assert.equal(render().find((node) => node.type === "FastLogger").props.initialDay, yesterday);
  sqlite.close();
});
