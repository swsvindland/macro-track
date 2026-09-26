const { test } = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const ts = require("typescript");
const { drizzle } = require(
  path.join(path.dirname(require.resolve("drizzle-orm/expo-sqlite")), "driver.cjs")
);

/** Transpiles production TS; `compile` runs React Compiler first, as the app build does. */
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
const schema = load("src/db/schema.ts");

// Mirrors expo-sqlite: executeSync steps a statement once and reads later rows on demand, and
// Drizzle never finalizes, so a statement whose rows go unread stays open on the connection.
function expoClient(sqlite) {
  const statements = [];
  const execute = (sql, params, arrays) => {
    const statement = sqlite.prepare(sql);
    statements.push(statement);
    if (!statement.columns().length) {
      const result = statement.run(...params);
      return { changes: result.changes, lastInsertRowId: result.lastInsertRowid };
    }
    statement.setReturnArrays(arrays);
    const rows = statement.iterate(...params);
    const first = rows.next();
    return {
      getFirstSync: () => (first.done ? null : first.value),
      getAllSync: () => (first.done ? [] : [first.value, ...rows]),
    };
  };
  return {
    prepareSync: (sql) => ({
      executeSync: (params) => execute(sql, params, false),
      executeForRawResultSync: (params) => execute(sql, params, true),
    }),
  };
}

/** A migrated database file in WAL mode, as the app opens it. */
function fileDatabase(t) {
  const folder = mkdtempSync(path.join(tmpdir(), "macro-track-"));
  const file = path.join(folder, "macro_track.db");
  const sqlite = new DatabaseSync(file);
  sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  for (const migration of readdirSync("drizzle")
    .filter((name) => name.endsWith(".sql"))
    .sort())
    sqlite.exec(readFileSync(`drizzle/${migration}`, "utf8"));
  const db = drizzle(expoClient(sqlite), { schema });
  const ownership = load("src/lib/data-ownership.ts", { "@/db": { db, ...schema } });
  t.after(() => {
    sqlite.close();
    rmSync(folder, { recursive: true, force: true });
  });
  return { sqlite, db, ownership, file };
}

const nutrients = { calories: 100, protein: 5, carbs: 10, fat: 4, fiber: null, sodium: 50 };
const entry = (day, loggedTime, createdAt, name) => ({
  day,
  meal: "Snack",
  loggedTime,
  food: {
    id: `custom:${name}`,
    name,
    brand: "",
    barcode: null,
    source: "custom",
    sourceVersion: "1",
    basis: "g",
    nutrients,
    portions: [],
  },
  amount: 100,
  portionLabel: "100 g",
  nutrients,
  createdAt,
});

test("diary CSV follows eating time within each day and gives fasting days a zero row", (t) => {
  const { db, ownership } = fileDatabase(t);
  db.insert(schema.foodEntries)
    .values([
      entry("2024-01-02", "19:00", 1, "Dinner logged first"),
      entry("2024-01-02", "08:00", 2, "Oats"),
      entry("2024-01-01", "12:00", 3, "Soup"),
      entry("2024-01-01", null, 4, "Untimed older entry"),
      entry("2024-01-01", "12:00", 5, "Bread"),
    ])
    .run();
  db.insert(schema.diaryDays)
    .values([
      { day: "2023-12-31", status: "fasting" },
      { day: "2024-01-02", status: "complete" },
      { day: "2024-01-03", status: "fasting" },
    ])
    .run();
  const lines = ownership
    .exportDiaryCsv()
    .replace(/^\uFEFF/, "")
    .trimEnd()
    .split("\r\n");
  const rows = lines.map((line) => JSON.parse(`[${line}]`));
  assert.ok(rows.every((row) => row.length === rows[0].length));
  assert.deepEqual(
    rows.slice(1).map((row) => [row[0], row[2], row[3], row[14]]),
    [
      ["2023-12-31", "", "", "fasting"],
      ["2024-01-01", "", "Untimed older entry", "in-progress"],
      ["2024-01-01", "12:00", "Soup", "in-progress"],
      ["2024-01-01", "12:00", "Bread", "in-progress"],
      ["2024-01-02", "08:00", "Oats", "complete"],
      ["2024-01-02", "19:00", "Dinner logged first", "complete"],
      ["2024-01-03", "", "", "fasting"],
    ]
  );
  assert.equal(
    lines.at(-1),
    '"2024-01-03","","","","","","","","0","0","0","0","0","0","fasting","",""'
  );
});

