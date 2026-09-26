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
const rank = load("src/lib/food-rank.ts");
const foodIcons = load("src/lib/food-icons.ts");
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
const other = { ...food, id: "custom:other", name: "Other food" };

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
  // Yesterday's breakfast, so both foods are in Log again.
  const day = nutrition.shiftDay(metrics.localDay(), -1);
  for (const item of [food, other])
    diary.saveEntry({
      day,
      meal: "Breakfast",
      loggedTime: "08:00",
      ...nutrition.portionItem(item, "g", 50),
    });
  return { sqlite, db, diary, fastLog };
}

// The compiled FastLogger with persistent hook slots. Effects run only when their
// dependencies change, and only when a test flushes them.
function loggerHarness(diary, fastLog, props = {}) {
  const slots = [];
  const pending = [];
  let cursor = 0;
  const context = { revision: 0, refresh: () => context.revision++ };
  const react = {
    createContext: () => ({}),
    useContext: () => context,
    useEffect(effect, deps) {
      const slot = cursor++;
      const previous = slots[slot];
      if (previous && deps && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
      slots[slot] = { deps, cleanup: previous?.cleanup };
      pending.push(() => {
        slots[slot].cleanup?.();
        slots[slot].cleanup = effect();
      });
    },
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
      ScrollView: "ScrollView",
      AppState: {},
      Platform: { OS: "ios" },
      Alert: { alert: () => {} },
    },
    "@/components/system": {
      SystemButton: "Button",
      SystemIconButton: "IconButton",
      SystemIcon: "Icon",
      SystemLabel: "Label",
      SystemText: "Text",
    },
    "@/components/ui": {
      Editor: "Editor",
      Choices: "Choices",
      DateInput: "DateInput",
      ErrorText: "Error",
      SearchInput: "SearchInput",
    },
    "@/lib/diary": diary,
    "@/lib/metrics": metrics,
    "./metrics": metrics,
    "@/lib/nutrition": nutrition,
    "@/lib/food-time": foodTime,
    "@/lib/fast-log": fastLog,
    "@/lib/food-catalog": { searchFoods: async () => [] },
    "@/lib/food-rank": rank,
    "@/lib/food-icons": foodIcons,
    "./food-icon": { FoodIcon: "FoodIcon" },
    "./amount-picker": {
      AmountPicker: "AmountPicker",
      PortionPreview: "PortionPreview",
      DayRing: "DayRing",
    },
    "./food-editor": { FoodEditor: "FoodEditor" },
    "./photo-logger": { PhotoLogger: "PhotoLogger" },
    "./quick-add": { QuickAdd: "QuickAdd" },
    "./time-field": { TimeField: "TimeField" },
  };
  const store = { diaryLayout: "meals", number: (n) => String(n), date: (day) => day };
  dependencies["@/lib/store"] = dependencies["./store"] = { useStore: () => store };
  dependencies["@/lib/nutrition-store"] = load("src/lib/nutrition-store.tsx", dependencies, true);
  const { FastLogger } = load("src/components/nutrition/fast-logger.tsx", dependencies, true);
  return {
    render() {
      cursor = 0;
      return nodes(
        FastLogger({
          initialDay: metrics.localDay(),
          initialTime: "08:00",
          close: () => {},
          onLogged: () => {},
          ...props,
        })
      );
    },
    flush() {
      pending.splice(0).forEach((run) => run());
    },
    unmount() {
      for (const slot of slots) slot?.cleanup?.();
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
/** An element's children in order, without empty slots, arrays or fragments. */
function flat(children) {
  if (Array.isArray(children)) return children.flatMap(flat);
  if (!children || typeof children !== "object") return [];
  return children.type === "Fragment" ? flat(children.props.children) : [children];
}
const find = (tree, type, label) =>
  tree.find(
    (node) =>
      node.type === type &&
      (node.props.accessibilityLabel === label || node.props.children === label)
  );
const search = (tree) => tree.find((node) => node.type === "SearchInput").props;
const editor = (tree) => tree.find((node) => node.type === "Editor").props;
/** The icon labels beside a list heading, or null when the heading has none. */
function tools(tree, heading) {
  const row = tree.find(
    (node) =>
      node.type === "View" &&
      flat(node.props.children).some(
        (child) => child.type === "Label" && child.props.children === heading
      )
  );
  assert.ok(row, `heading ${heading}`);
  const icons = flat(row.props.children).filter((child) => child.type === "IconButton");
  return icons.length ? icons.map((icon) => icon.props.accessibilityLabel) : null;
}
const icons = ["Scan barcode", "Photo or description", "Quick add", "New food"];

test("compiled logger shows its save bar only while something is selected", () => {
  const { diary, sqlite, fastLog } = diaryDatabase();
  const logger = loggerHarness(diary, fastLog);
  let tree = logger.render();
  assert.equal(editor(tree).footer, undefined, "nothing selected: no bar");
  assert.ok(!tree.some((node) => /choose foods/i.test(String(node.props.children))));
  find(tree, "IconButton", `Add ${food.name}`).props.onPress();
  tree = logger.render();
  // One row: the selection's calories and protein beside the save button.
  const [bar] = flat(editor(tree).footer.props.children).filter((node) => node.type === "View");
  assert.deepEqual(
    flat(bar.props.children).map((node) => [node.type, node.props.children]),
    [
      ["Text", "90 kcal · 5 g protein"],
      ["Button", "Log 1 food"],
    ]
  );
  find(tree, "IconButton", `Remove ${food.name}`).props.onPress();
  assert.equal(editor(logger.render()).footer, undefined, "emptied again: the bar goes");
  sqlite.close();
});

test("compiled logger shrinks its shortcuts to icons once the search is used", () => {
  const { diary, sqlite, fastLog } = diaryDatabase();
  const logger = loggerHarness(diary, fastLog, { photoLogging: true });
  let tree = logger.render();
  for (const label of ["Scan", "Photo", "Quick add", "New food"])
    assert.ok(find(tree, "Button", label), `${label} chip before searching`);
  assert.equal(tools(tree, "Log again"), null);

  search(tree).onFocus();
  tree = logger.render();
  for (const label of ["Scan", "Photo", "Quick add", "New food"])
    assert.equal(find(tree, "Button", label), undefined, `no ${label} chip while searching`);
  assert.deepEqual(tools(tree, "Log again"), icons);

  search(tree).onChange("test");
  tree = logger.render();
  assert.deepEqual(tools(tree, "Searching…"), icons);
  // The keyboard hiding doesn't bring the chips back, so the list doesn't jump.
  search(tree).onChange("");
  tree = logger.render();
  assert.deepEqual(tools(tree, "Log again"), icons);
  assert.equal(find(tree, "Button", "Scan"), undefined);

  // New food sits above the results' + buttons, so it doesn't look like one.
  assert.equal(find(tree, "IconButton", `Add ${food.name}`).props.icon, "add");
  assert.ok(!/add/.test(find(tree, "IconButton", "New food").props.icon));

  // Each icon still opens its screen in one tap.
  find(tree, "IconButton", "Quick add").props.onPress();
  const quick = logger.render().find((node) => node.type === "QuickAdd");
  assert.ok(quick);
  quick.props.close();
  find(logger.render(), "IconButton", "Scan barcode").props.onPress();
  assert.equal(
    logger.render().find((node) => node.type === "FoodEditor").props.initialMode,
    "barcode"
  );

  // A typed query alone is enough; with saved foods listed, the icons sit on their heading.
  diary.toggleFavorite(other);
  const typed = loggerHarness(diary, fastLog);
  tree = typed.render();
  assert.equal(tools(tree, "Saved foods"), null);
  assert.equal(tools(tree, "Log again"), null);
  search(tree).onChange("food");
  tree = typed.render();
  assert.deepEqual(tools(tree, "Searching…"), ["Scan barcode", "Quick add", "New food"]);
  search(tree).onChange("");
  tree = typed.render();
  assert.deepEqual(tools(tree, "Saved foods"), ["Scan barcode", "Quick add", "New food"]);
  assert.equal(tools(tree, "Log again"), null);
  logger.unmount();
  typed.unmount();
  sqlite.close();
});

test("compiled logger puts only the day, the search field and a heading above the first result", () => {
  const { diary, sqlite, fastLog } = diaryDatabase();
  diary.toggleFavorite(other);
  const logger = loggerHarness(diary, fastLog);
  const above = (tree) => {
    const children = flat(editor(tree).children);
    const first = children.findIndex((child) =>
      nodes(child).some((node) => node.props.accessibilityLabel?.startsWith("Adjust "))
    );
    assert.ok(first > 0, "a result is listed");
    return children.slice(0, first);
  };
  let tree = logger.render();
  find(tree, "IconButton", `Add ${food.name}`).props.onPress();
  tree = logger.render();
  // Before searching: shortcuts, the selection and saved foods come first.
  assert.ok(above(tree).length > 3);
  search(tree).onFocus();
  search(tree).onChange("oth");
  tree = logger.render();
  const before = above(tree);
  assert.equal(before.length, 3, before.map((node) => node.type).join(", "));
  assert.equal(before[1].type, "SearchInput");
  assert.deepEqual(tools(tree, "Searching…"), ["Scan barcode", "Quick add", "New food"]);
  assert.ok(find(tree, "Button", "Log 1 food"), "the selection can still be saved");
  sqlite.close();
});

test("compiled logger returns its list to the top when the search changes", () => {
  const { diary, sqlite, fastLog } = diaryDatabase();
  const logger = loggerHarness(diary, fastLog);
  const scrolls = [];
  let tree = logger.render();
  editor(tree).scrollRef.current = { scrollTo: (to) => scrolls.push(to) };
  logger.flush();
  scrolls.length = 0;
  logger.render();
  logger.flush();
  assert.deepEqual(scrolls, [], "a render alone doesn't move the list");
  search(tree).onChange("oth");
  tree = logger.render();
  logger.flush();
  assert.deepEqual(scrolls, [{ y: 0, animated: false }]);
  // Adding a result clears the search, and the field comes back into view for the next one.
  find(tree, "IconButton", `Add ${other.name}`).props.onPress();
  tree = logger.render();
  assert.equal(search(tree).value, "");
  logger.flush();
  assert.equal(scrolls.length, 2);
  logger.unmount();
  sqlite.close();
});

test("compiled logger folds the day and time panel away so the search field stays in view", () => {
  const { diary, sqlite, fastLog } = diaryDatabase();
  const logger = loggerHarness(diary, fastLog);
  const scrolls = [];
  const when = (tree) =>
    tree.find((node) => node.type === "Button" && node.props.icon === "time-outline");
  const panel = (tree) =>
    ["DateInput", "TimeField"].filter((type) => tree.some((node) => node.type === type));
  let tree = logger.render();
  editor(tree).scrollRef.current = { scrollTo: (to) => scrolls.push(to) };
  logger.flush();
  scrolls.length = 0;

  // Log something eaten earlier: open the panel and pick the time.
  when(tree).props.onPress();
  tree = logger.render();
  assert.deepEqual(panel(tree), ["DateInput", "TimeField"]);
  assert.equal(when(tree).props.accessibilityState.expanded, true);
  tree.find((node) => node.type === "TimeField").props.onChange("07:00");
  tree = logger.render();
  // Tapping the search closes it, and the list's top is the day row, the field and the results.
  search(tree).onFocus();
  assert.deepEqual(scrolls, [{ y: 0, animated: false }]);
  tree = logger.render();
  assert.deepEqual(panel(tree), []);
  assert.equal(when(tree).props.accessibilityState.expanded, false);
  assert.equal(flat(editor(tree).children)[1].type, "SearchInput");

  // Opened again mid-search, the next keystroke folds it.
  search(tree).onChange("oth");
  tree = logger.render();
  logger.flush();
  when(tree).props.onPress();
  tree = logger.render();
  assert.deepEqual(panel(tree), ["DateInput", "TimeField"]);
  search(tree).onChange("othe");
  tree = logger.render();
  logger.flush();
  assert.deepEqual(panel(tree), []);

  // Adding a result clears the search and brings the field back, not the panel.
  when(tree).props.onPress();
  tree = logger.render();
  find(tree, "IconButton", `Add ${other.name}`).props.onPress();
  tree = logger.render();
  assert.equal(search(tree).value, "");
  assert.deepEqual(panel(tree), []);
  scrolls.length = 0;
  logger.flush();
  assert.deepEqual(scrolls, [{ y: 0, animated: false }]);

  // The chosen time still applies.
  find(tree, "Button", "Log 1 food").props.onPress();
  const logged = diary.entriesForDay(metrics.localDay());
  assert.deepEqual(
    logged.map((entry) => [entry.food.name, entry.loggedTime]),
    [[other.name, "07:00"]]
  );
  logger.unmount();
  sqlite.close();
});

// Home and Library with their sheets and child screens as plain elements. Hooks keep their
// slots across renders; effects run only when a test runs them.
function screenHarness(diary, storeOverrides = {}, extraDependencies = {}) {
  const slots = [];
  // The latest render's effects.
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
  const element = (name) => ({ [name]: name });
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
      Platform: { OS: "ios" },
      Linking: {},
      AccessibilityInfo: {},
    },
    "expo-router": { router: {}, useIsFocused: () => true },
    "expo-camera": { CameraView: "CameraView", useCameraPermissions: () => [] },
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
      ...element("Editor"),
      ...element("Field"),
      ...element("Choices"),
      ...element("DateInput"),
      ...element("Screen"),
      ...element("ActionMenu"),
      ...element("DayPicker"),
      ...element("SwipeRow"),
      ErrorText: "Error",
    },
    "@/components/measurements/use-measurement-log": { useMeasurementLog: () => ({}) },
    "@/components/measurements/weight-form": element("WeightForm"),
    "@/lib/app-actions": load("src/lib/app-actions.ts"),
    "@/lib/diary": diary,
    "@/lib/metrics": metrics,
    "./metrics": metrics,
    "@/lib/nutrition": nutrition,
    "@/lib/food-time": foodTime,
    "@/lib/fast-log": {},
    "@/lib/food-catalog": {
      catalogManifest: JSON.parse(readFileSync("assets/food/manifest.json", "utf8")),
    },
    "@/lib/food-rank": rank,
    "@/lib/food-icons": foodIcons,
    "@/lib/local-ai": {},
    "@/lib/nutrition-label": {},
    "@/lib/weigh-in": { weighInDue: () => false },
    "./food-icon": element("FoodIcon"),
    "./food-editor": { FoodEditor: "FoodEditor", FoodRow: "FoodRow" },
    "./fast-logger": element("FastLogger"),
    "./home-check-in": element("HomeCheckIn"),
    "./weigh-in-card": element("WeighInCard"),
    "./week-strip": element("WeekStrip"),
    "./quick-log-bar": element("QuickLogBar"),
    "./meal-editor": element("MealEditor"),
    "./recipe-editor": element("RecipeEditor"),
    "./photo-logger": { PhotoLogger: "PhotoLogger", photoLoggingOffered: () => false },
    "./copy-day": { CopyDay: "CopyDay", MoveEntries: "MoveEntries" },
    "./amount-picker": element("AmountPicker"),
    "./time-field": element("TimeField"),
    "./photo-capture": element("PhotoCapture"),
    ...extraDependencies,
  };
  const store = {
    diaryLayout: "timeline",
    hideEmptyHours: true,
    language: "en",
    number: (n) => String(Math.round(n)),
    date: (day) => day,
    ...storeOverrides,
  };
  dependencies["@/lib/store"] = dependencies["./store"] = { useStore: () => store };
  dependencies["@/lib/nutrition-store"] = load("src/lib/nutrition-store.tsx", dependencies, true);
  return {
    context,
    effects,
    load: (file) => load(file, dependencies, true),
    render(Component, props) {
      cursor = 0;
      effects.length = 0;
      return nodes(Component(props));
    },
    /** Forgets every hook's state, as a fresh mount would. */
    remount() {
      slots.length = 0;
    },
  };
}
/** The icon a row leads with. */
const iconIn = (row) => {
  assert.ok(row, "row");
  return nodes(row.props.children).find((node) => node.type === "FoodIcon")?.props.icon;
};

