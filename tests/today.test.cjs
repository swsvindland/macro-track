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
  return { sqlite, diary, fastLog };
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
  return [tree, ...nodes(tree.props?.children), ...nodes(tree.props?.footer)];
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