function captureWarnings(run) {
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    run();
  } finally {
    console.warn = warn;
  }
  return warnings;
}

test("erase overwrites deleted rows, vacuums and empties the write-ahead log", (t) => {
  const { sqlite, db, ownership, file } = fileDatabase(t);
  const secret = "Pastrami from the corner deli";
  // Enough rows to span pages, so deleting them frees pages for VACUUM to drop.
  db.insert(schema.foodEntries)
    .values(Array.from({ length: 300 }, (_, i) => entry("2024-01-01", "12:00", i, secret)))
    .run();
  db.insert(schema.weightEntries)
    .values({ measuredAt: "2024-01-01T07:00:00.000Z", weightKg: 81.2 })
    .run();
  const stored = () =>
    [file, `${file}-wal`]
      .filter((name) => existsSync(name))
      .some((name) => readFileSync(name).includes(secret));
  assert.ok(stored(), "the entries are on disk before erasing");
  const pages = () => sqlite.prepare("PRAGMA page_count").get().page_count;
  const before = pages();

  assert.deepEqual(
    captureWarnings(() => ownership.erasePersonalRecords()),
    []
  );
  assert.equal(stored(), false);
  assert.equal(readFileSync(`${file}-wal`).length, 0);
  assert.equal(sqlite.prepare("PRAGMA freelist_count").get().freelist_count, 0);
  assert.ok(pages() < before);
  assert.equal(sqlite.prepare("PRAGMA secure_delete").get().secure_delete, 1);
  assert.equal(db.select().from(schema.foodEntries).all().length, 0);
  assert.equal(
    db
      .select()
      .from(schema.preferences)
      .all()
      .find((row) => row.key === "healthSyncEnabled").value,
    "false"
  );
});

function erasedWithReadOpen(t, query) {
  const { sqlite, db, ownership, file } = fileDatabase(t);
  const secret = "Pastrami from the corner deli";
  db.insert(schema.foodEntries)
    .values(entry("2024-01-01", "12:00", 1, secret))
    .run();
  sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  assert.ok(readFileSync(file).includes(secret));
  // A read left open elsewhere on the connection makes VACUUM refuse to run.
  const open = sqlite.prepare(query).iterate();
  open.next();
  const warnings = captureWarnings(() => ownership.erasePersonalRecords());
  assert.equal(db.select().from(schema.foodEntries).all().length, 0);
  const onDisk = () => readFileSync(file).includes(secret);
  return { sqlite, file, open, warnings, onDisk };
}

test("erase still completes when the database can't be compacted afterwards", (t) => {
  const { file, open, warnings, onDisk } = erasedWithReadOpen(t, "SELECT 1 UNION ALL SELECT 2");
  assert.equal(warnings.length, 1);
  // Secure delete has already overwritten the rows, and the checkpoint moved that to disk.
  assert.equal(onDisk(), false);
  assert.equal(readFileSync(`${file}-wal`).length, 0);
  open.return();
});

test("erase still completes when a table read blocks compacting and checkpointing", (t) => {
  const { sqlite, open, warnings, onDisk } = erasedWithReadOpen(t, "SELECT id FROM food_entries");
  assert.equal(warnings.length, 2);
  // The overwritten pages wait in the write-ahead log for the next checkpoint.
  open.return();
  sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  assert.equal(onDisk(), false);
});

// Coaching reviews, check-ins and the weigh-ins behind them.
const nutrition = load("src/lib/nutrition.ts");
const metrics = load("src/lib/metrics.ts");
const foodTime = load("src/lib/food-time.ts", { "./nutrition": nutrition });
const coaching = load("src/lib/coaching.ts", { "./nutrition": nutrition });
const program = load("src/lib/program.ts", { "./nutrition": nutrition, "./metrics": metrics });