test("food icons name the dish before what it's made of", () => {
  const { foodIcon, mealIcon } = foodIcons;
  const icon = (name, more = {}) =>
    foodIcon({ id: "usda:1", name, brand: "", source: "usda", ...more });
  const expect = (cases) => {
    for (const [name, expected] of Object.entries(cases)) assert.equal(icon(name), expected, name);
  };
  expect({
    pizza: "🍕",
    egg: "🥚",
    chicken: "🍗",
    beef: "🥩",
    steak: "🥩",
    fish: "🐟",
    salmon: "🐟",
    rice: "🍚",
    bread: "🍞",
    toast: "🍞",
    cheese: "🧀",
    milk: "🥛",
    coffee: "☕",
    apple: "🍎",
    banana: "🍌",
    salad: "🥗",
    lettuce: "🥗",
    cereal: "🥣",
    yogurt: "🥣",
    pasta: "🍝",
    burger: "🍔",
    fries: "🍟",
    soda: "🥤",
    beer: "🍺",
    cookie: "🍪",
    donut: "🍩",
    chocolate: "🍫",
    nuts: "🥜",
    potato: "🥔",
  });
  // The first match in the table's order: a dish wins over its ingredients.
  expect({
    "Chicken pizza": "🍕",
    "Egg noodles": "🍜",
    "Chicken noodle soup": "🍲",
    "Peanut butter cookie": "🍪",
    "Milk chocolate": "🍫",
    "Coffee cake": "🍰",
    "Chicken and rice": "🍗",
  });
  // A longer phrase takes its words with it.
  expect({
    "Crab cakes": "🦀",
    "Root beer": "🥤",
    "Chocolate milk": "🥛",
    "Peanut butter": "🥜",
    "Ice cream sandwich": "🍨",
    "Sweet potato fries": "🍟",
    "Hot dog bun": "🍞",
    "Tart cherry juice": "🧃",
  });
  // Whole words only, as written or singular, with accents, & and apostrophes read plainly.
  expect({
    Eggplant: "🍆",
    Pineapple: "🍍",
    Hamburger: "🍔",
    Popcorn: "🍿",
    Eggs: "🥚",
    Cherries: "🍒",
    Potatoes: "🥔",
    "Jalapeño poppers": "🌶️",
    "Crème brûlée": "🍮",
    "Mac & Cheese": "🍝",
    "Reese's Peanut Butter Cups": "🍫",
  });
  // Catalogs name the kind first; so do the owner's foods from MacroFactor.
  expect({
    "Milk, chocolate, fluid, commercial": "🥛",
    "Rolls, hamburger or hot dog": "🍞",
    "Oil, olive, salad or cooking": "🫒",
    "Cheddar Cheese, Natural": "🧀",
    Pepperoni: "🥓",
    "Turkey Breast Low Salt Prepackaged Or Deli Meat": "🍗",
    "Sourdough Bread": "🍞",
    "Hot & Spicy Chicken Wings Sections By Trader Joe's": "🍗",
    "Fat Free Ultra Filtered Milk By Fairlife": "🥛",
    "Frosted Mini-Wheats Bite Size By Kellogg's": "🥣",
    "Beef Jerky Teriyaki By Jack Link's": "🥩",
  });
  // The brand speaks only when the name doesn't.
  assert.equal(icon("Glazed", { brand: "Dunkin' Donuts" }), "🍩");
  assert.equal(icon("Pink salmon", { brand: "Chicken of the Sea" }), "🐟");
  // Quick adds are estimates whatever they're called; recipes and the rest fall back.
  assert.equal(foodIcon({ id: "quick:1-a", name: "Pizza", brand: "", source: "custom" }), "⚡");
  assert.equal(icon("Nana's special", { id: "recipe:1", source: "recipe" }), "🍲");
  assert.equal(icon("Protein pancakes", { id: "recipe:2", source: "recipe" }), "🥞");
  assert.equal(icon("Mystery item"), "🍽️");
  assert.equal(icon(""), "🍽️");
  assert.equal(mealIcon("Usual breakfast"), "🍽️");
  assert.equal(mealIcon("Burrito bowl"), "🌯");
});

