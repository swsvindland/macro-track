const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, readdirSync } = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
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
  barcode: null,
  source: "custom",
  sourceVersion: "1",
  basis: "g",
  nutrients: { calories: 180, protein: 10, carbs: 20, fat: 6, fiber: null, sodium: 125 },
  portions: [{ label: "1 serving", amount: 30 }],
};

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
  const fastLog = load("src/lib/fast-log.ts", {
    "@/db": { db, ...schema },
    "./diary": diary,
    "./nutrition": nutrition,
    "./metrics": metrics,
    "./food-time": foodTime,
  });
  return { sqlite, db, diary, fastLog };
}

// The production catalog module over the bundled databases, read-only.
function bundledCatalog() {
  const manifest = JSON.parse(readFileSync("assets/food/manifest.json", "utf8"));
  const files = {
    [`${manifest.usda.version}.db`]: "assets/food/usda.db",
    [`${manifest.off.version}.db`]: "assets/food/off.db",
  };
  const opened = [];
  const catalog = load("src/lib/food-catalog.ts", {
    "../../assets/food/usda.db": "usda.db",
    "../../assets/food/off.db": "off.db",
    "./nutrition": nutrition,
    "expo-sqlite": {
      importDatabaseFromAssetAsync: async () => {},
      async openDatabaseAsync(filename) {
        const database = new DatabaseSync(files[filename], { readOnly: true });
        opened.push(database);
        return {
          getFirstAsync: async (sql, ...params) => database.prepare(sql).get(...params) ?? null,
          getAllAsync: async (sql, ...params) => database.prepare(sql).all(...params),
          execAsync: async (sql) => database.exec(sql),
          closeAsync: async () => database.close(),
        };
      },
    },
  });
  return { catalog, close: () => opened.forEach((database) => database.close()) };
}

// Runs the compiler output with persistent hook slots; native views are plain element types.
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
    "react-native": {
      View: "View",
      ActivityIndicator: "ActivityIndicator",
      AppState: {},
      Alert: { alert: () => {} },
      Linking: { openSettings: async () => {} },
    },
    "heroui-native": {
      TextField: "TextField",
      Input: "Input",
      Label: "Label",
      FieldError: "FieldError",
    },
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
    },
    "@/lib/diary": diary,
    "@/lib/metrics": metrics,
    "./metrics": metrics,
    "@/lib/nutrition": nutrition,
    "@/lib/food-time": foodTime,
    "@/lib/food-catalog": { lookupBarcode: async () => null, searchCatalog: async () => [] },
    "@/lib/local-ai": { textRecognitionAvailable: () => false, recognizeText: async () => [] },
    "@/lib/nutrition-label": {},
    "./photo-capture": { PhotoCapture: "PhotoCapture", discardPhoto: () => {} },
    "./time-field": { TimeField: "TimeField" },
    "expo-camera": {
      CameraView: "CameraView",
      useCameraPermissions: () => [{ granted: true }, async () => {}],
    },
    ...extraDependencies,
  };
  const store = { diaryLayout: "meals", number: (n) => String(n), date: (day) => day };
  Object.assign(store, storeOverrides);
  dependencies["@/lib/store"] = dependencies["./store"] = { useStore: () => store };
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
  return [tree, ...nodes(tree.props?.children), ...nodes(tree.props?.footer)];
}
const button = (tree, label) =>
  tree.find((node) => node.type === "Button" && node.props.children === label);

test("typed times read as HH:mm in 24-hour, compact and am/pm forms", () => {
  const cases = {
    930: "09:30",
    "9:30": "09:30",
    "09:30": "09:30",
    "9.30pm": "21:30",
    "9:30 PM": "21:30",
    "9:30 p.m.": "21:30",
    "9:30\u202fPM": "21:30", // formatClock output
    "9pm": "21:00",
    "12am": "00:00",
    "12:15 pm": "12:15",
    "21:30": "21:30",
    2130: "21:30",
    " 7 ": "07:00",
    "0:05": "00:05",
  };
  for (const [input, expected] of Object.entries(cases))
    assert.equal(foodTime.normalizeFoodTime(String(input)), expected, input);
  for (const input of ["", "24:00", "9:60", "13pm", "0am", "9:3", "21:", "93", "noon", "9:30 x"])
    assert.equal(foodTime.normalizeFoodTime(input), null, input);
});

