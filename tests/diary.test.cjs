const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const ts = require("typescript");
const { drizzle } = require(
  path.join(path.dirname(require.resolve("drizzle-orm/expo-sqlite")), "driver.cjs")
);

// Search ranking is pure and shared by the logging modules, so every harness gets the real one.
let rank;
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
    (name) =>
      name in dependencies
        ? dependencies[name]
        : name === "@/lib/food-rank" || name === "./food-rank"
          ? (rank ??= load("src/lib/food-rank.ts"))
          : localRequire(name),
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

/**
 * The production catalog module on a phone in a temporary folder: expo-file-system works on its
 * folders, and expo-sqlite installs the bundled databases there as the native module does, then
 * opens them with real SQLite. `close` closes what is open and deletes the folder.
 */
function bundledCatalog() {
  const root = mkdtempSync(path.join(tmpdir(), "macro-track-diary-"));
  const local = (uri) => decodeURIComponent(uri.replace(/^file:\/\//, ""));
  class Directory {
    constructor(parent, name) {
      this.uri = `${parent.uri}/${name}`;
    }
    get exists() {
      return existsSync(local(this.uri));
    }
    create({ intermediates = false, idempotent = false } = {}) {
      if (!(idempotent && this.exists)) mkdirSync(local(this.uri), { recursive: intermediates });
    }
    list() {
      return readdirSync(local(this.uri), { withFileTypes: true }).map((entry) =>
        entry.isDirectory() ? new Directory(this, entry.name) : new File(this, entry.name)
      );
    }
  }
  class File {
    constructor(parent, name) {
      this.uri = `${parent.uri}/${name}`;
    }
    get name() {
      return path.basename(this.uri);
    }
    get exists() {
      return existsSync(local(this.uri));
    }
    get size() {
      return this.exists ? statSync(local(this.uri)).size : 0;
    }
    delete() {
      rmSync(local(this.uri));
    }
    moveSync(destination, { overwrite = false } = {}) {
      if (!overwrite && destination.exists) throw new Error("Destination already exists");
      renameSync(local(this.uri), local(destination.uri));
      this.uri = destination.uri;
    }
  }
  const home = { uri: `file://${root}` };
  const assets = { 1: "assets/food/usda.db", 2: "assets/food/off.db" };
  const opened = [];
  const catalog = load("src/lib/food-catalog.ts", {
    "../../assets/food/usda.db": 1,
    "../../assets/food/off.db": 2,
    "./nutrition": nutrition,
    "expo-file-system": {
      Directory,
      File,
      Paths: {
        document: new Directory(home, "Documents"),
        cache: new Directory(home, "Caches"),
        availableDiskSpace: Infinity,
      },
    },
    "react-native": { Platform: { OS: "ios" } },
    "expo-sqlite": {
      async importDatabaseFromAssetAsync(name, { assetId, forceOverwrite }, directory) {
        const target = path.join(directory, name);
        if (existsSync(target) && !forceOverwrite) return;
        mkdirSync(directory, { recursive: true });
        copyFileSync(assets[assetId], target, constants.COPYFILE_FICLONE);
      },
      // Like the native module, opening a missing file creates an empty database.
      async openDatabaseAsync(name, options, directory) {
        const database = new DatabaseSync(path.join(directory, name));
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
  return {
    catalog,
    close() {
      opened.filter((database) => database.isOpen).forEach((database) => database.close());
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// Runs the compiler output with persistent hook slots; native views are plain element types.
function screenHarness(diary, storeOverrides = {}, extraDependencies = {}) {
  const slots = [];
  const alerts = [];
  // The latest render's effects; they run only when a test calls runEffects().
  const effects = [];
  const mounted = new Set();
  let cursor = 0;
  const context = { revision: 0, refresh: () => context.revision++ };
  const react = {
    createContext: () => ({}),
    // A context a test gives a value reads it; every other one is the nutrition context.
    useContext: (used) => (used && "value" in used ? used.value : context),
    useEffect: (effect, deps) => effects.push({ slot: cursor++, effect, deps }),
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
  let keypad, picker;
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
      Pressable: "Pressable",
      ScrollView: "ScrollView",
      TextInput: "TextInput",
      ActivityIndicator: "ActivityIndicator",
      AppState: {},
      Platform: { OS: "ios" },
      AccessibilityInfo: { announceForAccessibility: () => {} },
      Alert: { alert: (...args) => alerts.push(args) },
      Linking: { openSettings: async () => {} },
      Keyboard: { addListener: () => ({ remove: () => {} }) },
    },
    "heroui-native": {
      TextField: "TextField",
      Input: "Input",
      Label: "Label",
      Description: "Description",
      FieldError: "FieldError",
      useThemeColor: () => "#000000",
    },
    "react-native-svg": { __esModule: true, default: "Svg", Circle: "Circle" },
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
      SearchInput: "SearchInput",
      Screen: "Screen",
      ActionMenu: "ActionMenu",
      DayPicker: "DayPicker",
      SwipeRow: "SwipeRow",
    },
    "@/lib/diary": diary,
    "@/lib/metrics": metrics,
    "./metrics": metrics,
    "@/lib/nutrition": nutrition,
    "@/lib/food-time": foodTime,
    "@/lib/food-catalog": {
      lookupBarcode: async () => null,
      searchCatalog: async () => [],
      searchFoods: async () => [],
    },
    "@/lib/food-icons": load("src/lib/food-icons.ts"),
    "./food-icon": { FoodIcon: "FoodIcon" },
    "@/lib/local-ai": { textRecognitionAvailable: () => false, recognizeText: async () => [] },
    "@/lib/nutrition-label": {},
    "./photo-capture": { PhotoCapture: "PhotoCapture", discardPhoto: () => {} },
    "./time-field": { TimeField: "TimeField" },
    // Home's sheets and cards render as plain elements.
    "expo-router": { router: {}, useIsFocused: () => true },
    "@/lib/app-actions": load("src/lib/app-actions.ts"),
    "@/lib/weigh-in": { weighInDue: () => false, undoWeight: () => {} },
    "@/components/measurements/use-measurement-log": { useMeasurementLog: () => ({}) },
    "@/components/measurements/weight-form": { WeightForm: "WeightForm" },
    // Pure helpers such as portionFor; tests that log pass the database-backed module.
    "@/lib/fast-log": load("src/lib/fast-log.ts", {
      "@/db": {},
      "./diary": diary,
      "./nutrition": nutrition,
      "./metrics": metrics,
      "./food-time": foodTime,
    }),
    "./fast-logger": { FastLogger: "FastLogger" },
    "./quick-add": { QuickAdd: "QuickAdd" },
    "./home-check-in": { HomeCheckIn: "HomeCheckIn" },
    "./weigh-in-card": { WeighInCard: "WeighInCard" },
    "./week-strip": { WeekStrip: "WeekStrip" },
    "./quick-log-bar": { QuickLogBar: "QuickLogBar" },
    "./food-editor": { FoodEditor: "FoodEditor" },
    "./photo-logger": { PhotoLogger: "PhotoLogger", photoLoggingOffered: () => false },
    "./copy-day": { CopyDay: "CopyDay", MoveEntries: "MoveEntries" },
    "./meal-editor": { MealEditor: "MealEditor" },
    // The real, compiled amount picker, loaded when a screen imports it. React keeps a child's
    // hooks apart from its parent's, so it runs in a harness of its own; see pad().
    get "./amount-picker"() {
      keypad ??= screenHarness(diary, storeOverrides);
      return (picker ??= keypad.load("src/components/nutrition/amount-picker.tsx"));
    },
    "expo-camera": {
      CameraView: "CameraView",
      useCameraPermissions: () => [{ granted: true }, async () => {}],
    },
    ...extraDependencies,
  };
  const store = { diaryLayout: "meals", number: (n) => String(n), date: (day) => day };
  Object.assign(store, storeOverrides);
  dependencies["@/lib/store"] = dependencies["./store"] = { useStore: () => store };
  dependencies["./health-schedule"] ??= { syncHealthFood: async () => {} };
  dependencies["@/lib/nutrition-store"] = load("src/lib/nutrition-store.tsx", dependencies, true);
  return {
    context,
    alerts,
    load: (file) => load(file, dependencies, true),
    render(Component, props) {
      cursor = 0;
      effects.length = 0;
      return Component(props);
    },
    /** Renders the amount picker a screen's `tree` shows, for its keys, unit chips and actions. */
    pad(tree) {
      const { AmountPicker } = dependencies["./amount-picker"];
      const { props } = tree.find((node) => node.type === AmountPicker);
      return nodes(keypad.render(AmountPicker, props));
    },
    /** Runs the latest render's effects whose deps changed, as React would after a commit. */
    runEffects() {
      for (const { slot, effect, deps } of effects.splice(0)) {
        const previous = slots[slot];
        if (previous && deps?.every((value, i) => Object.is(value, previous.deps[i]))) continue;
        previous?.cleanup?.();
        slots[slot] = { deps, cleanup: effect() };
        mounted.add(slot);
      }
    },
    /** Runs the effects' cleanups, as React does on unmount. */
    unmount() {
      for (const slot of mounted) slots[slot].cleanup?.();
      mounted.clear();
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
const button = (tree, label) =>
  tree.find((node) => node.type === "Button" && node.props.children === label);
/** Types a keypad key into the amount field as the system keyboard would: a selected amount is replaced. */
function typeKey(input, key) {
  const { value, selection } = input.props;
  const selected = !!selection && selection.end > selection.start;
  input.props.onChangeText(
    key === "⌫" ? (selected ? "" : value.slice(0, -1)) : (selected ? "" : value) + key
  );
}
/** Types keys into the amount field of the screen `render` shows, rendering it for each. */
function press(harness, render, ...keys) {
  for (const key of keys)
    typeKey(
      harness.pad(render()).find((node) => node.type === "TextInput"),
      key
    );
}
/** What the amount field of the screen in `tree` reads: "355 g", "1 bar". */
const amountText = (harness, tree) => {
  const { value, accessibilityLabel } = harness
    .pad(tree)
    .find((node) => node.type === "TextInput").props;
  return `${value || "0"} ${accessibilityLabel.replace("Amount in ", "")}`;
};

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

/** The time field with the Pro picker as plain parts: TimePicker is the root, TimePicker.X a part. */
function timeFieldHarness(storeOverrides = {}, uses24hourClock = false) {
  const TimePicker = new Proxy({}, { get: (_, part) => `TimePicker.${String(part)}` });
  const harness = screenHarness({}, storeOverrides, {
    "heroui-native-pro": { TimePicker },
    "expo-localization": { useCalendars: () => [{ uses24hourClock }] },
    "@/components/ui": { useEditorPortalHost: () => "editor-host" },
  });
  const { TimeField } = harness.load("src/components/nutrition/time-field.tsx");
  const render = (props) => nodes(harness.render(TimeField, props));
  return { TimePicker, render };
}

test("compiled time field picks a time on a wheel and keeps it as HH:mm", () => {
  const { TimePicker, render } = timeFieldHarness({ language: "en-US" });
  let value = "08:00";
  const picker = () =>
    render({ value, onChange: (v) => (value = v) }).find((node) => node.type === TimePicker);
  assert.deepEqual(picker().props.value, {
    value: "08:00:00",
    label: foodTime.formatClock("08:00", "en-US"),
  });
  assert.equal(picker().props.hourFormat, 12);
  picker().props.onValueChange({ value: "21:30:00", label: "9:30 PM" });
  assert.equal(value, "21:30");
  assert.equal(
    picker().props.formatTime({ toString: () => "21:30:00" }),
    foodTime.formatClock("21:30", "en-US"),
    "the trigger reads the time as Home shows it"
  );
  value = "9:3";
  assert.equal(picker().props.value, undefined, "an unreadable time shows as unset");
  const portal = render({ value, onChange() {} }).find((node) => node.type === "TimePicker.Portal");
  assert.equal(portal.props.hostName, "editor-host", "opens above the sheet it sits in");
  const clock24 = timeFieldHarness({ language: "en-GB" }, true);
  const root = clock24
    .render({ value: "21:30", onChange() {} })
    .find((node) => node.type === clock24.TimePicker);
  assert.equal(root.props.hourFormat, 24, "the wheel follows the device clock");
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
    const render = () => nodes(harness.render(FoodEditor, props));
    change(render, harness);
    button(harness.pad(render()), "Save changes").props.onPress();
    assert.equal(closed, 1);
    return diary.entriesForDay(day)[0];
  };
  let saved = edit((render) =>
    render()
      .find((node) => node.type === "TimeField")
      .props.onChange("12:45")
  );
  assert.equal(saved.loggedTime, "12:45");
  assert.equal(saved.portionLabel, "≈ 1 cup · 240 g");
  saved = edit((render) =>
    render()
      .find((node) => node.type === "Choices")
      .props.onChange("Lunch")
  );
  assert.equal(saved.meal, "Lunch");
  assert.equal(saved.portionLabel, "≈ 1 cup · 240 g");
  saved = edit((render, harness) => {
    assert.equal(amountText(harness, render()), "240 g");
    press(harness, render, "1", "2", "0");
  });
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

// B6: every diary write returns a receipt that Undo puts back exactly.
function logAt(diary, day, loggedTime, name) {
  return diary.saveEntry({
    day,
    meal: foodTime.mealAtTime(loggedTime),
    loggedTime,
    food: { ...food, name },
    amount: 100,
    portionLabel: "100 g",
  }).inserted[0];
}
function diarySnapshot(diary, sqlite, days) {
  return {
    rows: days.flatMap((day) => diary.entriesForDay(day)),
    status: days.map(
      (day) =>
        sqlite.prepare("SELECT status FROM diary_days WHERE day = ?").get(day)?.status ?? null
    ),
  };
}

test("delete, move and copy undo to the same rows, ids and day answers", () => {
  const { diary, sqlite } = diaryDatabase();
  const days = ["2024-05-01", "2024-05-02", "2024-05-03"];
  const oats = logAt(diary, days[0], "08:00", "Oats");
  const soup = logAt(diary, days[0], "12:30", "Soup");
  const rice = logAt(diary, days[1], "19:00", "Rice");
  diary.setDayStatus(days[0], "partial");
  diary.setDayStatus(days[1], "complete");
  const original = diarySnapshot(diary, sqlite, days);
  const same = () => assert.deepEqual(diarySnapshot(diary, sqlite, days), original);

  let receipt = diary.deleteEntries([oats.id, rice.id]);
  assert.deepEqual(
    receipt.deleted.map((row) => row.id),
    [oats.id, rice.id]
  );
  assert.deepEqual(diary.entriesForDay(days[0]), [soup]);
  assert.equal(diary.dayStatus(days[0]), "partial", "a partial day stays partial");
  assert.equal(diary.dayStatus(days[1]), "in-progress");
  diary.undoReceipt(receipt);
  same();
  assert.throws(() => diary.undoReceipt(receipt), /changed/, "Undo runs once");

  receipt = diary.moveEntries([oats.id, soup.id], days[1], "18:15");
  assert.ok(
    receipt.moved.every(
      ({ after }) =>
        after.day === days[1] && after.loggedTime === "18:15" && after.meal === "Dinner"
    )
  );
  assert.equal(diary.entriesForDay(days[0]).length, 0);
  assert.equal(diary.dayStatus(days[1]), "in-progress");
  diary.undoReceipt(receipt);
  same();

  // Without a time, only the day changes.
  receipt = diary.moveEntries([oats.id, soup.id], days[2], null);
  assert.deepEqual(
    receipt.moved.map(({ after }) => `${after.day} ${after.loggedTime} ${after.meal}`),
    [`${days[2]} 08:00 Breakfast`, `${days[2]} 12:30 Lunch`]
  );
  diary.undoReceipt(receipt);
  same();

  receipt = diary.copyEntries([soup.id, rice.id], days[2], "13:00");
  assert.equal(receipt.inserted.length, 2);
  assert.ok(
    receipt.inserted.every(
      (row) => row.day === days[2] && row.loggedTime === "13:00" && row.meal === "Lunch"
    )
  );
  assert.equal(diary.dayStatus(days[1]), "complete", "copying leaves the source day alone");
  diary.undoReceipt(receipt);
  same();

  assert.throws(() => diary.moveEntries([oats.id], days[0], "08:00"), /different/);
  assert.throws(() => diary.deleteEntries([oats.id, 9999]));
  assert.throws(() => diary.deleteEntries([]));
  assert.throws(() => diary.moveEntries([oats.id], "2999-01-01", null));
  assert.throws(() => diary.copyEntries([oats.id], days[2], "25:00"));
  same();
  sqlite.close();
});

test("undo is refused after a later edit, and a later change keeps the day's answer", () => {
  const { diary, fastLog, sqlite } = diaryDatabase();
  const day = "2024-06-01";
  const oats = logAt(diary, day, "08:00", "Oats");

  const copied = diary.copyEntries([oats.id], day, "09:00");
  diary.saveEntry({ ...copied.inserted[0], amount: 50, portionLabel: "50 g" });
  assert.throws(() => diary.undoReceipt(copied), /changed/);
  assert.equal(diary.entriesForDay(day).length, 2);

  const moved = diary.moveEntries([oats.id], day, "10:00");
  diary.saveEntry({ ...moved.moved[0].after, loggedTime: "10:30" });
  assert.throws(() => diary.undoReceipt(moved));
  assert.equal(diary.entriesForDay(day)[0].loggedTime, "10:30");

  // An edit is a write too: Undo puts the old day, time and meal back.
  const before = diary.entriesForDay(day)[0];
  const edit = diary.saveEntry({ ...before, day: "2024-06-02", loggedTime: "19:00" });
  assert.deepEqual(edit.moved[0].before, before);
  diary.undoReceipt(edit);
  assert.deepEqual(diary.entriesForDay(day)[0], before);
  assert.equal(diary.entriesForDay("2024-06-02").length, 0);

  // A deleted food returns even after other logging, but the day stays open for it.
  diary.setDayStatus(day, "complete");
  const removed = diary.deleteEntries([before.id]);
  fastLog.logBatch([fastLog.portionFor(food)], { day, time: "20:00" });
  diary.undoReceipt(removed);
  assert.equal(diary.entriesForDay(day).length, 3);
  assert.equal(diary.dayStatus(day), "in-progress");
  // A day answered again since keeps that answer.
  diary.setDayStatus(day, "complete");
  const again = diary.deleteEntries([before.id]);
  diary.setDayStatus(day, "partial");
  diary.undoReceipt(again);
  assert.equal(diary.dayStatus(day), "partial");
  sqlite.close();
});

test("copying a day, a meal or a saved meal can be undone", () => {
  const { diary, fastLog, sqlite } = diaryDatabase();
  logAt(diary, "2024-07-01", "08:00", "Oats");
  logAt(diary, "2024-07-01", "08:10", "Coffee");
  diary.setDayStatus("2024-07-01", "complete");
  logAt(diary, "2024-07-02", "12:00", "Soup");
  diary.setDayStatus("2024-07-02", "partial");
  const days = ["2024-07-01", "2024-07-02", "2024-07-03"];
  const original = diarySnapshot(diary, sqlite, days);
  const same = () => assert.deepEqual(diarySnapshot(diary, sqlite, days), original);

  let receipt = diary.copyDay("2024-07-01", "2024-07-02");
  assert.equal(receipt.inserted.length, 2);
  assert.equal(diary.dayStatus("2024-07-02"), "partial");
  diary.undoReceipt(receipt);
  same();
  diary.undoReceipt(diary.copyDay("2024-07-01", "2024-07-03"));
  same();
  receipt = diary.copyMeal("2024-07-01", "Breakfast", "2024-07-02", "Dinner", "18:00");
  assert.deepEqual(
    receipt.inserted.map((row) => `${row.food.name} ${row.loggedTime} ${row.meal}`),
    ["Oats 18:00 Dinner", "Coffee 18:00 Dinner"]
  );
  diary.undoReceipt(receipt);
  same();
  const saved = diary.saveMeal("Usual", "2024-07-01", "Breakfast");
  receipt = diary.logSavedMeal(saved.id, "2024-07-03", "Lunch", 2, "12:00");
  assert.deepEqual(
    receipt.inserted.map((row) => row.amount),
    [200, 200]
  );
  diary.undoReceipt(receipt);
  same();
  // A log that finished the day undoes to the answer before it.
  const log = fastLog.logBatch([fastLog.portionFor(food)], {
    day: "2024-07-02",
    time: "21:00",
    complete: true,
  });
  assert.equal(diary.dayStatus("2024-07-02"), "complete");
  assert.deepEqual(log.entries, log.inserted);
  fastLog.undoLog(log);
  same();
  sqlite.close();
});

test("chosen foods save as a meal on their own", () => {
  const { diary, sqlite } = diaryDatabase();
  const day = "2024-08-01";
  const oats = logAt(diary, day, "08:00", "Oats");
  logAt(diary, day, "08:10", "Coffee");
  const soup = logAt(diary, day, "12:30", "Soup");
  const saved = diary.saveMeal("Pair", day, "Breakfast", undefined, [soup.id, oats.id]);
  assert.deepEqual(
    saved.items.map((item) => item.food.name),
    ["Oats", "Soup"]
  );
  sqlite.close();
});

test("compiled time field sets the time from a chip", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2024, 0, 10, 12, 10) });
  const render = (language, value, onChange = () => {}) =>
    timeFieldHarness({ language }).render({ value, onChange });
  let value = "08:00";
  const chips = render("en-US", value, (next) => (value = next)).filter(
    (node) => node.type === "Button" && node.props.accessibilityLabel
  );
  assert.deepEqual(
    chips.map((node) => node.props.children),
    ["Now", "−15 m", "−30 m", "−1 h"]
  );
  const times = chips.map((chip) => (chip.props.onPress(), value));
  assert.deepEqual(times, ["12:10", "11:55", "11:40", "11:10"]);
  assert.ok(chips.every((chip) => !chip.props.isDisabled));
  // Just after midnight, a chip that would reach back into yesterday is off, not 00:00.
  t.mock.timers.setTime(new Date(2024, 0, 10, 0, 20).getTime());
  assert.deepEqual(
    render("en-US", value)
      .filter((node) => node.type === "Button" && node.props.accessibilityLabel)
      .map((node) => !!node.props.isDisabled),
    [false, false, true, true]
  );
});

test("compiled entry delete needs no confirmation and hands Home an undoable receipt", () => {
  const { diary, sqlite } = diaryDatabase();
  const day = "2024-09-01";
  const oats = logAt(diary, day, "08:00", "Oats");
  diary.setDayStatus(day, "partial");
  const harness = screenHarness(diary);
  const { FoodEditor } = harness.load("src/components/nutrition/food-editor.tsx");
  const changes = [];
  let closed = 0;
  const props = {
    entry: oats,
    close: () => closed++,
    onChanged: (receipt, change) => changes.push([receipt, change]),
  };
  const remove = button(nodes(harness.render(FoodEditor, props)), "Delete entry");
  remove.props.onPress();
  remove.props.onPress();
  assert.equal(harness.alerts.length, 0);
  assert.equal(closed, 1);
  assert.equal(diary.entriesForDay(day).length, 0);
  assert.deepEqual(
    changes.map(([receipt, change]) => [receipt.deleted[0].id, change]),
    [[oats.id, "deleted"]]
  );
  diary.undoReceipt(changes[0][0]);
  assert.deepEqual(diary.entriesForDay(day), [oats]);
  assert.equal(diary.dayStatus(day), "partial");

  // Saving an edit reports its receipt too.
  const edit = screenHarness(diary);
  const Editor = edit.load("src/components/nutrition/food-editor.tsx").FoodEditor;
  const editProps = { ...props, entry: diary.entriesForDay(day)[0] };
  nodes(edit.render(Editor, editProps))
    .find((node) => node.type === "TimeField")
    .props.onChange("09:15");
  button(edit.pad(nodes(edit.render(Editor, editProps))), "Save changes").props.onPress();
  const [receipt, change] = changes.at(-1);
  assert.equal(change, "saved");
  assert.equal(receipt.moved[0].after.loggedTime, "09:15");
  diary.undoReceipt(receipt);
  assert.deepEqual(diary.entriesForDay(day), [oats]);
  sqlite.close();
});

function homeScreen(diary, storeOverrides = {}, extraDependencies = {}) {
  const harness = screenHarness(
    diary,
    { diaryLayout: "timeline", hideEmptyHours: true, ...storeOverrides },
    extraDependencies
  );
  const { TodayScreen } = harness.load("src/components/nutrition/today-screen.tsx");
  const render = () => nodes(harness.render(TodayScreen));
  const row = (tree, name) =>
    tree.find(
      (node) =>
        node.type === "Button" &&
        (node.props.accessibilityLabel === `Edit ${name}` ||
          (node.props.accessibilityState && node.props.accessibilityLabel === name))
    );
  const swipe = (tree, name) =>
    tree.find(
      (node) => node.type === "SwipeRow" && nodes(node.props.children).includes(row(tree, name))
    );
  const says = (tree, pattern) =>
    tree.some(
      (node) =>
        node.type === "Text" &&
        typeof node.props.children === "string" &&
        pattern.test(node.props.children)
    );
  return { harness, render, row, swipe, says };
}

test("compiled Home deletes with a swipe, logs again with the other and undoes both", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: new Date(2024, 0, 10, 12, 0, 10) });
  const { diary, sqlite } = diaryDatabase();
  const today = metrics.localDay();
  const oats = logAt(diary, today, "08:00", "Oats");
  const eggs = logAt(diary, today, "08:30", "Eggs");
  diary.setDayStatus(today, "partial");
  const { render, row, swipe, says } = homeScreen(diary);

  let tree = render();
  assert.equal(swipe(tree, "Oats").props.enabled, true);
  swipe(tree, "Oats").props.swipeLeft.onAction();
  assert.deepEqual(diary.entriesForDay(today), [eggs]);
  tree = render();
  assert.ok(says(tree, /^Oats deleted\.$/));
  assert.equal(row(tree, "Oats"), undefined);
  button(tree, "Undo").props.onPress();
  assert.deepEqual(diary.entriesForDay(today), [oats, eggs], "the same rows come back");
  assert.equal(diary.dayStatus(today), "partial");
  assert.ok(says(render(), /^Oats restored\.$/));

  swipe(render(), "Eggs").props.swipeRight.onAction();
  const again = diary.entriesForDay(today).at(-1);
  assert.equal(again.food.name, "Eggs");
  assert.notEqual(again.id, eggs.id);
  assert.equal(again.loggedTime, "12:00");
  tree = render();
  assert.ok(says(tree, /^Eggs · 180 kcal/));
  button(tree, "Undo").props.onPress();
  assert.deepEqual(diary.entriesForDay(today), [oats, eggs]);

  // VoiceOver reaches the same actions from the row.
  const oatsRow = row(render(), "Oats");
  assert.deepEqual(
    oatsRow.props.accessibilityActions.map((action) => action.name),
    ["delete", "again", "select"]
  );
  oatsRow.props.onAccessibilityAction({ nativeEvent: { actionName: "delete" } });
  assert.deepEqual(diary.entriesForDay(today), [eggs]);
  button(render(), "Undo").props.onPress();
  assert.deepEqual(diary.entriesForDay(today), [oats, eggs]);
  sqlite.close();
});

test("compiled Home selection copies, deletes, moves and saves chosen foods with Undo", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: new Date(2024, 0, 10, 12, 0, 10) });
  const { diary, sqlite } = diaryDatabase();
  const today = metrics.localDay();
  const yesterday = nutrition.shiftDay(today, -1);
  const oats = logAt(diary, yesterday, "08:00", "Oats");
  const eggs = logAt(diary, yesterday, "08:30", "Eggs");
  diary.setDayStatus(yesterday, "complete");
  const { render, row, swipe, says } = homeScreen(diary);
  const action = (tree, label) =>
    tree.find((node) => node.type === "Button" && node.props.accessibilityLabel === label);
  const select = () => {
    render()
      .find((node) => node.type === "WeekStrip")
      .props.onChange(yesterday);
    row(render(), "Oats").props.onLongPress();
    row(render(), "Eggs").props.onPress();
    const tree = render();
    assert.deepEqual(
      tree.find((node) => node.type === "Text" && node.props.children?.[1] === " selected").props
        .children[0],
      2
    );
    assert.equal(row(tree, "Eggs").props.accessibilityState.selected, true);
    assert.equal(swipe(tree, "Oats").props.enabled, false, "no swiping while choosing");
    return tree;
  };

  action(select(), "Copy to today").props.onPress();
  const copies = diary.entriesForDay(today);
  assert.deepEqual(
    copies.map((entry) => entry.food.name),
    ["Oats", "Eggs"]
  );
  let tree = render();
  assert.ok(says(tree, /^2 foods · 360 kcal/));
  assert.ok(!says(tree, /selected/));
  button(tree, "Undo").props.onPress();
  assert.equal(diary.entriesForDay(today).length, 2, "a quick second tap can't land on Undo");
  t.mock.timers.tick(1000);
  button(render(), "Undo").props.onPress();
  assert.equal(diary.entriesForDay(today).length, 0);

  action(select(), "Delete").props.onPress();
  assert.equal(diary.entriesForDay(yesterday).length, 0);
  assert.equal(diary.dayStatus(yesterday), "in-progress");
  assert.ok(says(render(), /^2 foods deleted\.$/));
  t.mock.timers.tick(1000);
  button(render(), "Undo").props.onPress();
  assert.deepEqual(diary.entriesForDay(yesterday), [oats, eggs]);
  assert.equal(diary.dayStatus(yesterday), "complete");

  action(select(), "Move to…").props.onPress();
  const moving = render().find((node) => node.type === "MoveEntries");
  assert.deepEqual(
    moving.props.entries.map((entry) => entry.id),
    [oats.id, eggs.id]
  );
  moving.props.close();
  moving.props.onMoved(diary.moveEntries([oats.id, eggs.id], today, "09:00"));
  assert.ok(says(render(), /^2 foods moved to Today at /));
  button(render(), "Undo").props.onPress();
  assert.deepEqual(diary.entriesForDay(yesterday), [oats, eggs]);

  action(select(), "Save as meal").props.onPress();
  tree = render();
  const editor = tree.find((node) => node.type === "MealEditor");
  assert.deepEqual(editor.props.source, {
    day: yesterday,
    meal: "Breakfast",
    ids: [oats.id, eggs.id],
  });
  assert.ok(!says(tree, /selected/));
  editor.props.close();

  // The hour's menu moves all of its foods at once.
  const menu = render().find(
    (node) => node.type === "ActionMenu" && /^Options for /.test(node.props.accessibilityLabel)
  );
  menu.props.sections[0].actions.find((item) => item.label === "Move all to…").onPress();
  assert.deepEqual(
    render()
      .find((node) => node.type === "MoveEntries")
      .props.entries.map((entry) => entry.id),
    [oats.id, eggs.id]
  );
  sqlite.close();
});

test("compiled move sheet changes day and time together or keeps each food's time", () => {
  const { diary, sqlite } = diaryDatabase();
  const today = metrics.localDay();
  const yesterday = nutrition.shiftDay(today, -1);
  const oats = logAt(diary, today, "08:00", "Oats");
  const soup = logAt(diary, today, "12:30", "Soup");
  const sheet = (entries) => {
    const harness = screenHarness(diary, { diaryLayout: "timeline" });
    const { MoveEntries } = harness.load("src/components/nutrition/copy-day.tsx");
    const receipts = [];
    let closed = 0;
    const props = { entries, close: () => closed++, onMoved: (r) => receipts.push(r) };
    const render = () => nodes(harness.render(MoveEntries, props));
    return { render, receipts, closed: () => closed };
  };
  let move = sheet([oats, soup]);
  assert.equal(move.render().find((node) => node.type === "Choices").props.value, "keep");
  assert.ok(!move.render().some((node) => node.type === "TimeField"));
  move
    .render()
    .find((node) => node.type === "DateInput")
    .props.onChange(yesterday);
  const submit = button(move.render(), "Move");
  submit.props.onPress();
  submit.props.onPress();
  assert.equal(move.closed(), 1);
  assert.equal(move.receipts.length, 1);
  assert.deepEqual(
    diary.entriesForDay(yesterday).map((entry) => entry.loggedTime),
    ["08:00", "12:30"]
  );
  diary.undoReceipt(move.receipts[0]);

  move = sheet([oats]);
  assert.ok(!move.render().some((node) => node.type === "Choices"));
  move
    .render()
    .find((node) => node.type === "TimeField")
    .props.onChange("07:15");
  button(move.render(), "Move").props.onPress();
  assert.deepEqual(
    diary.entriesForDay(today).map((entry) => `${entry.food.name} ${entry.loggedTime}`),
    ["Oats 07:15", "Soup 12:30"]
  );
  sqlite.close();
});

test("classic-layout move sheet keeps each food's meal unless one is chosen", () => {
  const { diary, sqlite } = diaryDatabase();
  const today = metrics.localDay();
  const yesterday = nutrition.shiftDay(today, -1);
  const oats = logAt(diary, yesterday, "08:00", "Oats");
  const rice = logAt(diary, yesterday, "19:00", "Rice");
  const toast = logAt(diary, yesterday, "08:30", "Toast");
  const sheet = (entries) => {
    const harness = screenHarness(diary);
    const { MoveEntries } = harness.load("src/components/nutrition/copy-day.tsx");
    const receipts = [];
    const props = { entries, close: () => {}, onMoved: (r) => receipts.push(r) };
    const render = () => nodes(harness.render(MoveEntries, props));
    const choices = (value) =>
      render().find((node) => node.type === "Choices" && node.props.values.includes(value));
    return { render, receipts, choices };
  };
  const placedOn = (day) =>
    diary
      .entriesForDay(day)
      .map((entry) => `${entry.food.name} ${entry.loggedTime} ${entry.meal}`)
      .sort();

  let move = sheet([oats, rice]);
  assert.equal(move.choices("Breakfast").props.value, "keep");
  assert.equal(move.choices("Breakfast").props.label("keep"), "Keep their meals");
  move
    .render()
    .find((node) => node.type === "DateInput")
    .props.onChange(today);
  button(move.render(), "Move").props.onPress();
  assert.deepEqual(placedOn(today), ["Oats 08:00 Breakfast", "Rice 19:00 Dinner"]);
  diary.undoReceipt(move.receipts[0]);

  // One new time still keeps each meal; choosing a meal files them all there.
  move = sheet([oats, rice]);
  move.choices("one").props.onChange("one");
  move
    .render()
    .find((node) => node.type === "TimeField")
    .props.onChange("12:00");
  button(move.render(), "Move").props.onPress();
  assert.deepEqual(placedOn(yesterday), [
    "Oats 12:00 Breakfast",
    "Rice 12:00 Dinner",
    "Toast 08:30 Breakfast",
  ]);
  diary.undoReceipt(move.receipts[0]);
  move = sheet([oats, rice]);
  move.choices("Breakfast").props.onChange("Lunch");
  button(move.render(), "Move").props.onPress();
  assert.deepEqual(placedOn(yesterday), [
    "Oats 08:00 Lunch",
    "Rice 19:00 Lunch",
    "Toast 08:30 Breakfast",
  ]);
  diary.undoReceipt(move.receipts[0]);

  // Foods from one meal start on that meal, with no keep option.
  move = sheet([oats, toast]);
  assert.equal(move.choices("Breakfast").props.value, "Breakfast");
  assert.ok(!move.choices("Breakfast").props.values.includes("keep"));

  const receipt = diary.copyEntries([oats.id, rice.id], today, "13:00", null);
  assert.deepEqual(
    receipt.inserted.map((row) => `${row.loggedTime} ${row.meal}`),
    ["13:00 Breakfast", "13:00 Dinner"]
  );
  sqlite.close();
});

test("compiled copy-day and reuse sheets hand Home an undoable receipt", () => {
  const { diary, sqlite } = diaryDatabase();
  const today = metrics.localDay();
  const yesterday = nutrition.shiftDay(today, -1);
  const oats = logAt(diary, yesterday, "08:00", "Oats");
  logAt(diary, yesterday, "08:10", "Coffee");
  const soup = logAt(diary, yesterday, "12:30", "Soup");

  let harness = screenHarness(diary);
  const { CopyDay } = harness.load("src/components/nutrition/copy-day.tsx");
  const receipts = [];
  const copyProps = { destination: today, close: () => {}, onLogged: (r) => receipts.push(r) };
  const add = nodes(harness.render(CopyDay, copyProps)).find(
    (node) => node.type === "Button" && [node.props.children].flat().join("") === "Add 3 foods"
  );
  add.props.onPress();
  add.props.onPress();
  assert.equal(receipts.length, 1);
  assert.equal(diary.entriesForDay(today).length, 3);
  diary.undoReceipt(receipts[0]);
  assert.equal(diary.entriesForDay(today).length, 0);

  // Chosen foods reuse as a meal of their own.
  harness = screenHarness(diary, { diaryLayout: "timeline" });
  const { MealEditor } = harness.load("src/components/nutrition/meal-editor.tsx");
  const props = {
    source: { day: yesterday, meal: "Breakfast", ids: [oats.id, soup.id] },
    initialDay: today,
    initialTime: "13:00",
    close: () => {},
    onLogged: (r) => receipts.push(r),
  };
  let tree = nodes(harness.render(MealEditor, props));
  assert.equal(tree.find((node) => node.type === "Editor").props.title, "Reuse 2 foods");
  tree.find((node) => node.type === "Choices").props.onChange("Copy meal");
  tree = nodes(harness.render(MealEditor, props));
  tree
    .find((node) => node.type === "Button" && /^Log at /.test(node.props.children))
    .props.onPress();
  const receipt = receipts.at(-1);
  assert.deepEqual(
    receipt.inserted.map((row) => `${row.food.name} ${row.day} ${row.loggedTime} ${row.meal}`),
    [`Oats ${today} 13:00 Lunch`, `Soup ${today} 13:00 Lunch`]
  );
  diary.undoReceipt(receipt);
  assert.equal(diary.entriesForDay(today).length, 0);
  sqlite.close();
});

// B7: a yesterday logged in full counts as complete without the morning question.
function eatAt(t, diary, day, loggedTime, calories, createdAt = `${day}T${loggedTime}:00`) {
  t.mock.timers.setTime(new Date(createdAt).getTime());
  return diary.saveEntry({
    day,
    meal: foodTime.mealAtTime(loggedTime),
    loggedTime,
    food: {
      ...food,
      id: `custom:${calories}`,
      name: `${calories} kcal`,
      basis: "serving",
      nutrients: { ...food.nutrients, calories },
    },
    amount: 1,
    portionLabel: "1 serving",
  }).inserted[0];
}
const today = "2024-01-10",
  yesterday = "2024-01-09";
/** Yesterday with a 2000 kcal target and `meals` ([time, kcal, created?]), at `now` today. */
function loggedYesterday(t, meals, now = "07:00") {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: new Date(`${yesterday}T06:00:00`) });
  const { diary, db, sqlite } = diaryDatabase();
  diary.saveTargets("2024-01-01", { calories: 2000, protein: 100, carbs: 250, fat: 60 });
  for (const [time, calories, created] of meals)
    eatAt(t, diary, yesterday, time, calories, created);
  t.mock.timers.setTime(new Date(`${today}T${now}:00`).getTime());
  return { diary, db, sqlite };
}
const fullDay = [
  ["08:00", 500],
  ["12:30", 500],
  ["19:00", 400],
];