test("compiled food icon is one small size and silent to screen readers", () => {
  const jsx = (type, props) => ({ type, props });
  const { FoodIcon } = load(
    "src/components/nutrition/food-icon.tsx",
    {
      "react/jsx-runtime": { jsx, jsxs: jsx },
      "react/compiler-runtime": {
        c: (size) => Array(size).fill(Symbol.for("react.memo_cache_sentinel")),
      },
      "@/components/system": { SystemText: "Text" },
    },
    true
  );
  const { type, props } = FoodIcon({ icon: "🍕" });
  assert.equal(type, "Text");
  assert.equal(props.children, "🍕");
  assert.equal(props.accessibilityElementsHidden, true);
  assert.equal(props.importantForAccessibility, "no");
  // Sized like the other icons, not with the text, so every row lines up.
  assert.equal(props.allowFontScaling, false);
  assert.match(props.className, /\bw-7\b/);
});

test("compiled logger leads Log again, search results, saved foods and saved meals with icons", () => {
  const { diary, sqlite, fastLog } = diaryDatabase();
  const day = nutrition.shiftDay(metrics.localDay(), -1);
  const pizza = { ...food, id: "custom:pizza", name: "Chicken pizza" };
  const yogurt = { ...food, id: "custom:yogurt", name: "Greek yogurt" };
  for (const item of [pizza, yogurt])
    diary.saveEntry({
      day,
      meal: "Lunch",
      loggedTime: "12:00",
      ...nutrition.portionItem(item, "g", 50),
    });
  diary.saveMeal("Burrito bowl", day, "Lunch");
  diary.toggleFavorite(yogurt);
  const logger = loggerHarness(diary, fastLog);
  let tree = logger.render();
  assert.equal(iconIn(find(tree, "Button", "Adjust Chicken pizza")), "🍕");
  assert.equal(iconIn(find(tree, "Button", `Adjust ${food.name}`)), "🍽️");
  assert.equal(iconIn(find(tree, "Button", "Adjust Burrito bowl")), "🌯");
  // The saved row's tile, not a list row's + button.
  assert.equal(iconIn(find(tree, "Button", "Add Greek yogurt")), "🥣");
  search(tree).onChange("pizza");
  tree = logger.render();
  assert.equal(iconIn(find(tree, "Button", "Adjust Chicken pizza")), "🍕");
  logger.unmount();
  sqlite.close();
});