const profile = {
  age: 30,
  heightCm: 180,
  weightKg: 80,
  formula: "male",
  activity: "moderate",
  protein: 1.6,
  diet: "balanced",
  targetWeightKg: 75,
  checkInDay: 4,
};
const targets = { calories: 2200, protein: 150, carbs: 250, fat: 66.667 };
const food = {
  id: "custom:usual-day",
  name: "Usual day",
  brand: "",
  barcode: null,
  source: "custom",
  sourceVersion: "1",
  basis: "serving",
  nutrients: { calories: 2400, protein: 150, carbs: 250, fat: 80, fiber: null, sodium: null },
  portions: [{ label: "1 serving", amount: 1 }],
};

/** A migrated in-memory database with the coaching modules on a clock the test sets. */
function coachingDatabase(today) {
  const sqlite = new DatabaseSync(":memory:");
  for (const migration of readdirSync("drizzle")
    .filter((name) => name.endsWith(".sql"))
    .sort())
    sqlite.exec(readFileSync(`drizzle/${migration}`, "utf8"));
  const execute = (sql, params, arrays) => {
    const statement = sqlite.prepare(sql);
    if (!statement.columns().length) {
      const result = statement.run(...params);
      return { changes: result.changes, lastInsertRowId: result.lastInsertRowid };
    }
    statement.setReturnArrays(arrays);
    const rows = statement.all(...params);
    return { getAllSync: () => rows, getFirstSync: () => rows[0] ?? null };
  };
  const db = drizzle(
    {
      prepareSync: (sql) => ({
        executeSync: (params) => execute(sql, params, false),
        executeForRawResultSync: (params) => execute(sql, params, true),
      }),
    },
    { schema }
  );
  const clock = { today };
  const fakeMetrics = {
    ...metrics,
    localDay: (...args) => (args.length ? metrics.localDay(...args) : clock.today),
  };
  const dbModule = { db, ...schema };
  const diary = load("src/lib/diary.ts", {
    "@/db": dbModule,
    "./metrics": fakeMetrics,
    "./nutrition": nutrition,
    "./food-time": foodTime,
  });
  const store = load("src/lib/coaching-store.ts", {
    "@/db": dbModule,
    "./metrics": fakeMetrics,
    "./nutrition": nutrition,
    "./diary": diary,
    "./coaching": coaching,
    "./program": program,
  });
  const weighIn = load("src/lib/weigh-in.ts", {
    "@/db": dbModule,
    "./metrics": metrics,
    "./nutrition": nutrition,
  });
  const weights = () => db.select().from(schema.weightEntries).all();
  return { sqlite, db, clock, fakeMetrics, diary, store, weighIn, weights };
}

/**
 * A cut running since Jan 1: 2,400 kcal logged on each of the 21 days before `day`, and a
 * weigh-in at local noon on each of those days and the one before them.
 */
function seedProgram({ db, diary }, day, { weight = () => 80, complete = () => true } = {}) {
  db.insert(schema.coachingGoals)
    .values({
      mode: "lose",
      pace: 0.25,
      startedDay: "2024-01-01",
      program: { ...profile, initialExpenditure: 2600 },
    })
    .run();
  diary.saveTargets("2024-01-01", targets);
  for (let i = -22; i < 0; i++) {
    const date = nutrition.shiftDay(day, i);
    if (i >= -21) {
      diary.saveEntry({ day: date, meal: "Breakfast", food, amount: 1, portionLabel: "1 serving" });
      if (complete(date)) diary.setDayStatus(date, "complete");
    }
    const kg = weight(date);
    if (kg !== null)
      db.insert(schema.weightEntries)
        .values({ weightKg: kg, measuredAt: new Date(`${date}T12:00:00`).toISOString() })
        .run();
  }
}

/** The same 21 days as plain review input, with an id on each weigh-in. */
function programInput(day = "2024-02-01") {
  const days = Array.from({ length: 21 }, (_, i) => ({
    day: nutrition.shiftDay(day, i - 21),
    status: "complete",
  }));
  return {
    day,
    goal: { mode: "lose", pace: 0.25, startedDay: "2024-01-01" },
    program: { ...profile, initialExpenditure: 2600 },
    targets,
    days,
    entries: days.map((row) => ({ day: row.day, nutrients: { calories: 2400 } })),
    weights: [nutrition.shiftDay(day, -22), ...days.map((row) => row.day)].map((date, i) => ({
      day: date,
      kg: 80,
      id: i + 1,
    })),
    priorExpenditure: 2600,
  };
}