test("yesterday logged in full counts as complete after 04:00, once, and Undo reopens it", (t) => {
  const { diary, sqlite } = loggedYesterday(t, fullDay, "03:59");
  assert.equal(diary.countableDay(), null, "a late snack can still land on yesterday");
  assert.equal(diary.countLoggedDay(), null);
  t.mock.timers.setTime(new Date(`${today}T04:00:00`).getTime());
  assert.equal(diary.countableDay(), yesterday);
  const receipt = diary.countLoggedDay();
  assert.equal(diary.dayStatus(yesterday), "complete");
  assert.equal(receipt.days[yesterday].before, "in-progress");
  assert.equal(diary.dayToConfirm(today), null, "nothing left to ask");
  assert.equal(diary.countLoggedDay(), null);

  diary.undoReceipt(receipt);
  assert.equal(diary.dayStatus(yesterday), "in-progress");
  assert.equal(diary.countableDay(), null, "a day is counted once");
  assert.equal(diary.countLoggedDay(), null);
  assert.equal(diary.dayToConfirm(today).day, yesterday, "so Home asks about it instead");
  sqlite.close();
});

test("days that look short or were filled in later still get the question", (t) => {
  const [breakfast, lunch] = fullDay;
  const cases = [
    ["two entries", [breakfast, ["19:00", 1000]], null],
    ["under 70% of target", [breakfast, lunch, ["19:00", 399]], null],
    ["a snack logged at 01:30", [breakfast, lunch, ["23:30", 400, `${today}T01:30`]], yesterday],
    ["a food added the next morning", [breakfast, lunch, ["19:00", 400, `${today}T06:30`]], null],
  ];
  for (const [name, meals, expected] of cases) {
    const { diary, sqlite } = loggedYesterday(t, meals);
    assert.equal(diary.countableDay(), expected, name);
    assert.equal(!!diary.countLoggedDay(), !!expected, name);
    assert.equal(diary.dayStatus(yesterday), expected ? "complete" : "in-progress", name);
    assert.equal(diary.dayToConfirm(today)?.day ?? null, expected ? null : yesterday, name);
    sqlite.close();
    t.mock.timers.reset();
  }

  // No target: nothing to measure against, and nothing to ask either.
  const { diary, db, sqlite } = loggedYesterday(t, fullDay);
  db.delete(schema.nutritionTargets).run();
  diary.saveTargets(today, { calories: 2000, protein: 100, carbs: 250, fat: 60 });
  assert.equal(diary.countLoggedDay(), null);
  assert.equal(diary.dayStatus(yesterday), "in-progress");
  assert.equal(diary.dayToConfirm(today), null);
  sqlite.close();
});