test("compiled Home and Library rows lead with the food's icon", () => {
  const { diary, sqlite } = diaryDatabase();
  const today = metrics.localDay();
  const pizza = { ...food, id: "custom:pizza", name: "Chicken pizza" };
  const quick = {
    ...food,
    id: "quick:1-a",
    name: "Pizza slice",
    basis: "serving",
    sourceVersion: "quick-1",
    portions: [{ label: "1 entry", amount: 1 }],
  };
  diary.saveEntry({
    day: today,
    meal: "Lunch",
    loggedTime: "00:00",
    ...nutrition.portionItem(pizza, "g", 100),
  });
  diary.saveEntry({
    day: today,
    meal: "Lunch",
    loggedTime: "00:00",
    food: quick,
    amount: 1,
    portionLabel: "1 estimated entry",
  });
  const home = screenHarness(diary);
  const tree = home.render(home.load("src/components/nutrition/today-screen.tsx").TodayScreen);
  assert.equal(iconIn(find(tree, "Button", "Edit Chicken pizza")), "🍕");
  assert.equal(iconIn(find(tree, "Button", "Edit Pizza slice")), "⚡");

  diary.saveMeal("Burrito bowl", today, "Lunch");
  const library = screenHarness(diary);
  const shelf = library.render(
    library.load("src/components/nutrition/library-screen.tsx").LibraryScreen
  );
  const meal = shelf.find(
    (node) =>
      node.type === "Button" &&
      nodes(node.props.children).some((child) => child.props.children === "Burrito bowl")
  );
  assert.equal(iconIn(meal), "🌯");
  // Every food list in Library and the food finder is a FoodRow.
  assert.ok(shelf.some((node) => node.type === "FoodRow" && node.props.food.id === pizza.id));
  const rows = screenHarness(diary);
  const { FoodRow } = rows.load("src/components/nutrition/food-editor.tsx");
  const row = rows.render(FoodRow, { food: pizza, onPress: () => {} })[0];
  assert.equal(row.props.accessibilityLabel, "Log Chicken pizza");
  assert.equal(iconIn(row), "🍕");
  sqlite.close();
});

/** A food with round numbers per serving, logged once at a time of day. */
function logMacros(diary, day, time, name, [calories, protein, fat, carbs], meal = "Lunch") {
  return diary.saveEntry({
    day,
    meal,
    loggedTime: time,
    food: {
      ...food,
      id: `custom:${name}`,
      name,
      basis: "serving",
      nutrients: { calories, protein, carbs, fat, fiber: null, sodium: null },
      portions: [{ label: "1 serving", amount: 1 }],
    },
    amount: 1,
    portionLabel: "30 g",
  }).inserted[0];
}
/** A group's heading, whose first child is its title. */
const heading = (tree, title) =>
  tree.find(
    (node) =>
      node.type === "Text" &&
      node.props.accessibilityRole === "header" &&
      node.props.children?.[0] === title
  );
const logger = (tree) => tree.find((node) => node.type === "FastLogger");

test("compiled Home heads each hour with its totals and a + that logs into it", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2024, 0, 10, 13, 5, 0) });
  const { diary, sqlite } = diaryDatabase();
  const today = metrics.localDay();
  logMacros(diary, today, "12:00", "Pepperoni", [151, 6, 14, 0]);
  logMacros(diary, today, "12:20", "Cheddar", [85, 5, 7, 1]);
  logMacros(diary, today, "08:00", "Oats", [300, 10, 5, 50], "Breakfast");
  const clock = (time) => foodTime.formatClock(time, "en");
  const noon = clock("12:00");
  const home = screenHarness(diary);
  const { TodayScreen } = home.load("src/components/nutrition/today-screen.tsx");
  let tree = home.render(TodayScreen);
  const lunch = heading(tree, noon);
  assert.equal(lunch.props.children[1].props.children, " · 236 kcal · 11P 21F 1C");
  assert.equal(
    lunch.props.accessibilityLabel,
    `${noon}, 236 kcal, protein 11 g, fat 21 g, carbs 1 g`
  );
  assert.equal(heading(tree, clock("08:00")).props.children[1].props.children.at(-1), "C");
  // Only hours with food while empty hours are hidden, each with its own +.
  const pluses = (tree) =>
    tree.filter(
      (node) => node.type === "IconButton" && /^Log food at /.test(node.props.accessibilityLabel)
    );
  assert.equal(pluses(tree).length, 2);

  // The + logs into the hour, at its latest food so a forgotten item joins the meal.
  find(tree, "IconButton", `Log food at ${noon}`).props.onPress();
  tree = home.render(TodayScreen);
  assert.deepEqual(
    [logger(tree).props.initialDay, logger(tree).props.initialTime, logger(tree).props.initialMeal],
    [today, "12:20", "Lunch"]
  );
  logger(tree).props.close();
  // The hour's menu keeps the rest; adding lives on the +.
  assert.deepEqual(
    find(
      home.render(TodayScreen),
      "ActionMenu",
      `Options for ${noon}`
    ).props.sections[0].actions.map((action) => action.key),
    ["save", "move", "select"]
  );

  // Shown empty hours each have a + at o'clock, with no totals or menu.
  const all = screenHarness(diary, { hideEmptyHours: false });
  const Shown = all.load("src/components/nutrition/today-screen.tsx").TodayScreen;
  tree = all.render(Shown);
  assert.equal(pluses(tree).length, 24);
  const three = clock("15:00");
  assert.deepEqual(heading(tree, three).props.children, [three, false]);
  assert.equal(find(tree, "ActionMenu", `Options for ${three}`), undefined);
  find(tree, "IconButton", `Log food at ${three}`).props.onPress();
  tree = all.render(Shown);
  assert.deepEqual(
    [logger(tree).props.initialTime, logger(tree).props.initialMeal],
    ["15:00", "Lunch"]
  );

  // In the meal layout a + adds to that meal, eaten now.
  const classic = screenHarness(diary, { diaryLayout: "meals" });
  const Meals = classic.load("src/components/nutrition/today-screen.tsx").TodayScreen;
  tree = classic.render(Meals);
  assert.equal(
    heading(tree, "Breakfast").props.children[1].props.children,
    " · 300 kcal · 10P 5F 50C"
  );
  find(tree, "IconButton", "Log food to Breakfast").props.onPress();
  tree = classic.render(Meals);
  assert.deepEqual(
    [logger(tree).props.initialTime, logger(tree).props.initialMeal],
    ["13:05", "Breakfast"]
  );
  sqlite.close();
});