test("pace never reads as a signed zero and shows stone to two decimals", () => {
  const number = (value, digits = 1) =>
    new Intl.NumberFormat("en", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);
  assert.equal(metrics.formatPace(-0.04, "metric", number), "0.0 kg/wk");
  assert.equal(metrics.formatPace(-0.02, "stone", number), "0.00 st/wk");
  assert.equal(metrics.formatPace(0, "imperial", number), "0.0 lb/wk");
  assert.equal(metrics.formatPace(-0.44, "metric", number), "−0.4 kg/wk");
  assert.equal(metrics.formatPace(-0.03, "imperial", number), "−0.1 lb/wk");
  assert.equal(metrics.formatPace(0.25, "stone", number), "+0.04 st/wk");
  assert.equal(metrics.formatWeight(76.9, "stone", number), "12.11 st");
});

test("one far-off weigh-in holds the review by name, and without it the review runs", () => {
  const input = programInput();
  assert.equal(program.reviewProgram(input).status, "ready");
  const misread = input.weights[11];
  misread.kg = 76.9;
  const held = program.reviewProgram(input);
  assert.equal(held.status, "holding");
  assert.deepEqual(held.outlier, { day: misread.day, kg: 76.9, id: misread.id });
  input.weights.splice(11, 1);
  const ready = program.reviewProgram(input);
  assert.equal(ready.status, "ready");
  assert.equal(ready.outlier, undefined);
  // Of two readings that day, the misread one.
  input.weights.push(
    { day: misread.day, kg: 80.2, id: 50 },
    { day: misread.day, kg: 73.5, id: 51 }
  );
  assert.equal(program.reviewProgram(input).outlier.id, 51);

  // This morning's misread is named too.
  const morning = programInput();
  morning.weights.push({ day: morning.day, kg: 76.9, id: 99 });
  assert.equal(program.reviewProgram(morning).outlier.id, 99);

  // A lasting step isn't one bad reading: it holds without offering a delete.
  const step = programInput();
  step.weights.forEach((row, i) => (row.kg = i > 11 ? 82.6 : 80));
  const stepped = program.reviewProgram(step);
  assert.equal(stepped.status, "holding");
  assert.match(stepped.reason, /changing sharply/);
  assert.equal(stepped.outlier, undefined);
});

test("a review waiting for a recent weigh-in still counts its usable days", () => {
  const input = programInput();
  input.weights = input.weights.filter((row) => row.day < nutrition.shiftDay(input.day, -5));
  const waiting = program.reviewProgram(input);
  assert.equal(waiting.status, "learning");
  assert.match(waiting.reason, /recent weigh-in/);
  assert.equal(waiting.observedDays, 16);
});

test("deleting a flagged Health weigh-in frees the check-in and sync doesn't restore it", async () => {
  const data = coachingDatabase("2024-02-01");
  const { store, weighIn, weights } = data;
  seedProgram(data, "2024-02-01", { weight: (date) => (date === "2024-01-21" ? null : 80) });
  const health = load("src/lib/health.ts", {
    "expo-constants": { appOwnership: "standalone" },
    "@/db": { db: data.db, ...schema },
    "./health-native": {},
    "./metrics": metrics,
  });
  const sample = {
    id: "scale-1",
    kind: "weight",
    value: 76.9,
    measuredAt: new Date("2024-01-21T07:00:00").toISOString(),
  };
  const adapter = {
    authorize: async () => ({ read: ["weight"], write: [] }),
    read: async () => [sample],
    write: async () => "",
    remove: async () => {},
  };
  assert.deepEqual(await health.syncHealth(adapter), { imported: 1, exported: 0 });
  const held = store.currentReview();
  assert.equal(held.status, "holding");
  assert.equal(held.outlier.day, "2024-01-21");
  assert.equal(held.outlier.kg, 76.9);
  const removed = weighIn.deleteWeight(held.outlier.id);
  assert.equal(removed.weightKg, 76.9);
  assert.deepEqual(await health.syncHealth(adapter), { imported: 0, exported: 0 });
  assert.equal(store.currentReview().status, "ready");
  // Undo puts it back under its own id, still linked to the Health sample.
  weighIn.restoreWeight(removed);
  assert.deepEqual(await health.syncHealth(adapter), { imported: 0, exported: 0 });
  assert.equal(weights().length, 22);
  assert.equal(store.currentReview().outlier.id, removed.id);
  data.sqlite.close();
});