test("an answered day is never changed, and the setting turns counting off", (t) => {
  // "In progress" chosen from the day menu is an answer too.
  for (const answers of [["partial"], ["complete"], ["complete", "in-progress"]]) {
    const { diary, sqlite } = loggedYesterday(t, fullDay);
    for (const answer of answers) diary.setDayStatus(yesterday, answer);
    assert.equal(diary.countLoggedDay(), null, answers.join());
    assert.equal(diary.dayStatus(yesterday), answers.at(-1));
    sqlite.close();
    t.mock.timers.reset();
  }

  const { diary, db, sqlite } = loggedYesterday(t, fullDay);
  const setting = (value) =>
    db
      .insert(schema.preferences)
      .values({ key: "countLoggedDays", value })
      .onConflictDoUpdate({ target: schema.preferences.key, set: { value } })
      .run();
  setting("false");
  assert.equal(diary.countableDay(), null);
  assert.equal(diary.countLoggedDay(), null);
  assert.equal(diary.dayStatus(yesterday), "in-progress");
  setting("true");
  assert.ok(diary.countLoggedDay());
  assert.equal(diary.dayStatus(yesterday), "complete");
  sqlite.close();
});

test("a restore asks about yesterday instead of counting over an answer it doesn't carry", (t) => {
  const backup = (db) =>
    load("src/lib/backup-data.ts", {
      "@/db": { db, ...schema },
      "./metrics": metrics,
      "./nutrition": nutrition,
    });
  const phone = loggedYesterday(t, fullDay);
  phone.diary.setDayStatus(yesterday, "in-progress");
  const saved = backup(phone.db).createBackup();
  const other = diaryDatabase();
  backup(other.db).restoreBackup(saved);
  assert.equal(other.diary.countLoggedDay(), null);
  assert.equal(other.diary.dayStatus(yesterday), "in-progress");
  assert.equal(other.diary.dayToConfirm(today).day, yesterday);
  phone.sqlite.close();
  other.sqlite.close();
});