test("compiled Home rows put calories and macros between the name and the portion", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2024, 0, 10, 13, 5, 0) });
  const { diary, sqlite } = diaryDatabase();
  logMacros(diary, metrics.localDay(), "12:00", "Pepperoni", [151, 6, 14, 0]);
  const home = screenHarness(diary);
  const tree = home.render(home.load("src/components/nutrition/today-screen.tsx").TodayScreen);
  const row = find(tree, "Button", "Edit Pepperoni");
  // Nothing trails the text, so long names get the width.
  const [icon, text] = flat(row.props.children);
  assert.deepEqual(
    [icon.type, text.type, flat(row.props.children).length],
    ["FoodIcon", "View", 2]
  );
  const [name, numbers, portion] = flat(text.props.children);
  assert.equal(name.props.children, "Pepperoni");
  assert.deepEqual(numbers.props.children[0].props.children, ["151", " kcal"]);
  assert.equal(numbers.props.children[1], " · 6P 14F 0C");
  assert.deepEqual(portion.props.children, [`${foodTime.formatClock("12:00", "en")} · `, "30 g"]);
  sqlite.close();
});

test("compiled Home keeps the week strip at the top and opens the day it picks", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2024, 0, 10, 13, 5, 0) });
  const { diary, sqlite } = diaryDatabase();
  const today = metrics.localDay(),
    yesterday = nutrition.shiftDay(today, -1);
  const home = screenHarness(diary);
  const { TodayScreen } = home.load("src/components/nutrition/today-screen.tsx");
  const root = home.render(TodayScreen);
  const screen = root.find((node) => node.type === "Screen");
  const top = nodes(screen.props.header);
  const strip = top.find((node) => node.type === "WeekStrip");
  assert.ok(strip, "fixed with the header, not scrolled away");
  assert.equal(top.length, 1, "no date row above it");
  assert.deepEqual([strip.props.day, strip.props.today], [today, today]);
  strip.props.onChange(yesterday);
  const tree = home.render(TodayScreen);
  assert.equal(tree.find((node) => node.type === "WeekStrip").props.day, yesterday);
  assert.ok(find(tree, "Button", `Edit ${food.name}`), "yesterday's food is listed");
  sqlite.close();
});

/** The compiled week strip against the real diary, with a swipe that tests can finish. */
function stripHarness(diary, db, firstWeekday = 2) {
  const insights = load("src/lib/insights.ts", {
    "@/db": { db, ...schema },
    "./coaching-store": {},
    "./metrics": metrics,
    "./nutrition": nutrition,
    "./program": {},
  });
  const pan = () => {
    const gesture = { handlers: {} };
    for (const name of ["runOnJS", "activeOffsetX", "failOffsetY"]) gesture[name] = () => gesture;
    gesture.onEnd = (handler) => {
      gesture.handlers.onEnd = handler;
      return gesture;
    };
    return gesture;
  };
  const harness = screenHarness(
    diary,
    {},
    {
      "react-native": { View: "View", Pressable: "Pressable" },
      "expo-localization": { useCalendars: () => [{ firstWeekday }] },
      "react-native-gesture-handler": { Gesture: { Pan: pan }, GestureDetector: "GestureDetector" },
      "@/lib/insights": insights,
      "./amount-picker": { Ring: "Ring" },
    }
  );
  const { WeekStrip } = harness.load("src/components/nutrition/week-strip.tsx");
  return { harness, render: (props) => harness.render(WeekStrip, props) };
}
const cells = (tree) => tree.filter((node) => node.type === "Pressable");
const swipe = (tree, translationX, velocityX = 0, success = true) =>
  tree
    .find((node) => node.type === "GestureDetector")
    .props.gesture.handlers.onEnd({ translationX, velocityX }, success);

test("compiled week strip rings each day's calories against its target", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2024, 0, 10, 12, 0, 0) });
  // The harness logs 180 kcal yesterday, Jan 9.
  const { diary, db, sqlite } = diaryDatabase();
  diary.saveTargets("2024-01-01", { calories: 2000, protein: 100, carbs: 250, fat: 60 });
  logMacros(diary, "2024-01-07", "08:00", "Sunday", [1500, 0, 0, 0]);
  logMacros(diary, "2024-01-08", "08:00", "Monday", [1000, 0, 0, 0]);
  logMacros(diary, "2024-01-09", "12:00", "Tuesday", [2320, 0, 0, 0]);
  logMacros(diary, "2024-01-10", "08:00", "Today", [500, 0, 0, 0]);
  const strip = stripHarness(diary, db);
  const picked = [];
  const props = { day: "2024-01-10", today: "2024-01-10", onChange: (day) => picked.push(day) };
  let tree = strip.render(props);
  // Monday first where the calendar says so; days ahead can't be opened.
  assert.deepEqual(
    cells(tree).map((cell) => cell.props.accessibilityLabel),
    [
      "Mon, Jan 8: 1000 of 2000 kcal",
      "Tue, Jan 9: 2500 of 2000 kcal",
      "Wed, Jan 10, today: 500 of 2000 kcal",
      "Thu, Jan 11: upcoming",
      "Fri, Jan 12: upcoming",
      "Sat, Jan 13: upcoming",
      "Sun, Jan 14: upcoming",
    ]
  );
  const rings = tree.filter((node) => node.type === "Ring");
  assert.deepEqual(
    rings.map((ring) => ring.props.value),
    [0.5, 1.25, 0.25, 0, 0, 0, 0]
  );
  assert.deepEqual(
    rings.map((ring) => ring.props.children.props.children),
    [8, 9, 10, 11, 12, 13, 14]
  );
  assert.equal(flat(cells(tree)[0].props.children)[0].props.children, "M");
  assert.deepEqual(
    cells(tree).map((cell) => [cell.props.accessibilityState.selected, !!cell.props.disabled]),
    [
      [false, false],
      [false, false],
      [true, false],
      [false, true],
      [false, true],
      [false, true],
      [false, true],
    ]
  );
  cells(tree)[1].props.onPress();
  assert.deepEqual(picked, ["2024-01-09"]);

  // Sunday first where the calendar says so.
  const sunday = stripHarness(diary, db, 1);
  tree = sunday.render({ ...props, day: "2024-01-07" });
  assert.equal(cells(tree)[0].props.accessibilityLabel, "Sun, Jan 7: 1500 of 2000 kcal");
  assert.equal(cells(tree).at(-1).props.accessibilityLabel, "Sat, Jan 13: upcoming");
  // Days without a target show calories alone and an empty ring.
  const early = stripHarness(diary, db);
  tree = early.render({ ...props, day: "2023-12-27" });
  assert.equal(cells(tree)[0].props.accessibilityLabel, "Mon, Dec 25: 0 kcal");
  assert.equal(tree.find((node) => node.type === "Ring").props.value, 0);
  sqlite.close();
});