function inZone(zone, run) {
  if (zone === undefined) return run();
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

test("an 18:00 weigh-in on check-in day counts, west of UTC too", () => {
  for (const zone of [undefined, "America/Los_Angeles"])
    inZone(zone, () => {
      const data = coachingDatabase("2024-02-01");
      seedProgram(data, "2024-02-01");
      const evening = (at, kg) =>
        data.db
          .insert(schema.weightEntries)
          .values({ weightKg: kg, measuredAt: new Date(at).toISOString() })
          .run();
      evening("2024-02-01T18:00:00", 79);
      // Past local midnight it belongs to the next check-in.
      evening("2024-02-02T00:30:00", 70);
      const review = data.store.currentReview();
      assert.equal(review.trendWeightKg, 80 + (79 - 80) * (1 - 0.5 ** (1 / 7)), zone);
      data.sqlite.close();
    });
});

test("a program rebuilt after manual targets waits a week and ignores estimates over eight weeks old", () => {
  const data = coachingDatabase("2024-01-01");
  const { db, clock, diary, store } = data;
  const draft = { ...profile, checkInDay: 1 };
  const formula = program.initialExpenditure(draft);
  store.createProgram("lose", 0.25, draft);
  assert.equal(store.currentGoal().program.initialExpenditure, formula);
  db.insert(schema.checkIns)
    .values({
      day: "2024-01-08",
      goalId: store.currentGoal().id,
      decision: "kept",
      review: { ...store.currentReview("2024-01-08"), expenditure: 2300 },
      targets: diary.targetsForDay("2024-01-08"),
    })
    .run();
  // An edit during the week keeps the schedule and the learned estimate.
  clock.today = "2024-01-10";
  store.createProgram("lose", 0.25, { ...draft, protein: 2 });
  assert.equal(store.currentGoal().program.initialExpenditure, 2300);
  assert.equal(store.nextCheckInDay(), "2024-01-15");
  // Six weeks of manual targets, then a new program: a fresh week, the same estimate.
  store.saveGoal("manual", 0);
  clock.today = "2024-02-20";
  store.createProgram("lose", 0.25, draft);
  assert.equal(store.currentGoal().program.initialExpenditure, 2300);
  assert.equal(store.nextCheckInDay(), "2024-03-04");
  // Manual again until April: January's estimate is too old to reuse.
  store.saveGoal("manual", 0);
  clock.today = "2024-04-02";
  store.createProgram("lose", 0.25, draft);
  assert.equal(store.currentGoal().program.initialExpenditure, formula);
  assert.equal(store.coachingSnapshot().isDue, false);
  assert.equal(store.nextCheckInDay(), "2024-04-15");
  assert.equal(store.currentReview("2024-04-15").expenditure, formula);
  // Editing it keeps the formula rather than reviving January's estimate.
  clock.today = "2024-04-03";
  store.createProgram("lose", 0.25, { ...draft, protein: 2 });
  assert.equal(store.currentGoal().program.initialExpenditure, formula);
  data.sqlite.close();
});

test("edits before a program's first check-in don't move it, after manual targets too", () => {
  const data = coachingDatabase("2024-01-01");
  const { clock, store } = data;
  const draft = { ...profile, checkInDay: 1 };
  const edit = (day, change = {}) => {
    clock.today = day;
    store.createProgram("lose", 0.25, { ...draft, ...change });
  };
  const checkIn = (day) => {
    clock.today = day;
    store.finishCheckIn("kept");
  };
  edit("2024-01-01");
  edit("2024-01-05", { protein: 2 });
  assert.equal(store.nextCheckInDay(), "2024-01-08");
  checkIn("2024-01-08");
  clock.today = "2024-01-20";
  store.saveGoal("manual", 0);
  edit("2024-03-04");
  assert.equal(store.nextCheckInDay(), "2024-03-11");
  edit("2024-03-10", { protein: 2 });
  assert.equal(store.nextCheckInDay(), "2024-03-11");
  // A goal-weight change on check-in morning doesn't hide the check-in.
  edit("2024-03-11", { targetWeightKg: 74 });
  const snapshot = store.coachingSnapshot();
  assert.equal(snapshot.due, "2024-03-11");
  assert.equal(snapshot.isDue, true);
  checkIn("2024-03-11");
  edit("2024-03-12", { protein: 1.6 });
  assert.equal(store.nextCheckInDay(), "2024-03-18");
  data.sqlite.close();
});

test("editing a program after eight weeks without check-ins keeps its learned estimate", () => {
  const data = coachingDatabase("2024-01-01");
  const { db, clock, diary, store } = data;
  const draft = { ...profile, checkInDay: 1 };
  store.createProgram("lose", 0.25, draft);
  for (const [day, expenditure] of [
    ["2024-01-08", 2500],
    ["2024-01-22", 2400],
    ["2024-02-05", 2300],
  ])
    db.insert(schema.checkIns)
      .values({
        day,
        goalId: store.currentGoal().id,
        decision: "kept",
        review: { ...store.currentReview(day), expenditure },
        targets: diary.targetsForDay(day),
      })
      .run();
  clock.today = "2024-04-15";
  store.createProgram("lose", 0.25, { ...draft, protein: 2 });
  assert.equal(store.currentGoal().program.initialExpenditure, 2300);
  assert.equal(store.currentReview().expenditure, 2300);
  data.sqlite.close();
});

test("editing the program after checking in keeps that review instead of blending it again", () => {
  const data = coachingDatabase("2024-02-01");
  const { store } = data;
  seedProgram(data, "2024-02-01");
  const reviewed = store.currentReview();
  assert.equal(reviewed.status, "ready");
  store.finishCheckIn("accepted");
  store.createProgram("lose", 0.5, { ...profile, protein: 2 });
  const edited = store.currentReview();
  assert.equal(edited.status, "holding");
  assert.equal(edited.expenditure, reviewed.expenditure);
  assert.equal(edited.proposed, null);
  assert.equal(edited.desiredWeeklyKg, -0.4, "goal pace follows the edited program");
  assert.equal(store.coachingSnapshot().isDue, false);
  assert.equal(store.nextCheckInDay(), "2024-02-08");
  assert.equal(store.checkInHistory().length, 1);
  data.sqlite.close();
});

test("while coached, Home asks about unanswered days from the last three weeks", () => {
  const data = coachingDatabase("2024-02-01");
  const { db, diary } = data;
  diary.saveTargets("2024-01-01", targets);
  for (const day of ["2024-01-10", "2024-01-16"])
    diary.saveEntry({ day, meal: "Lunch", food, amount: 1, portionLabel: "1 serving" });
  assert.equal(diary.dayToConfirm("2024-02-01"), null, "without coaching, only the last week");
  db.insert(schema.coachingGoals)
    .values({ mode: "lose", pace: 0.25, startedDay: "2024-01-01" })
    .run();
  assert.deepEqual(diary.dayToConfirm("2024-02-01"), { day: "2024-01-16", calories: 2400 });
  diary.setDayStatus("2024-01-16", "complete");
  assert.equal(diary.dayToConfirm("2024-02-01"), null, "older than the review window");
  data.sqlite.close();
});

// Runs compiled components with persistent hook and compiler cache slots. Nested components
// stay unrendered elements; database reads and writes are real.
function screenHarness(dependencies, storeOverrides = {}) {
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
  const jsx = (type, props, key) => ({ type, props, key });
  const store = {
    number: (value, digits = 1) => value.toFixed(digits),
    date: (day) => day,
    units: "metric",
    language: "en",
    weights: [],
    refresh: () => {},
    ...storeOverrides,
  };
  const all = {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react/compiler-runtime": {
      c: (size) =>
        react.useState(() => Array(size).fill(Symbol.for("react.memo_cache_sentinel")))[0],
    },
    "react-native": { View: "View", AppState: {} },
    "@/components/system": {
      SystemButton: "Button",
      SystemLabel: "Label",
      SystemPanel: { Body: "PanelBody" },
      SystemText: "Text",
    },
    "@/components/ui": { ErrorText: "Error" },
    "@/lib/store": { useStore: () => store },
    "./store": { useStore: () => store },
    ...dependencies,
  };
  all["@/lib/nutrition-store"] = load("src/lib/nutrition-store.tsx", all, true);
  return {
    context,
    store,
    load: (file) => load(file, all, true),
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
const shown = (tree, type, label) =>
  tree.find((node) => node.type === type && node.props.children === label);

test("compiled check-in names a misread weigh-in, deletes it in one tap and can undo", () => {
  const data = coachingDatabase("2024-02-01");
  const { store, weighIn, weights, fakeMetrics } = data;
  seedProgram(data, "2024-02-01", { weight: (date) => (date === "2024-01-21" ? 76.9 : 80) });
  const dependencies = {
    "@/lib/coaching-store": store,
    "@/lib/metrics": fakeMetrics,
    "./metrics": fakeMetrics,
    "@/lib/weigh-in": weighIn,
  };
  const home = screenHarness(dependencies, { weights: weights() });
  const { HomeCheckIn } = home.load("src/components/nutrition/home-check-in.tsx");
  const renderHome = () =>
    nodes(home.render(HomeCheckIn, { onDone() {}, onWeighIn() {}, onReviewLogs() {} }));
  let tree = renderHome();
  assert.ok(shown(tree, "Text", "No change this week"));
  assert.equal(tree.find((node) => node.props.outlier)?.props.outlier.kg, 76.9);

  const prompt = screenHarness(dependencies);
  prompt.store.refresh = () => (prompt.store.weights = weights());
  const { OutlierPrompt } = prompt.load("src/components/nutrition/home-check-in.tsx");
  const renderPrompt = () =>
    nodes(prompt.render(OutlierPrompt, { outlier: store.currentReview().outlier }));
  tree = renderPrompt();
  assert.ok(shown(tree, "Text", "Delete 76.9 kg on Jan 21?"));
  const remove = shown(tree, "Button", "Delete");
  remove.props.onPress();
  remove.props.onPress();
  assert.equal(weights().length, 21);
  assert.equal(prompt.context.revision, 2);
  tree = renderPrompt();
  assert.ok(shown(tree, "Text", "Deleted 76.9 kg on Jan 21"));

  home.store.weights = weights();
  assert.ok(shown(renderHome(), "Button", "Accept plan"));

  shown(tree, "Button", "Undo").props.onPress();
  assert.equal(weights().length, 22);
  assert.ok(shown(renderPrompt(), "Text", "Delete 76.9 kg on Jan 21?"));
  data.sqlite.close();
});

test("compiled check-in shows usable days against the twelve it needs", () => {
  const data = coachingDatabase("2024-02-01");
  const { store, weighIn, weights, fakeMetrics } = data;
  seedProgram(data, "2024-02-01", { complete: (date) => date < "2024-01-21" });
  const home = screenHarness(
    {
      "@/lib/coaching-store": store,
      "@/lib/metrics": fakeMetrics,
      "./metrics": fakeMetrics,
      "@/lib/weigh-in": weighIn,
    },
    { weights: weights() }
  );
  const { HomeCheckIn } = home.load("src/components/nutrition/home-check-in.tsx");
  const tree = nodes(home.render(HomeCheckIn, { onDone() {}, onWeighIn() {}, onReviewLogs() {} }));
  assert.ok(shown(tree, "Text", "Still learning your needs"));
  assert.ok(shown(tree, "Text", "10/12 usable days · 21 weigh-in days"));
  assert.equal(store.coverage(store.currentReview()), "10/12");
  data.sqlite.close();
});

test("compiled Plan confirms saved targets in place on first setup and after they change", () => {
  const data = coachingDatabase("2024-02-01");
  const announced = [];
  const screen = screenHarness({
    "@/lib/coaching-store": data.store,
    "@/lib/diary": data.diary,
    "@/lib/metrics": data.fakeMetrics,
    "./metrics": data.fakeMetrics,
    "@/components/ui": { ErrorText: "Error", Field: "Field", Screen: "Screen" },
    "./coaching-panel": { CoachingPanel: "CoachingPanel" },
    "expo-router": { router: {} },
    "react-native": {
      View: "View",
      Platform: { OS: "ios" },
      AccessibilityInfo: { announceForAccessibility: (message) => announced.push(message) },
    },
  });
  const { PlanScreen } = screen.load("src/components/nutrition/plan-screen.tsx");
  // One persistent harness: a key tied to the targets would remount the scroll view on save.
  const render = () => {
    const tree = nodes(screen.render(PlanScreen, {}));
    assert.deepEqual(
      tree.filter((node) => node.key != null).map((node) => node.key),
      ["protein", "carbs", "fat"]
    );
    return tree;
  };
  const field = (tree, label) =>
    tree.find((node) => node.type === "Field" && node.props.label === label);
  const confirmation = "Targets saved. You\u2019re ready to log.";

  let tree = render();
  assert.equal(field(tree, "Calories (kcal)").props.value, "");
  for (const [label, value] of [
    ["Calories (kcal)", "2100"],
    ["Protein (g)", "150"],
    ["Carbs (g)", "220"],
    ["Fat (g)", "70"],
  ])
    field(tree, label).props.onChange(value);
  tree = render();
  assert.equal(shown(tree, "Text", confirmation), undefined);
  shown(tree, "Button", "Save targets").props.onPress();
  tree = render();
  assert.deepEqual(data.diary.targetsForDay("2024-02-01"), {
    calories: 2100,
    protein: 150,
    carbs: 220,
    fat: 70,
  });
  assert.ok(shown(tree, "Text", confirmation), "shown on first setup");
  assert.deepEqual(announced, [confirmation]);

  field(tree, "Calories (kcal)").props.onChange("2000");
  tree = render();
  assert.equal(shown(tree, "Text", confirmation), undefined, "editing clears it");
  shown(tree, "Button", "Save targets").props.onPress();
  tree = render();
  assert.equal(data.diary.targetsForDay("2024-02-01").calories, 2000);
  assert.equal(field(tree, "Calories (kcal)").props.value, "2000");
  assert.ok(shown(tree, "Text", confirmation), "shown after the targets change");
  shown(tree, "Button", "Save targets").props.onPress();
  assert.ok(shown(render(), "Text", confirmation), "shown when saving unchanged targets");

  field(render(), "Carbs (g)").props.onChange("999");
  data.diary.saveTargets("2024-02-01", { calories: 1900, protein: 150, carbs: 200, fat: 70 });
  screen.context.refresh();
  tree = render();
  assert.equal(field(tree, "Calories (kcal)").props.value, "1900");
  assert.equal(field(tree, "Carbs (g)").props.value, "200", "new targets replace a stale draft");
  assert.equal(shown(tree, "Text", confirmation), undefined, "not for targets changed elsewhere");

  field(tree, "Fat (g)").props.onChange("80");
  tree.find((node) => node.type === "CoachingPanel").props.onTargetsChanged();
  assert.equal(field(render(), "Fat (g)").props.value, "70", "an accepted check-in reseeds");
  assert.equal(announced.length, 3);
  data.sqlite.close();
});

/** WCAG relative luminance contrast between two #rrggbb colors. */
function contrast(a, b) {
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

test("light-mode accent text, links and focus rings keep AA contrast on every surface", () => {
  const css = readFileSync("src/global.css", "utf8");
  const theme = (variant) => {
    const block = css.slice(css.indexOf(`@variant ${variant}`)).split("}")[0];
    return Object.fromEntries(
      [...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6});/gi)].map(([, name, value]) => [name, value])
    );
  };
  const light = theme("light");
  const surfaces = [
    "background",
    "surface",
    "surface-secondary",
    "surface-tertiary",
    "accent-soft",
  ];
  for (const token of ["link", "accent-soft-foreground"])
    for (const surface of surfaces)
      assert.ok(
        contrast(light[token], light[surface]) >= 4.5,
        `${token} on ${surface}: ${contrast(light[token], light[surface]).toFixed(2)}`
      );
  for (const surface of ["field-background", "background", "surface-secondary"])
    assert.ok(contrast(light.focus, light[surface]) >= 3, `focus on ${surface}`);
  assert.ok(contrast(light["accent-foreground"], light.accent) >= 4.5, "primary button label");

  const dark = theme("dark");
  for (const token of ["link", "accent-soft-foreground", "focus"])
    assert.ok(contrast(dark[token], dark.surface) >= 4.5, `dark ${token}`);
});