test("compiled time field keeps typing, stores the normalized time and flags an unreadable one", () => {
  const harness = screenHarness({});
  const { TimeField } = harness.load("src/components/nutrition/time-field.tsx");
  let value = "08:00";
  const render = () => nodes(harness.render(TimeField, { value, onChange: (v) => (value = v) }));
  const input = () => render().find((node) => node.type === "Input");
  const invalid = () => render().find((node) => node.type === "TextField").props.isInvalid;
  assert.equal(input().props.keyboardType, "numbers-and-punctuation");
  input().props.onChangeText("930");
  assert.equal(value, "09:30");
  assert.equal(input().props.value, "930", "the typed text stays while editing");
  input().props.onBlur();
  assert.equal(input().props.value, "09:30");
  input().props.onChangeText("9:3");
  assert.equal(value, "9:3");
  assert.equal(invalid(), false, "no error while typing");
  input().props.onBlur();
  assert.equal(invalid(), true);
  input().props.onChangeText("9:30 pm");
  assert.equal(value, "21:30");
  assert.equal(invalid(), false);
  button(render(), "Now").props.onPress();
  assert.equal(value, foodTime.currentFoodTime());
  assert.equal(input().props.value, value, "a time set outside the field replaces the draft");
});

test("logger ranking reads typed times and uses the current hour for an unreadable one", () => {
  const { diary, fastLog, sqlite } = diaryDatabase();
  const day = "2024-03-01";
  const log = (id, loggedTime) =>
    diary.saveEntry({
      day,
      meal: "Lunch",
      loggedTime,
      food: { ...food, id, name: id },
      amount: 100,
      portionLabel: "100 g",
    });
  log("dinner", "19:00");
  log("breakfast", "08:00");
  const order = (time) => fastLog.loggingChoices(time).choices.map((choice) => choice.title);
  assert.deepEqual(order("7pm"), ["dinner", "breakfast"]);
  assert.deepEqual(order("19:00"), ["dinner", "breakfast"]);
  assert.deepEqual(order("8:"), order(foodTime.currentFoodTime()));
  sqlite.close();
});

test("8-digit codes try EAN-8 as printed, then UPC-E expanded to UPC-A", () => {
  const cases = {
    // UPC-E only: the EAN-8 check digit fails.
    "01223004": ["00012000002304"],
    "04963406": ["00049000006346"],
    "06543217": ["00065100004327"],
    "01234531": ["00012300000451"],
    "01234543": ["00012340000053"],
    " 01223004 ": ["00012000002304"],
    "012000002304": ["00012000002304"],
    // Both check digits hold; catalogs keep EAN-8 codes as printed.
    11234579: ["00000011234579", "00112345000079"],
    "00030205": ["00000000030205", "00000000003025"],
    // EAN-8 only.
    "01234008": ["00000001234008"],
    96385074: ["00000096385074"],
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.deepEqual(nutrition.barcodeCandidates(String(input)), expected, input);
    assert.equal(nutrition.normalizeBarcode(String(input)), expected[0], input);
    assert.equal(nutrition.normalizeBarcode(expected[0]), expected[0], "normalizing is idempotent");
  }
  assert.deepEqual(nutrition.barcodeCandidates("00030205", "ean8"), ["00000000030205"]);
  assert.deepEqual(nutrition.barcodeCandidates("00030205", "upc_e"), [
    "00000000003025",
    "00000000030205",
  ]);
  assert.deepEqual(nutrition.barcodeCandidates("01223004", "ean8"), []);
  for (const input of ["01223005", "96385075", "0122300", "012230040"]) {
    assert.deepEqual(nutrition.barcodeCandidates(input), [], input);
    assert.equal(nutrition.normalizeBarcode(input), null, input);
  }
});

test("personal foods match either form of an 8-digit code, preferring the scanned symbol", () => {
  const { diary, sqlite } = diaryDatabase();
  diary.saveCustomFood({ ...food, id: "custom:can", name: "Can", barcode: "04963406" });
  assert.equal(diary.findPersonalBarcode("04963406").name, "Can");
  assert.equal(diary.findPersonalBarcode("049000006346").name, "Can");
  // 01234572 reads as EAN-8 and as UPC-E for 012345000072.
  diary.saveCustomFood({ ...food, id: "custom:gum", name: "Gum", barcode: "012345000072" });
  assert.equal(diary.findPersonalBarcode("01234572").name, "Gum");
  assert.equal(diary.findPersonalBarcode("01234572", "upc_e").name, "Gum");
  assert.equal(diary.findPersonalBarcode("01234572", "ean8"), null);
  diary.saveCustomFood({ ...food, id: "custom:mint", name: "Mint", barcode: "01234572" });
  assert.equal(diary.findPersonalBarcode("01234572").name, "Mint");
  assert.equal(diary.findPersonalBarcode("01234572", "ean8").name, "Mint");
  assert.equal(diary.findPersonalBarcode("01234572", "upc_e").name, "Gum");
  assert.equal(diary.findPersonalBarcode("01223004"), null);
  sqlite.close();
});