test("compiled week strip swipes a week at a time, stopping at today, and reads once per week", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2024, 0, 10, 12, 0, 0) });
  const { diary, db, sqlite } = diaryDatabase();
  const strip = stripHarness(diary, db);
  const picked = [];
  const props = { day: "2024-01-10", today: "2024-01-10", onChange: (day) => picked.push(day) };
  let tree = strip.render(props);
  // No week after this one; short, slow or cancelled drags do nothing.
  swipe(tree, -80);
  swipe(tree, 10, 50);
  swipe(tree, 80, 0, false);
  assert.deepEqual(picked, []);
  // Right goes back a week to the same weekday, a quick flick too.
  swipe(tree, 80);
  swipe(tree, -5, 900);
  assert.deepEqual(picked.splice(0), ["2024-01-03", "2024-01-03"]);
  // Left from last week keeps the weekday, or stops at today.
  tree = strip.render({ ...props, day: "2024-01-02" });
  swipe(tree, -80);
  tree = strip.render({ ...props, day: "2024-01-05" });
  swipe(tree, -80);
  assert.deepEqual(picked.splice(0), ["2024-01-09", "2024-01-10"]);
  // Screen readers move weeks from any day.
  const actions = cells(tree)[3].props;
  assert.deepEqual(
    actions.accessibilityActions.map((action) => action.label),
    ["Previous week", "Next week"]
  );
  actions.onAccessibilityAction({ nativeEvent: { actionName: "previous" } });
  actions.onAccessibilityAction({ nativeEvent: { actionName: "next" } });
  assert.deepEqual(picked.splice(0), ["2023-12-29", "2024-01-10"]);

  // Another day in the same week reuses the read; a write refreshes it.
  let reads = 0;
  const prepare = sqlite.prepare;
  sqlite.prepare = function (sql) {
    reads++;
    return prepare.call(this, sql);
  };
  strip.render({ ...props, day: "2024-01-03" });
  assert.equal(reads, 0);
  logMacros(diary, "2024-01-04", "08:00", "Thursday", [700, 0, 0, 0]);
  strip.harness.context.refresh();
  reads = 0;
  tree = strip.render({ ...props, day: "2024-01-03" });
  assert.ok(reads > 0);
  assert.equal(cells(tree)[3].props.accessibilityLabel, "Thu, Jan 4: 700 kcal");
  sqlite.close();
});

/** The compiled quick-log bar with a keyboard, app state and router that tests can drive. */
function barHarness({ os = "ios", keyboardUp = false, status = null } = {}) {
  const keyboard = { visible: keyboardUp, listeners: {} };
  const appState = [];
  const routes = [];
  const reads = { count: 0 };
  const actions = load("src/lib/app-actions.ts");
  const harness = screenHarness(
    {},
    {},
    {
      "react-native": {
        View: "View",
        Platform: { OS: os },
        AppState: {
          addEventListener: (_, listener) => {
            appState.push(listener);
            return { remove: () => appState.splice(appState.indexOf(listener), 1) };
          },
        },
        Keyboard: {
          isVisible: () => keyboard.visible,
          addListener: (name, listener) => {
            keyboard.listeners[name] = listener;
            return { remove: () => delete keyboard.listeners[name] };
          },
        },
      },
      "expo-router": { router: { navigate: (href) => routes.push(href) } },
      "@/lib/app-actions": actions,
      "@/lib/local-ai": {
        modelStatus: async () => {
          reads.count++;
          return status;
        },
      },
      "./photo-logger": {
        photoLoggingOffered: (value) =>
          !!value && (value.state !== "unavailable" || value.reason === "disabled"),
      },
      "./ai-mark": { AiMark: "AiMark" },
    }
  );
  const bar = harness.load("src/components/nutrition/quick-log-bar.tsx");
  return { harness, bar, keyboard, appState, routes, reads, actions };
}
const available = { state: "available", engine: "apple", vision: true };