function countingHome(diary, store = {}, focus = { current: true }) {
  return homeScreen(
    diary,
    { countLoggedDays: true, ...store },
    {
      "expo-router": { router: {}, useIsFocused: () => focus.current },
      "react-native": {
        View: "View",
        Platform: { OS: "ios" },
        AppState: { addEventListener: () => ({ remove: () => {} }) },
        // The Undo message's 8 s timeout isn't under test here.
        AccessibilityInfo: {
          announceForAccessibility: () => {},
          isScreenReaderEnabled: () => new Promise(() => {}),
        },
      },
    }
  );
}
const asks = (tree) => !!button(tree, "Yes, complete");

test("compiled Home counts a full yesterday with Undo and asks about a short one", (t) => {
  const { diary, sqlite } = loggedYesterday(t, fullDay);
  const { harness, render, says } = countingHome(diary);
  let tree = render();
  assert.ok(!asks(tree), "the card doesn't flash while yesterday is being counted");
  harness.runEffects();
  t.mock.timers.tick(1);
  assert.equal(diary.dayStatus(yesterday), "complete");
  tree = render();
  harness.runEffects();
  assert.ok(says(tree, /^Yesterday counted as complete\.$/));
  assert.ok(!asks(tree));
  assert.ok(
    tree.some((node) => node.type === "HomeCheckIn"),
    "the check-in no longer waits"
  );

  button(tree, "Undo").props.onPress();
  assert.equal(diary.dayStatus(yesterday), "in-progress");
  tree = render();
  harness.runEffects();
  t.mock.timers.tick(1);
  assert.ok(says(tree, /^Change undone\.$/));
  assert.ok(asks(tree), "Undo hands the question back");
  assert.equal(diary.dayStatus(yesterday), "in-progress");
  button(tree, "Yes, complete").props.onPress();
  assert.equal(diary.dayStatus(yesterday), "complete");
  sqlite.close();
  t.mock.timers.reset();

  for (const [meals, store] of [
    [fullDay.slice(0, 2), {}],
    [fullDay, { countLoggedDays: false }],
  ]) {
    const { diary, sqlite } = loggedYesterday(t, meals);
    const { harness, render, says } = countingHome(diary, store);
    assert.ok(asks(render()));
    harness.runEffects();
    t.mock.timers.tick(1);
    tree = render();
    assert.ok(asks(tree));
    assert.ok(!says(tree, /counted/));
    assert.equal(diary.dayStatus(yesterday), "in-progress");
    sqlite.close();
    t.mock.timers.reset();
  }
});