test("deleting an entry keeps a partial day partial and reopens a complete one", () => {
  const { diary, sqlite } = diaryDatabase();
  const add = (day) =>
    diary.saveEntry({ day, meal: "Lunch", food, amount: 100, portionLabel: "100 g" });
  add("2024-02-01");
  add("2024-02-01");
  diary.setDayStatus("2024-02-01", "partial");
  diary.deleteEntry(diary.entriesForDay("2024-02-01")[0]);
  assert.equal(diary.dayStatus("2024-02-01"), "partial");
  diary.deleteEntry(diary.entriesForDay("2024-02-01")[0]);
  assert.equal(diary.dayStatus("2024-02-01"), "partial");
  add("2024-02-02");
  add("2024-02-02");
  diary.setDayStatus("2024-02-02", "complete");
  diary.deleteEntry(diary.entriesForDay("2024-02-02")[0]);
  assert.equal(diary.dayStatus("2024-02-02"), "in-progress");
  sqlite.close();
});

test("compiled entry edit keeps the portion label unless the amount changes", () => {
  const { diary, sqlite } = diaryDatabase();
  const day = "2024-04-01";
  diary.saveEntry({
    day,
    meal: "Breakfast",
    loggedTime: "08:00",
    food,
    amount: 240,
    portionLabel: "≈ 1 cup · 240 g",
  });
  // Each edit opens a fresh editor on the saved entry, as Home does.
  const edit = (change) => {
    const harness = screenHarness(diary);
    const { FoodEditor } = harness.load("src/components/nutrition/food-editor.tsx");
    let closed = 0;
    const props = { entry: diary.entriesForDay(day)[0], close: () => closed++ };
    change(nodes(harness.render(FoodEditor, props)));
    button(nodes(harness.render(FoodEditor, props)), "Save changes").props.onPress();
    assert.equal(closed, 1);
    return diary.entriesForDay(day)[0];
  };
  let saved = edit((tree) =>
    tree.find((node) => node.type === "TimeField").props.onChange("12:45")
  );
  assert.equal(saved.loggedTime, "12:45");
  assert.equal(saved.portionLabel, "≈ 1 cup · 240 g");
  saved = edit((tree) => tree.find((node) => node.type === "Choices").props.onChange("Lunch"));
  assert.equal(saved.meal, "Lunch");
  assert.equal(saved.portionLabel, "≈ 1 cup · 240 g");
  saved = edit((tree) =>
    tree
      .find((node) => node.type === "Field" && node.props.label === "Quantity (g)")
      .props.onChange("120")
  );
  assert.equal(saved.amount, 120);
  assert.equal(saved.portionLabel, "120 g");
  sqlite.close();
});

test("compiled barcode camera keeps scanning after a rejected or unknown code", async () => {
  const harness = screenHarness({});
  const { BarcodeCamera } = harness.load("src/components/nutrition/food-editor.tsx");
  const scans = [];
  let finish;
  const onScan = (code, type) => {
    scans.push(`${type}:${code}`);
    return new Promise((resolve) => (finish = resolve));
  };
  const camera = () =>
    nodes(harness.render(BarcodeCamera, { onScan })).find((node) => node.type === "CameraView");
  assert.ok(camera().props.barcodeScannerSettings.barcodeTypes.includes("upc_e"));
  camera().props.onBarcodeScanned({ data: "12345678", type: "ean8" });
  camera().props.onBarcodeScanned({ data: "04963406", type: "upc_e" });
  assert.deepEqual(scans, ["ean8:12345678"], "one lookup at a time");
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  camera().props.onBarcodeScanned({ data: "12345678", type: "ean8" });
  assert.deepEqual(scans, ["ean8:12345678"], "the rejected code in view is not read again");
  camera().props.onBarcodeScanned({ data: "04963406", type: "upc_e" });
  assert.deepEqual(scans, ["ean8:12345678", "upc_e:04963406"]);
});