test("compiled quick-log bar searches, scans, and offers AI only where the model runs", () => {
  const { harness, bar, keyboard } = barHarness();
  const pressed = [];
  const render = (props) =>
    harness.render(bar.QuickLogBar, {
      ai: null,
      onAction: (action) => pressed.push(action),
      ...props,
    });
  let tree = render();
  harness.effects.forEach((effect) => effect());
  // The pill names what it does; the primary button scans.
  const pill = find(tree, "Button", "Search for a food");
  assert.equal(
    nodes(pill.props.children).find((node) => node.type === "Text").props.children,
    "Search for a food"
  );
  assert.equal(nodes(pill.props.children).filter((node) => node.type === "IconButton").length, 0);
  pill.props.onPress();
  const scan = find(tree, "IconButton", "Scan barcode");
  assert.deepEqual([scan.props.icon, scan.props.variant], ["barcode-outline", "primary"]);
  scan.props.onPress();
  assert.equal(find(tree, "IconButton", "Log food"), undefined, "search already opens the logger");
  assert.deepEqual(pressed.splice(0), ["search", "scan"]);
  const mark = (tree) => tree.find((node) => node.props?.icon?.type === "AiMark");
  assert.equal(mark(tree), undefined, "no model, no AI mark");
  tree = render({ ai: { state: "unavailable", engine: "none", vision: false, reason: "device" } });
  assert.equal(mark(tree), undefined);
  assert.ok(find(tree, "IconButton", "Scan barcode"));

  // A photo where the model sees, a description where it only reads; turned off, it explains.
  tree = render({ ai: available });
  find(tree, "IconButton", "Log a meal from a photo").props.onPress();
  tree = render({ ai: { ...available, vision: false } });
  find(tree, "IconButton", "Describe a meal to log it").props.onPress();
  tree = render({
    ai: { state: "unavailable", engine: "apple", vision: true, reason: "disabled" },
  });
  assert.ok(find(tree, "IconButton", "Log a meal from a photo"));
  assert.deepEqual(pressed.splice(0), ["photo", "photo"]);
  // The button wears the mark of the model on this phone, Apple Intelligence or Gemini.
  assert.equal(find(tree, "IconButton", "Log a meal from a photo").props.icon.type, "AiMark");

  // Another day is named on the pill.
  tree = render({ label: "Log to Yesterday" });
  assert.ok(find(tree, "Button", "Log to Yesterday"));
  assert.ok(find(tree, "IconButton", "Scan barcode"));

  // The keyboard hides it, so it never sits over the field being typed in.
  keyboard.listeners.keyboardWillShow();
  assert.deepEqual(render(), []);
  keyboard.listeners.keyboardWillHide();
  assert.ok(find(render(), "Button", "Search for a food"));

  // Android lifts it above the keyboard, so it listens once the keyboard is up there too.
  const android = barHarness({ os: "android", keyboardUp: true });
  assert.deepEqual(
    android.harness.render(android.bar.QuickLogBar, { ai: null, onAction() {} }),
    []
  );
  android.harness.effects.forEach((effect) => effect());
  assert.deepEqual(Object.keys(android.keyboard.listeners).sort(), [
    "keyboardDidHide",
    "keyboardDidShow",
  ]);
});

test("the AI mark is Apple Intelligence on iOS and Gemini on Android", () => {
  const jsx = (type, props) => ({ type, props });
  const mark = (os) =>
    load("src/components/nutrition/ai-mark.tsx", {
      "react/jsx-runtime": { jsx, jsxs: jsx },
      "react-native": { Platform: { OS: os } },
      "expo-symbols": { SymbolView: "SymbolView" },
      "heroui-native": { useThemeColor: (color) => `theme:${color}` },
      "react-native-svg": {
        __esModule: true,
        default: "Svg",
        Defs: "Defs",
        LinearGradient: "LinearGradient",
        Path: "Path",
        Stop: "Stop",
      },
    }).AiMark;
  const apple = mark("ios")({ size: 22 });
  assert.equal(apple.type, "SymbolView");
  assert.deepEqual(apple.props, {
    name: "apple.intelligence",
    size: 22,
    tintColor: "theme:foreground",
  });
  const gemini = mark("android")({ size: 22 });
  const svg = gemini.type({ size: 22 });
  assert.equal(svg.type, "Svg");
  assert.deepEqual([svg.props.width, svg.props.height], [22, 22]);
});

test("compiled tab bar opens Today's sheets through the app action, with the model's status", async () => {
  const { harness, bar, appState, routes, reads, actions } = barHarness({ status: available });
  const heard = [];
  const stop = actions.subscribeAppActions(() => heard.push(actions.pendingAppAction()));
  const render = () => harness.render(bar.TabQuickLogBar);
  let inner = render()[0];
  assert.equal(inner.type, bar.QuickLogBar);
  assert.equal(inner.props.ai, null);
  const cleanups = harness.effects.map((effect) => effect());
  await new Promise(setImmediate);
  inner = render()[0];
  assert.equal(inner.props.ai, available);

  // Each button lands on Today first, where Home opens the sheet for today.
  for (const action of ["log", "search", "scan", "photo"]) inner.props.onAction(action);
  assert.deepEqual(routes, ["/", "/", "/", "/"]);
  assert.deepEqual(heard, ["log", "search", "scan", "photo"]);
  assert.equal(actions.takeAppAction(), "photo");
  stop();

  // Coming back to the app reads the status again; the other tab starts from it.
  assert.equal(reads.count, 1);
  appState.forEach((listener) => listener("background"));
  appState.forEach((listener) => listener("active"));
  assert.equal(reads.count, 2);
  harness.remount();
  assert.equal(render()[0].props.ai, available, "no reflow when the AI mark is known");
  cleanups.forEach((cleanup) => cleanup?.());
  assert.equal(appState.length, 0);
});

test("compiled Home pins the quick-log bar above the tab bar in place of its Log row", () => {
  const { diary, sqlite } = diaryDatabase();
  const today = metrics.localDay(),
    yesterday = nutrition.shiftDay(today, -1);
  const home = screenHarness(diary);
  const { TodayScreen } = home.load("src/components/nutrition/today-screen.tsx");
  const render = () => home.render(TodayScreen);
  const screen = (tree) => tree.find((node) => node.type === "Screen");
  const bar = (tree) =>
    nodes(screen(tree).props.footer).find((node) => node.type === "QuickLogBar");
  let tree = render();
  // In the floating footer, not the scrolling page, and nothing else starts the logger there.
  assert.ok(bar(tree));
  assert.equal(
    nodes(screen(tree).props.children).find((node) => node.type === "QuickLogBar"),
    undefined
  );
  for (const label of ["Log food", "Scan", "Photo", "Describe"])
    assert.equal(find(tree, "Button", label), undefined, label);
  assert.equal(bar(tree).props.label, undefined);
  assert.equal(bar(tree).props.ai, null);

  bar(tree).props.onAction("search");
  tree = render();
  assert.deepEqual(
    [logger(tree).props.start, logger(tree).props.initialDay],
    ["typing", today],
    "the keyboard is up in the logger"
  );
  logger(tree).props.close();
  // A fresh day hides its empty hours, so no hour offers a +.
  tree = render();
  assert.ok(tree.some((node) => node.props?.children === "Nothing logged yet."));
  assert.equal(
    tree.find((node) => /^Log food (at|to) /.test(node.props?.accessibilityLabel ?? "")),
    undefined
  );
  bar(render()).props.onAction("scan");
  tree = render();
  assert.equal(logger(tree).props.start, "barcode");
  logger(tree).props.close();
  bar(render()).props.onAction("photo");
  tree = render();
  assert.equal(tree.find((node) => node.type === "PhotoLogger").props.initialDay, today);
  tree.find((node) => node.type === "PhotoLogger").props.close();

  // On another day the pill says so, and logs there.
  render()
    .find((node) => node.type === "WeekStrip")
    .props.onChange(yesterday);
  tree = render();
  assert.equal(bar(tree).props.label, "Log to Yesterday");
  bar(tree).props.onAction("search");
  assert.equal(logger(render()).props.initialDay, yesterday);
  logger(render()).props.close();
  bar(render()).props.onAction("scan");
  assert.deepEqual(
    [logger(render()).props.start, logger(render()).props.initialDay],
    ["barcode", yesterday]
  );
  logger(render()).props.close();

  // Choosing foods puts the selection bar in its place; Cancel brings it back.
  find(render(), "Button", `Edit ${food.name}`).props.onLongPress();
  tree = render();
  assert.equal(bar(tree), undefined);
  assert.ok(find(tree, "Button", "Cancel"));
  find(tree, "Button", "Cancel").props.onPress();
  assert.ok(bar(render()));
  sqlite.close();
});