test("compiled Home counts yesterday only once it's on screen, where its Undo is seen", (t) => {
  const { diary, sqlite } = loggedYesterday(t, fullDay);
  const focus = { current: false };
  const { harness, render, says } = countingHome(diary, {}, focus);
  render();
  harness.runEffects();
  t.mock.timers.tick(1);
  assert.equal(diary.dayStatus(yesterday), "in-progress", "not behind another tab");

  focus.current = true;
  render();
  harness.runEffects();
  t.mock.timers.tick(1);
  assert.equal(diary.dayStatus(yesterday), "complete");
  const tree = render();
  assert.ok(says(tree, /^Yesterday counted as complete\.$/));
  assert.ok(button(tree, "Undo"));
  sqlite.close();
  t.mock.timers.reset();
});

test("links name a Home action with trailing slashes, queries and dev-build forms", () => {
  const { parseAppAction } = load("src/lib/app-actions.ts");
  const dev = (url) =>
    `exp+macro-track://expo-development-client/?url=${encodeURIComponent(url)}&disableOnboarding=1`;
  const cases = {
    "macrotrack://log": "log",
    "macrotrack://log/": "log",
    "macrotrack://scan?source=shortcut": "scan",
    "macrotrack:///photo": "photo",
    "macrotrack://weigh-in/#top": "weigh-in",
    " MacroTrack://LOG ": "log",
    "macrotrack:scan": "scan",
    "exp+macro-track://photo": "photo",
    "/weigh-in/": "weigh-in",
    log: "log",
    [dev("macrotrack://scan")]: "scan",
    [dev("http://192.168.1.20:8081/--/photo")]: "photo",
    "exp://192.168.1.20:8081/--/weigh-in?x=1": "weigh-in",
    "http://localhost:8081/--/log": "log",
  };
  for (const [url, action] of Object.entries(cases)) assert.equal(parseAppAction(url), action, url);
  for (const url of [
    "",
    null,
    undefined,
    "macrotrack://",
    "macrotrack://?action=log",
    "macrotrack://plan",
    "macrotrack://log/extra",
    "macrotrack://logs",
    "macrotrack://constructor",
    "exp://192.168.1.20:8081",
    dev("http://192.168.1.20:8081"),
    "exp+macro-track://expo-development-client/",
    "exp+macro-track://expo-development-client/?url=%E0%A4%A",
  ])
    assert.equal(parseAppAction(url), null, String(url));
});