test("compiled barcode mode shows the camera after a rejected or unknown code and finds UPC-E", async () => {
  const { diary, sqlite } = diaryDatabase();
  diary.saveCustomFood({ ...food, id: "custom:can", name: "Can", barcode: "04963406" });
  const looked = [];
  const harness = screenHarness(
    diary,
    {},
    {
      "@/lib/food-catalog": {
        lookupBarcode: async (code) => (looked.push(code), null),
        searchCatalog: async () => [],
      },
    }
  );
  const { FoodEditor, BarcodeCamera } = harness.load("src/components/nutrition/food-editor.tsx");
  const props = { initialMode: "barcode", close: () => {} };
  const render = () => nodes(harness.render(FoodEditor, props));
  const scan = (code) =>
    render()
      .find((node) => node.type === BarcodeCamera)
      .props.onScan(code);
  await scan("12345678");
  assert.match(render().find((node) => node.type === "Error").props.message, /valid/);
  await scan("0036000291452");
  assert.deepEqual(looked, ["00036000291452"]);
  let tree = render();
  assert.ok(
    tree.some((node) => node.type === BarcodeCamera),
    "the camera stays after not found"
  );
  assert.ok(button(tree, "Enter the label by hand"));
  await scan("04963406");
  tree = render();
  assert.equal(looked.length, 1, "a personal food is found without the catalog");
  assert.ok(tree.some((node) => node.type === "Text" && node.props.children === "Can"));
  sqlite.close();
});

test("compiled barcode lookup finds bundled products under their EAN-8 or UPC-A form", async () => {
  const { diary, sqlite } = diaryDatabase();
  const { catalog, close } = bundledCatalog();
  const harness = screenHarness(diary, {}, { "@/lib/food-catalog": catalog });
  const { FoodEditor, BarcodeCamera } = harness.load("src/components/nutrition/food-editor.tsx");
  const props = { close: () => {} };
  const render = () => nodes(harness.render(FoodEditor, props));
  const lookup = async (code, type) => {
    button(render(), "Back to search")?.props.onPress();
    button(render(), "Scan barcode").props.onPress();
    await render()
      .find((node) => node.type === BarcodeCamera)
      .props.onScan(code, type);
    const tree = render();
    if (tree.some((node) => node.type === BarcodeCamera)) return null;
    return tree.find((node) => node.type === "Text").props.children;
  };
  // Trader Joe's codes are EAN-8; 00030205 would expand to another product's UPC-A.
  assert.equal(await lookup("00030205"), "Orzo");
  assert.equal(await lookup("00030205", "ean8"), "Orzo");
  assert.equal(await lookup("00001977"), "Sliced Cracked Wheat Sourdough Bread");
  assert.equal(await lookup("00818469"), "Traditional Caramel Flan");
  // UPC-E codes stored only in their UPC-A form.
  assert.equal(await lookup("01223004", "upc_e"), "Pepsi Cola");
  assert.equal(await lookup("01223004"), "Pepsi Cola");
  assert.equal(await lookup("00827478"), "Extra Ginger Beer");
  assert.equal(await lookup("00827478", "upc_e"), "Extra Ginger Beer");
  assert.equal(await lookup("00827478", "ean8"), null, "an EAN-8 symbol is never expanded");
  // A UPC-E symbol reads its UPC-A form first.
  assert.equal(await lookup("03013700", "upc_e"), "Muller corner greek mango 5.3z");
  assert.equal(await lookup("03013700"), "Lowfat yogurt with mango");
  close();
  sqlite.close();
});

test("logging from Library in the classic layout defaults to the meal for the time", () => {
  const { diary, sqlite } = diaryDatabase();
  diary.saveEntry({
    day: "2024-01-01",
    meal: "Breakfast",
    food,
    amount: 100,
    portionLabel: "100 g",
  });
  const saved = diary.saveMeal("Usual", "2024-01-01", "Breakfast");
  const meal = (file, name, props) => {
    const harness = screenHarness(diary);
    const Component = harness.load(`src/components/nutrition/${file}.tsx`)[name];
    const tree = nodes(harness.render(Component, { close: () => {}, ...props }));
    return tree.find((node) => node.type === "Choices").props.value;
  };
  const now = foodTime.mealAtTime(foodTime.currentFoodTime());
  assert.equal(meal("food-editor", "FoodEditor", { initialFood: food }), now);
  assert.equal(
    meal("food-editor", "FoodEditor", { initialFood: food, initialTime: "19:30" }),
    "Dinner"
  );
  assert.equal(
    meal("food-editor", "FoodEditor", { initialFood: food, initialMeal: "Snacks" }),
    "Snacks"
  );
  assert.equal(meal("meal-editor", "MealEditor", { saved }), now);
  assert.equal(meal("meal-editor", "MealEditor", { saved, initialTime: "12:30" }), "Lunch");
  sqlite.close();
});