test("compiled Home opens the logger ready to type from a search link", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: new Date(2024, 0, 10, 12, 0, 10) });
  const { diary, sqlite } = diaryDatabase();
  const actions = load("src/lib/app-actions.ts");
  assert.equal(actions.parseAppAction("macrotrack://search"), "search");
  assert.equal(actions.parseAppAction("macrotrack://search/?from=shortcut"), "search");
  const home = screenHarness(
    diary,
    {},
    {
      "@/lib/app-actions": actions,
      "@/lib/food-catalog": { openCatalogs: async () => {} },
      "@/lib/local-ai": { modelStatus: async () => available, prewarmModel: () => {} },
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
  const { TodayScreen } = home.load("src/components/nutrition/today-screen.tsx");
  // From Progress or Plan: the bar asks before Home has taken anything.
  actions.requestAppAction("search");
  home.render(TodayScreen);
  const stop = home.effects[0]();
  t.mock.timers.tick(1);
  const tree = home.render(TodayScreen);
  assert.deepEqual(
    [logger(tree).props.start, logger(tree).props.initialDay],
    ["typing", metrics.localDay()]
  );
  assert.equal(actions.pendingAppAction(), null);
  stop();
  sqlite.close();
  t.mock.timers.reset();
});

test("compiled logger opened from the bar has the search focused and the shortcuts as icons", () => {
  const { diary, sqlite, fastLog } = diaryDatabase();
  const typing = loggerHarness(diary, fastLog, { start: "typing" });
  let tree = typing.render();
  assert.equal(search(tree).autoFocus, true);
  assert.equal(find(tree, "Button", "Scan"), undefined, "results get the room at once");
  assert.deepEqual(tools(tree, "Log again"), ["Scan barcode", "Quick add", "New food"]);
  // Focused once: coming back to the list from a portion doesn't raise the keyboard again.
  search(tree).onFocus();
  tree = typing.render();
  assert.equal(search(tree).autoFocus, false);
  find(tree, "Button", `Adjust ${food.name}`).props.onPress();
  editor(typing.render()).close();
  assert.equal(search(typing.render()).autoFocus, false);

  // Log food, an hour's + and links still open on the list, keyboard down.
  const list = loggerHarness(diary, fastLog);
  tree = list.render();
  assert.equal(search(tree).autoFocus, false);
  assert.ok(find(tree, "Button", "Scan"));
  typing.unmount();
  list.unmount();
  sqlite.close();
});

/** Screen from ui.tsx, uncompiled, with a footer the tab may provide. */
function loadScreen(provided) {
  const react = {
    createContext: (value) => ({ value }),
    useContext: (context) => (context === ui.ScreenFooter ? provided : context.value),
    useId: () => "id",
    useRef: (current) => ({ current }),
    useState: (initial) => [initial, () => {}],
  };
  const ui = load("src/components/ui.tsx", {
    react,
    "react/jsx-runtime": {
      jsx: (type, props) => ({ type, props }),
      jsxs: (type, props) => ({ type, props }),
    },
    "react-native": {
      Platform: { OS: "ios" },
      ScrollView: "ScrollView",
      View: "View",
      useWindowDimensions: () => ({ width: 390 }),
    },
    "react-native-safe-area-context": {
      SafeAreaView: "SafeAreaView",
      useSafeAreaInsets: () => ({ top: 47, bottom: 83 }),
    },
    uniwind: { withUniwind: (component) => component },
    "heroui-native": {},
    "heroui-native/portal": {},
    "heroui-native-pro": {},
    "react-native-gesture-handler": {},
    "react-native-gesture-handler/ReanimatedSwipeable": { __esModule: true },
    "./system": { SystemText: "Text" },
    "@/lib/app-actions": load("src/lib/app-actions.ts"),
    "@/lib/metrics": metrics,
    "@/lib/store": { useStore: () => ({ t: (key) => key }) },
  });
  return ui;
}

test("Screen floats a tab's footer above the tab bar and keeps the page clear of it", () => {
  const bar = { type: "TabQuickLogBar", props: {} };
  const render = (provided, footer) =>
    nodes(loadScreen(provided).Screen({ title: "Plan", children: "Plan", footer }));
  const padding = (tree) =>
    tree.find((node) => node.type === "ScrollView").props.contentContainerStyle.paddingBottom;
  const floating = (tree) => {
    const view = tree.find(
      (node) => node.type === "View" && node.props.style?.bottom !== undefined
    );
    return view && { bottom: view.props.style.bottom, content: view.props.children.props.children };
  };
  let tree = render(null);
  assert.equal(padding(tree), 123, "clear of the floating tab bar");
  assert.equal(floating(tree), undefined);
  tree = render(bar);
  // Above the floating tab bar, which is part of the safe area on iOS, with room to scroll past.
  assert.deepEqual(floating(tree), { bottom: 83 + 8, content: bar });
  assert.equal(padding(tree), 160);
  // A screen's own footer, such as Today's, takes the place.
  const own = { type: "Undo", props: {} };
  assert.equal(floating(render(bar, own)).content, own);
});

test("Progress and Plan mount the tab bar; Library and Settings don't", () => {
  const jsx = (type, props) => ({ type, props });
  const route = (file, screen) =>
    load(file, {
      "react/jsx-runtime": { jsx, jsxs: jsx },
      "@/components/deferred-tab": { DeferredTab: "DeferredTab" },
      "@/components/nutrition/quick-log-bar": { TabQuickLogBar: "TabQuickLogBar" },
      "@/components/ui": { ScreenFooter: "ScreenFooter" },
      [screen[0]]: { [screen[1]]: screen[1] },
    }).default();
  for (const [file, screen] of [
    ["src/app/(tabs)/progress.tsx", ["@/components/progress/progress-screen", "ProgressScreen"]],
    ["src/app/(tabs)/plan.tsx", ["@/components/nutrition/plan-screen", "PlanScreen"]],
  ]) {
    const tab = route(file, screen);
    assert.equal(tab.type, "DeferredTab", file);
    const provider = tab.props.children;
    assert.equal(provider.type, "ScreenFooter", file);
    assert.equal(provider.props.value.type, "TabQuickLogBar", file);
    assert.equal(provider.props.children.type, screen[1], file);
  }
  for (const [file, screen] of [
    ["src/app/(tabs)/library.tsx", ["@/components/nutrition/library-screen", "LibraryScreen"]],
    ["src/app/(tabs)/settings.tsx", ["@/components/screens/settings-screen", "SettingsScreen"]],
  ])
    assert.ok(!nodes(route(file, screen)).some((node) => node.type === "ScreenFooter"), file);
});