test("every link redirects to Today and an action link leaves one pending action", () => {
  const actions = load("src/lib/app-actions.ts");
  const { redirectSystemPath } = load("src/app/+native-intent.tsx", {
    "@/lib/app-actions": actions,
  });
  let heard = 0;
  const stop = actions.subscribeAppActions(() => heard++);
  // Anything else would stack a screen over Home, so it opens Today too.
  for (const path of ["macrotrack://plan", "macrotrack://weighin", "macrotrack:///log/now", ""])
    assert.equal(redirectSystemPath({ path, initial: false }), "/", path);
  assert.equal(actions.pendingAppAction(), null);
  assert.equal(heard, 0);
  assert.equal(redirectSystemPath({ path: "macrotrack://scan/", initial: true }), "/");
  assert.equal(redirectSystemPath({ path: "macrotrack://photo", initial: false }), "/");
  assert.equal(heard, 2);
  assert.equal(actions.pendingAppAction(), "photo", "the newer link wins");
  assert.equal(actions.takeAppAction(), "photo");
  assert.equal(actions.takeAppAction(), null, "taken once");
  stop();
  actions.requestAppAction("log");
  assert.equal(heard, 2);

  // An unknown route goes back to the Home already open instead of replacing itself with
  // a second one.
  const routes = [];
  const { default: NotFound } = load("src/app/+not-found.tsx", {
    "expo-router": {
      router: {
        dismissTo: (href) => routes.push(["dismissTo", href]),
        replace: (href) => routes.push(["replace", href]),
      },
      useFocusEffect: (effect) => effect(),
    },
  });
  assert.equal(NotFound(), null);
  assert.deepEqual(routes, [["dismissTo", "/"]]);
});

test("only the newest Home hears a link, and open sheets outside Home close first", () => {
  // The shared Editor, with just enough React to run its effects.
  let home = false;
  const effects = [];
  const react = {
    createContext: (value) => ({ value }),
    useContext: (context) => (context === actions.HomeSheets ? home : context.value),
    useEffect: (effect) => effects.push(effect),
    useId: () => "sheet",
  };
  const actions = load("src/lib/app-actions.ts", { react });
  const { Editor } = load("src/components/ui.tsx", {
    react,
    "react/jsx-runtime": { jsx: (type, props) => ({ type, props }), jsxs: () => null },
    "react-native": { Platform: { OS: "ios" } },
    "react-native-safe-area-context": { useSafeAreaInsets: () => ({ top: 0 }) },
    uniwind: { withUniwind: (component) => component },
    "heroui-native": {},
    "heroui-native/portal": {},
    "heroui-native-pro": {},
    "react-native-gesture-handler": {},
    "react-native-gesture-handler/ReanimatedSwipeable": { __esModule: true },
    "./system": {},
    "@/lib/app-actions": actions,
    "@/lib/metrics": metrics,
    "@/lib/store": { useStore: () => ({ t: (key) => key }) },
  });
  const heard = [];
  const mount = (open, close) => {
    effects.length = 0;
    Editor({ title: "Sheet", open, close, children: null });
    return effects.map((effect) => effect()).find(Boolean);
  };
  const older = actions.subscribeAppActions(() => heard.push("older"));
  const newer = actions.subscribeAppActions(() => heard.push("newer"));
  const closed = [];
  const progress = mount(true, () => closed.push("progress"));
  const hidden = mount(false, () => closed.push("hidden"));
  home = true;
  const homeSheet = mount(true, () => closed.push("home"));
  assert.equal(hidden, undefined);
  assert.equal(homeSheet, undefined, "Home closes its own sheets");

  actions.requestAppAction("log");
  assert.deepEqual(closed, ["progress"]);
  assert.deepEqual(heard, ["newer"], "a covered, older Home never takes the action");
  progress();
  newer();
  actions.requestAppAction("scan");
  assert.deepEqual(closed, ["progress"]);
  assert.deepEqual(heard, ["newer", "older"]);
  older();
  actions.requestAppAction("photo");
  assert.deepEqual(heard, ["newer", "older"]);
});

test("compiled Screen scrolls the end of its list clear of however tall its footer grows", () => {
  const harness = screenHarness(
    {},
    {},
    {
      "react-native": {
        View: "View",
        ScrollView: "ScrollView",
        Platform: { OS: "ios" },
        useWindowDimensions: () => ({ width: 393, height: 852 }),
      },
      "react-native-safe-area-context": {
        SafeAreaView: "SafeAreaView",
        useSafeAreaInsets: () => ({ top: 59, bottom: 83 }),
      },
      uniwind: { withUniwind: (component) => component },
      "heroui-native": {},
      "heroui-native/portal": {},
      "heroui-native-pro": {},
      "react-native-gesture-handler": {},
      "react-native-gesture-handler/ReanimatedSwipeable": { __esModule: true },
      "./system": {},
    }
  );
  const { Screen, ScreenFooter } = harness.load("src/components/ui.tsx");
  // No tab shares a footer here.
  ScreenFooter.value = null;
  const render = (footer) =>
    nodes(harness.render(Screen, { title: "Today", footer, children: null }));
  const padding = (tree) =>
    tree.find((node) => node.type === "ScrollView").props.contentContainerStyle.paddingBottom;
  assert.equal(padding(render()), 123, "clear of the floating tab bar");
  const tree = render("Undo");
  assert.equal(padding(tree), 160, "an Undo message fits the usual space");
  // The Undo message stacked on the selection bar.
  tree
    .find((node) => node.props.onLayout)
    .props.onLayout({ nativeEvent: { layout: { height: 192 } } });
  assert.equal(padding(render("Undo and selection")), 83 + 8 + 192 + 16);
});

function linkedHome(diary, actions, ai = "available") {
  return homeScreen(
    diary,
    {},
    {
      "@/lib/app-actions": actions,
      "@/lib/food-catalog": { openCatalogs: async () => {} },
      "@/lib/local-ai": {
        modelStatus: async () => ({ state: ai, engine: "apple", vision: true }),
      },
      "./photo-logger": {
        PhotoLogger: "PhotoLogger",
        photoLoggingOffered: (status) => status?.state === "available",
      },
      "react-native": {
        View: "View",
        Platform: { OS: "ios" },
        AppState: { addEventListener: () => ({ remove: () => {} }) },
        AccessibilityInfo: {
          announceForAccessibility: () => {},
          isScreenReaderEnabled: () => new Promise(() => {}),
        },
      },
    }
  );
}
const sheet = (tree, type) => tree.find((node) => node.type === type);

test("compiled Home opens a link's sheet once, on today, from a cold start or while open", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: new Date(2024, 0, 10, 12, 0, 10) });
  const { diary, sqlite } = diaryDatabase();
  const today = metrics.localDay();
  logAt(diary, nutrition.shiftDay(today, -1), "08:00", "Oats");
  const actions = load("src/lib/app-actions.ts");

  // Cold start: the link arrives before Home mounts.
  actions.requestAppAction("scan");
  const { harness, render, row } = linkedHome(diary, actions);
  let tree = render();
  harness.runEffects();
  assert.equal(sheet(tree, "FastLogger"), undefined);
  t.mock.timers.tick(1);
  tree = render();
  assert.equal(sheet(tree, "FastLogger").props.start, "barcode");
  assert.equal(sheet(tree, "FastLogger").props.initialDay, today);
  assert.equal(actions.pendingAppAction(), null);
  sheet(tree, "FastLogger").props.close();
  render();
  harness.runEffects();
  t.mock.timers.tick(1000);
  assert.equal(sheet(render(), "FastLogger"), undefined, "the action runs once");

  // Already open, on another day with a food open: the sheet closes and the logger
  // opens on today.
  render()
    .find((node) => node.type === "WeekStrip")
    .props.onChange(nutrition.shiftDay(today, -1));
  row(render(), "Oats").props.onPress();
  tree = render();
  assert.ok(sheet(tree, "FoodEditor"));
  actions.requestAppAction("log");
  tree = render();
  assert.equal(sheet(tree, "FoodEditor"), undefined, "open sheets close first");
  assert.equal(sheet(tree, "FastLogger"), undefined);
  t.mock.timers.tick(1);
  tree = render();
  assert.equal(sheet(tree, "FastLogger").props.start, undefined);
  assert.equal(sheet(tree, "FastLogger").props.initialDay, today);
  assert.equal(sheet(tree, "QuickLogBar").props.label, undefined, "back on today");

  // A photo link opens the photo logger when the model can run, the logger otherwise.
  actions.requestAppAction("photo");
  assert.equal(sheet(render(), "FastLogger"), undefined);
  t.mock.timers.tick(1);
  await new Promise(setImmediate);
  tree = render();
  assert.ok(sheet(tree, "PhotoLogger"));
  assert.equal(sheet(tree, "FastLogger"), undefined);

  // The weigh-in link closes the photo logger and opens the Log weight sheet.
  const weightSheet = tree.find((node) => node.type?.name === "HomeWeightSheet").props.ref;
  const calls = [];
  weightSheet.current = { open: () => calls.push("open"), close: () => calls.push("close") };
  actions.requestAppAction("weigh-in");
  assert.equal(sheet(render(), "PhotoLogger"), undefined);
  t.mock.timers.tick(1);
  assert.deepEqual(calls, ["close", "open"]);

  // Home unmounting before the sheet opens leaves the action for the next mount.
  actions.requestAppAction("scan");
  harness.unmount();
  t.mock.timers.tick(1);
  assert.equal(actions.pendingAppAction(), "scan");
  sqlite.close();
  const other = diaryDatabase();
  const again = linkedHome(other.diary, actions, "unavailable");
  again.render();
  again.harness.runEffects();
  t.mock.timers.tick(1);
  tree = again.render();
  assert.equal(sheet(tree, "FastLogger").props.start, "barcode");
  sheet(tree, "FastLogger").props.close();
  actions.requestAppAction("photo");
  t.mock.timers.tick(1);
  await new Promise(setImmediate);
  tree = again.render();
  assert.equal(sheet(tree, "PhotoLogger"), undefined);
  assert.ok(sheet(tree, "FastLogger"), "no model: the logger opens instead");
  other.sqlite.close();
});

test("compiled Home: of two mounted Homes, only the newer opens a link's sheet", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: new Date(2024, 0, 10, 12, 0, 10) });
  const { diary, sqlite } = diaryDatabase();
  const actions = load("src/lib/app-actions.ts");
  const covered = linkedHome(diary, actions),
    top = linkedHome(diary, actions);
  for (const home of [covered, top]) {
    home.render();
    home.harness.runEffects();
  }
  actions.requestAppAction("log");
  t.mock.timers.tick(1);
  assert.equal(sheet(covered.render(), "FastLogger"), undefined);
  assert.ok(sheet(top.render(), "FastLogger"));
  assert.equal(actions.pendingAppAction(), null);

  // Once the newer one is gone, the remaining Home hears the next link.
  top.harness.unmount();
  actions.requestAppAction("scan");
  t.mock.timers.tick(1);
  assert.equal(sheet(covered.render(), "FastLogger").props.start, "barcode");
  covered.harness.unmount();
  sqlite.close();
});

// B12: quick add from macros, remembered quantities and scanning several foods in a row.
function quickAdd(diary, fastLog) {
  const harness = screenHarness(diary, {}, { "@/lib/fast-log": fastLog });
  const { QuickAdd } = harness.load("src/components/nutrition/quick-add.tsx");
  const tree = () =>
    nodes(harness.render(QuickAdd, { day: "2024-01-01", close: () => {}, onLogged: () => {} }));
  const field = (label) =>
    tree().find((node) => node.type === "Field" && node.props.label === label);
  return {
    tree,
    field,
    type(values) {
      for (const [label, value] of Object.entries(values)) field(label).props.onChange(value);
    },
    warning: () =>
      tree().find((node) => node.type === "Text" && /^Macros add up/.test(node.props.children))
        ?.props.children,
    save() {
      button(tree(), "Add to diary").props.onPress();
      return tree().find((node) => node.type === "Error").props.message;
    },
  };
}

test("compiled quick add works out calories from macros and flags ones that don't add up", () => {
  const { diary, fastLog, sqlite } = diaryDatabase();
  const logged = () => diary.entriesForDay("2024-01-01").map((row) => row.nutrients);
  let sheet = quickAdd(diary, fastLog);
  assert.equal(sheet.field("Calories (kcal)").props.placeholder, undefined);
  assert.equal(sheet.save(), "Enter calories or macros for this entry.");
  assert.equal(logged().length, 0);

  sheet = quickAdd(diary, fastLog);
  sheet.type({ "Protein (g)": "30", "Carbs (g)": "40", "Fat (g)": "10.5" });
  assert.equal(sheet.field("Calories (kcal)").props.placeholder, "375 from macros");
  assert.equal(sheet.warning(), undefined);
  assert.equal(sheet.save(), "");
  assert.deepEqual(logged().at(-1), {
    calories: 375,
    protein: 30,
    carbs: 40,
    fat: 10.5,
    fiber: null,
    sodium: null,
  });

  // The warning never blocks the entered calories.
  sheet = quickAdd(diary, fastLog);
  sheet.type({ "Calories (kcal)": "500", "Protein (g)": "30", "Carbs (g)": "40", "Fat (g)": "10" });
  assert.equal(sheet.warning(), "Macros add up to 370 kcal.");
  sheet.save();
  assert.equal(logged().at(-1).calories, 500);

  const warns = (values) => {
    const next = quickAdd(diary, fastLog);
    next.type(values);
    return next.warning() !== undefined;
  };
  // Within 15%, or macros below the calories while some are still blank.
  assert.equal(
    warns({ "Calories (kcal)": "400", "Protein (g)": "30", "Carbs (g)": "40", "Fat (g)": "10" }),
    false
  );
  assert.equal(warns({ "Calories (kcal)": "500", "Protein (g)": "30" }), false);
  // Macros over the calories are flagged even while some are blank.
  assert.equal(warns({ "Calories (kcal)": "100", "Protein (g)": "30" }), true);
  assert.equal(warns({ "Calories (kcal)": "0", "Fat (g)": "5" }), true);

  sheet = quickAdd(diary, fastLog);
  sheet.type({ "Protein (g)": "3O" });
  assert.equal(sheet.save(), "Enter valid, non-negative nutrition values.");
  assert.equal(logged().length, 2);
  sqlite.close();
});

test("a food's latest entry from the past year is the portion offered again", () => {
  const { diary, sqlite } = diaryDatabase();
  const log = (amount) =>
    diary.saveEntry({
      day: "2024-01-01",
      meal: "Lunch",
      food,
      amount,
      portionLabel: `${amount} g`,
    });
  assert.equal(diary.lastEntryFor(food.id), undefined);
  log(30);
  log(45);
  assert.equal(diary.lastEntryFor(food.id).amount, 45);
  assert.equal(diary.lastEntryFor("custom:other"), undefined);
  sqlite.prepare("UPDATE food_entries SET created_at = created_at - ?").run(366 * 86_400_000);
  assert.equal(diary.lastEntryFor(food.id), undefined, "older than a year");
  assert.equal(diary.lastEntryFor(food.id, Date.now() - 2 * 86_400_000).amount, 45);
  sqlite.close();
});

const can = { ...food, id: "custom:can", name: "Can", barcode: "04963406" };
const bar = {
  ...food,
  id: "custom:bar",
  name: "Bar",
  barcode: "0036000291452",
  portions: [{ label: "1 bar", amount: 40 }],
};
function scanner(diary, props, dependencies) {
  const harness = screenHarness(diary, {}, dependencies);
  const { FoodEditor, FoodRow, BarcodeCamera } = harness.load(
    "src/components/nutrition/food-editor.tsx"
  );
  const render = () => nodes(harness.render(FoodEditor, props));
  const scan = (code) =>
    render()
      .find((node) => node.type === BarcodeCamera)
      .props.onScan(code);
  return {
    harness,
    render,
    quantity: () => amountText(harness, render()),
    press: (...keys) => press(harness, render, ...keys),
    chip: (label) => harness.pad(render()).find((node) => node.props.unit?.label === label),
    action: (label) => button(harness.pad(render()), label) ?? button(render(), label),
    scan,
    FoodRow,
    BarcodeCamera,
  };
}

test("compiled scans, searches and Library reuse the quantity last logged", async () => {
  const { diary, sqlite } = diaryDatabase();
  diary.saveCustomFood(can);
  diary.saveCustomFood(bar);
  diary.saveEntry({
    day: "2024-01-01",
    meal: "Lunch",
    food: can,
    amount: 355,
    portionLabel: "355 g",
  });
  let editor = scanner(diary, { initialMode: "barcode", close: () => {} });
  await editor.scan("04963406");
  assert.equal(editor.quantity(), "355 g");
  editor = scanner(diary, { initialMode: "barcode", close: () => {} });
  await editor.scan("0036000291452");
  // The bar's first portion is "1 bar", 40 g.
  assert.equal(editor.quantity(), "1 bar", "a food never logged starts at its first portion");

  editor = scanner(diary, { close: () => {} });
  editor
    .render()
    .find((node) => node.type === editor.FoodRow && node.props.food.id === can.id)
    .props.onPress();
  assert.equal(editor.quantity(), "355 g");
  assert.equal(scanner(diary, { initialFood: can, close: () => {} }).quantity(), "355 g");
  assert.equal(
    scanner(diary, { initialFood: can, initialAmount: 2, close: () => {} }).quantity(),
    "2 g"
  );
  // A food whose basis changed since starts over at its own portion.
  diary.saveCustomFood({ ...can, basis: "serving", portions: [] });
  assert.equal(
    scanner(diary, {
      initialFood: { ...can, basis: "serving", portions: [] },
      close: () => {},
    }).quantity(),
    "1 serving"
  );
  sqlite.close();
});

test("compiled scan, search, Library and Log food open a catalog food whose first portion is out of range", async (t) => {
  const { diary, sqlite, fastLog } = diaryDatabase();
  const bundled = bundledCatalog();
  // The bundled Froot Loops record lists its first portion as 5.46e31 g.
  const loops = await bundled.catalog.lookupBarcode("00038000256974");
  bundled.close();
  assert.ok(loops.portions[0].amount > 100000);
  const catalog = {
    "@/lib/food-catalog": {
      lookupBarcode: async () => loops,
      searchCatalog: async () => [loops],
      searchFoods: async () => [loops],
    },
  };
  let editor = scanner(diary, { initialMode: "barcode", close: () => {} }, catalog);
  await editor.scan("038000256974");
  assert.equal(editor.quantity(), "100 g");
  assert.equal(editor.render().find((node) => node.type === "Error").props.message, "");

  t.mock.timers.enable({ apis: ["setTimeout"] });
  editor = scanner(diary, { close: () => {} }, catalog);
  editor
    .render()
    .find((node) => node.type === "Field" && node.props.label === "Search foods")
    .props.onChange("froot loops");
  editor.render();
  editor.harness.runEffects();
  t.mock.timers.tick(180);
  await new Promise(setImmediate);
  editor
    .render()
    .find((node) => node.type === editor.FoodRow && node.props.food.id === loops.id)
    .props.onPress();
  assert.equal(editor.quantity(), "100 g");

  assert.equal(
    scanner(diary, { initialFood: loops, close: () => {} }, catalog).quantity(),
    "100 g"
  );

  // Saved, or found in Log food's search, it lists at 100 g instead of failing the list.
  diary.toggleFavorite(loops);
  const choices = fastLog.loggingChoices("08:00");
  assert.equal(choices.saved[0].detail, "100 g");
  assert.equal(choices.choose([loops])[0].detail, "100 g");
  const harness = screenHarness(diary, {}, { "@/lib/fast-log": fastLog, ...catalog });
  const { FastLogger } = harness.load("src/components/nutrition/fast-logger.tsx");
  const logger = nodes(
    harness.render(FastLogger, {
      initialDay: metrics.localDay(),
      initialTime: "08:00",
      close: () => {},
      onLogged: () => {},
    })
  );
  assert.ok(logger.some((node) => node.props.accessibilityLabel === `Add ${loops.name}`));

  diary.saveEntry({
    day: "2024-01-01",
    meal: "Breakfast",
    food: loops,
    amount: 39,
    portionLabel: "39 g",
  });
  assert.equal(scanner(diary, { initialFood: loops, close: () => {} }, catalog).quantity(), "39 g");
  sqlite.close();
});

test("compiled Add & scan another hands the food over and reopens the camera past its code", async () => {
  const { diary, sqlite } = diaryDatabase();
  diary.saveCustomFood(can);
  diary.saveCustomFood(bar);
  const picks = [];
  let closed = 0;
  const props = {
    initialMode: "barcode",
    scanAnother: true,
    pickerTitle: "Log food",
    pickLabel: "Log",
    close: () => closed++,
    onPick: (food, amount, item, keepScanning) =>
      picks.push([food.name, amount, item.portionLabel, keepScanning]),
  };
  const editor = scanner(diary, props);
  await editor.scan("04963406");
  assert.equal(editor.quantity(), "1 serving");
  // Too long to share the actions row, it keeps a full-width button of its own below it.
  const keypad = editor.harness.pad(editor.render());
  assert.equal(button(keypad, "Add & scan another"), undefined);
  assert.equal(button(editor.render(), "Add & scan another").props.icon, "barcode-outline");
  assert.equal(button(keypad, "Log").props.fit, true, "actions shrink to one line");
  editor.chip("g").props.onPress();
  // "2/" is a fraction cut short.
  editor.press("2", "/");
  editor.action("Add & scan another").props.onPress();
  assert.deepEqual(picks, [], "an invalid quantity stays on the portion");
  assert.ok(editor.render().find((node) => node.type === "Error").props.message);
  editor.press("⌫", "0");
  assert.equal(editor.quantity(), "20 g");
  editor.action("Add & scan another").props.onPress();
  assert.deepEqual(picks, [["Can", 20, "20 g", true]]);
  assert.equal(closed, 0);
  const tree = editor.render();
  const camera = tree.find((node) => node.type === editor.BarcodeCamera);
  assert.equal(camera.props.skip, "04963406");
  assert.equal(
    tree.find((node) => node.type === "Field" && node.props.label === "Barcode digits").props.value,
    ""
  );
  assert.equal(tree.find((node) => node.type === "Error").props.message, "");

  await editor.scan("0036000291452");
  editor.action("Log").props.onPress();
  assert.deepEqual(picks, [
    ["Can", 20, "20 g", true],
    ["Bar", 40, "1 bar · 40 g", false],
  ]);
  assert.equal(closed, 1);

  // Only a scanning picker offers it.
  const plain = scanner(diary, { ...props, scanAnother: false });
  await plain.scan("04963406");
  assert.ok(plain.action("Log"));
  assert.equal(plain.action("Add & scan another"), undefined);
  const logging = scanner(diary, { initialMode: "barcode", close: () => {} });
  await logging.scan("04963406");
  assert.equal(logging.action("Add & scan another"), undefined);

  // The reopened camera passes over the code just added until another one shows.
  const harness = screenHarness({});
  const scans = [];
  const view = () =>
    nodes(
      harness.render(editor.BarcodeCamera, {
        onScan: async (code) => void scans.push(code),
        skip: "04963406",
      })
    ).find((node) => node.type === "CameraView");
  view().props.onBarcodeScanned({ data: "04963406", type: "upc_e" });
  assert.deepEqual(scans, []);
  view().props.onBarcodeScanned({ data: "0036000291452", type: "upc_a" });
  assert.deepEqual(scans, ["0036000291452"]);
  sqlite.close();
});

test("compiled Scan from Home: Scan another builds a selection instead of logging one food", () => {
  const { diary, sqlite, fastLog } = diaryDatabase();
  const harness = screenHarness(diary, {}, { "@/lib/fast-log": fastLog });
  const { FastLogger } = harness.load("src/components/nutrition/fast-logger.tsx");
  const day = metrics.localDay();
  let closed = 0;
  const logged = [];
  const render = () =>
    nodes(
      harness.render(FastLogger, {
        initialDay: day,
        initialTime: "09:10",
        start: "barcode",
        close: () => closed++,
        onLogged: (receipt) => logged.push(receipt),
      })
    );
  let picker = render().find((node) => node.type === "FoodEditor");
  // FoodEditor hands over each food with its amount and the item it makes.
  const pick = (food, unit, count, keepScanning) => {
    const item = nutrition.portionItem(food, unit, count);
    picker.props.onPick(food, item.amount, item, keepScanning);
  };
  assert.equal(picker.props.scanAnother, true);
  assert.equal(picker.props.pickLabel, "Log");
  pick(can, "g", 20, true);
  assert.equal(diary.entriesForDay(day).length, 0, "the first scan waits for the next");
  picker = render().find((node) => node.type === "FoodEditor");
  assert.ok(picker, "the camera stays open");
  assert.equal(picker.props.pickLabel, undefined);
  assert.equal(picker.props.pickerTitle, "Add to meal");
  pick(bar, "portion:0", 1, false);
  picker.props.close();
  assert.equal(closed, 0, "closing the picker returns to the selection, not Home");
  button(render(), "Log 2 foods").props.onPress();
  assert.deepEqual(
    diary.entriesForDay(day).map((row) => [row.food.name, row.amount, row.portionLabel]),
    [
      ["Can", 20, "20 g"],
      ["Bar", 40, "1 bar · 40 g"],
    ]
  );
  assert.equal(logged.length, 1);
  assert.equal(closed, 1);

  // "New food" is not a scan, so it doesn't offer scanning another.
  const other = screenHarness(diary, {}, { "@/lib/fast-log": fastLog });
  const Logger = other.load("src/components/nutrition/fast-logger.tsx").FastLogger;
  const props = { initialDay: day, close: () => {}, onLogged: () => {} };
  button(nodes(other.render(Logger, props)), "New food").props.onPress();
  assert.equal(
    nodes(other.render(Logger, props)).find((node) => node.type === "FoodEditor").props.scanAnother,
    false
  );
  sqlite.close();
});
