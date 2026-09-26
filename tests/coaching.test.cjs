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
function seedProgram(
  { db, diary },
  day,
  { weight = () => 80, complete = () => true, changes = {} } = {}
) {
  db.insert(schema.coachingGoals)
    .values({
      mode: "lose",
      pace: 0.25,
      startedDay: "2024-01-01",
      program: { ...profile, initialExpenditure: 2600, ...changes },
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
      SystemIconButton: "IconButton",
      SystemLabel: "Label",
      SystemPanel: { Body: "PanelBody" },
      SystemText: "Text",
    },
    "./check-in-adjuster": { CheckInAdjuster: "CheckInAdjuster" },
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

test("compiled check-in names a misread weigh-in, ignores it in one tap and can undo", () => {
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
  assert.ok(shown(tree, "Text", "Ignore 76.9 kg on Jan 21?"));
  const ignore = shown(tree, "Button", "Ignore reading");
  ignore.props.onPress();
  ignore.props.onPress();
  // The reading stays in history, left out of the trend.
  assert.equal(weights().length, 22);
  assert.deepEqual(
    weights()
      .filter((row) => row.excluded)
      .map((row) => row.weightKg),
    [76.9]
  );
  assert.equal(prompt.context.revision, 2);
  tree = renderPrompt();
  assert.ok(shown(tree, "Text", "Ignored 76.9 kg on Jan 21"));

  home.store.weights = weights();
  assert.ok(shown(renderHome(), "Button", "Accept plan"));

  shown(tree, "Button", "Undo").props.onPress();
  assert.equal(weights().filter((row) => row.excluded).length, 0);
  assert.ok(shown(renderPrompt(), "Text", "Ignore 76.9 kg on Jan 21?"));
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

// Check-in parity: adjusted targets, custom macros, one-tap Maintain and ignored weigh-ins.
const loadBackup = (db) =>
  load("src/lib/backup-data.ts", { "@/db": { db, ...schema }, "./nutrition": nutrition });

test("programs keep macros set at a check-in, and adjustments stay in the coached range", () => {
  const own = { ...profile, initialExpenditure: 2600 };
  assert.deepEqual(program.programMacros(2400, 80, own), {
    calories: 2400,
    protein: 128,
    fat: 84,
    carbs: 283,
  });
  const custom = program.programMacros(2400, 80, {
    ...own,
    custom: { proteinG: 180, carbPct: 45 },
  });
  assert.equal(custom.protein, 180);
  assert.ok(Math.abs(program.customMacros(custom).carbPct - 45) < 0.5);
  assert.deepEqual(program.customMacros({ calories: 2362, protein: 150, carbs: 256, fat: 82 }), {
    proteinG: 150,
    carbPct: 58.1,
  });
  for (const bad of [{ proteinG: 20 }, { carbPct: 120 }])
    assert.throws(() => program.validateProgram({ ...own, custom: bad }));

  // A step keeps protein and the split; the fat floor holds with a weight.
  const proposed = { calories: 2310, protein: 128, fat: 80, carbs: 270 };
  assert.deepEqual(program.stepTargets(proposed, 50, 80), {
    calories: 2360,
    protein: 128,
    carbs: 278,
    fat: 82,
  });
  assert.equal(program.stepTargets({ ...proposed, fat: 48, carbs: 342 }, -500, 80).fat, 48);

  const check = (targets) => program.checkAdjustment(targets, 80);
  assert.throws(() => check({ ...proposed, calories: 1400 }), /1,500 and 5,000/);
  assert.throws(() => check({ ...proposed, fat: 120 }), /add up/);
  assert.throws(() => check({ calories: 2310, protein: 100, carbs: 298, fat: 80 }), /112 g/);
  assert.throws(() => check({ calories: 2310, protein: 128, carbs: 360, fat: 40 }), /48 g/);
  assert.throws(() => check({ calories: 3000, protein: 520, carbs: 90, fat: 60 }), /500 g/);
  assert.throws(() => check({ ...proposed, carbs: NaN }), /grams/);
  assert.deepEqual(check({ ...proposed, carbs: 270.4 }), proposed);
  // Without a program there is no body weight to check protein and fat against.
  assert.deepEqual(program.checkAdjustment({ calories: 2000, protein: 60, carbs: 300, fat: 60 }), {
    calories: 2000,
    protein: 60,
    carbs: 300,
    fat: 60,
  });

  // Only what differs from the program's own macros is kept.
  assert.equal(
    program.adjustedProgram(own, program.stepTargets(proposed, 50, 80), 80).custom,
    undefined
  );
  assert.deepEqual(
    program.adjustedProgram(own, { calories: 2362, protein: 150, carbs: 256, fat: 82 }, 80).custom,
    { proteinG: 150, carbPct: 58.1 }
  );
  assert.deepEqual(
    program.adjustedProgram(
      { ...own, custom: { proteinG: 150 } },
      { calories: 2310, protein: 128, carbs: 250, fat: 89 },
      80
    ).custom,
    { carbPct: 55.5 }
  );
});

test("an adjusted check-in saves the typed targets and later reviews keep its macros", () => {
  const data = coachingDatabase("2024-02-01");
  const { db, clock, diary, store } = data;
  seedProgram(data, "2024-02-01");
  const review = store.currentReview();
  assert.deepEqual(review.proposed, { calories: 2310, protein: 128, fat: 80, carbs: 270 });
  const adjusted = { calories: 2362, protein: 150, carbs: 256, fat: 82 };
  assert.throws(() => store.finishCheckIn("adjusted"), /check-in action/);
  assert.throws(() => store.finishCheckIn("kept", adjusted), /check-in action/);
  const low = { calories: 2362, protein: 100, carbs: 306, fat: 82 };
  assert.throws(() => store.finishCheckIn("adjusted", low), /112 g/);
  assert.equal(store.checkInHistory().length, 0);

  assert.deepEqual(store.finishCheckIn("adjusted", adjusted), adjusted);
  assert.deepEqual(diary.targetsForDay("2024-02-01"), adjusted);
  assert.equal(diary.targetsForDay("2024-01-31").calories, targets.calories);
  const [saved] = store.checkInHistory();
  assert.equal(saved.decision, "adjusted");
  assert.deepEqual(saved.review.proposed, review.proposed);
  assert.deepEqual(saved.targets, adjusted);
  const goal = store.currentGoal();
  assert.deepEqual(goal.program.custom, { proteinG: 150, carbPct: 58.1 });
  assert.equal(goal.program.initialExpenditure, 2600, "the new revision keeps the program");
  assert.equal(store.coachingSnapshot().isDue, false);
  assert.equal(store.nextCheckInDay(), "2024-02-08");
  assert.equal(store.currentReview().expenditure, review.expenditure);
  assert.throws(() => store.finishCheckIn("adjusted", adjusted), /not due/);

  // A week on, the proposal moves calories but keeps the adjusted protein and split.
  for (let i = 0; i < 7; i++) {
    const date = nutrition.shiftDay("2024-02-01", i);
    diary.saveEntry({ day: date, meal: "Breakfast", food, amount: 1, portionLabel: "1 serving" });
    diary.setDayStatus(date, "complete");
    db.insert(schema.weightEntries)
      .values({ weightKg: 80, measuredAt: new Date(`${date}T12:00:00`).toISOString() })
      .run();
  }
  clock.today = "2024-02-08";
  const next = store.currentReview();
  assert.equal(next.status, "ready");
  assert.equal(next.proposed.protein, 150);
  assert.ok(Math.abs(program.customMacros(next.proposed).carbPct - 58.1) < 1);
  assert.notEqual(next.proposed.calories, adjusted.calories);

  // Backups carry the decision and the custom macros; older ones without them still restore.
  const backup = loadBackup(db);
  const copy = backup.createBackup();
  backup.restoreBackup(copy);
  assert.equal(store.checkInHistory()[0].decision, "adjusted");
  assert.deepEqual(store.currentGoal().program.custom, { proteinG: 150, carbPct: 58.1 });
  const legacy = structuredClone(copy);
  legacy.data.goals.forEach((row) => delete row.program?.custom);
  backup.restoreBackup(legacy);
  assert.equal(store.currentGoal().program.custom, undefined);
  data.sqlite.close();
});

test("a check-in adjusted by calories alone leaves the program's macros alone", () => {
  const data = coachingDatabase("2024-02-01");
  seedProgram(data, "2024-02-01");
  const own = data.store.currentGoal().program;
  const stepped = program.programTargets(
    program.stepTargets(data.store.currentReview().proposed, -50, 80),
    80,
    own
  );
  data.store.finishCheckIn("adjusted", stepped);
  assert.deepEqual(data.diary.targetsForDay("2024-02-01"), stepped);
  assert.equal(data.store.currentGoal().program.custom, undefined);
  assert.equal(data.db.select().from(schema.coachingGoals).all().length, 1);
  data.sqlite.close();

  // Steps follow the program's own split and fat floor, so they never read as custom macros.
  const step = (targets, delta, weight, plan) =>
    program.programTargets(program.stepTargets(targets, delta, weight), weight, plan);
  const moreCarbs = { ...profile, initialExpenditure: 2600, diet: "lower-fat" };
  const floor = program.programMacros(2000, 80, moreCarbs);
  assert.deepEqual(floor, { calories: 2000, protein: 128, fat: 48, carbs: 264 });
  const up = step(floor, 50, 80, moreCarbs);
  assert.deepEqual(up, { calories: 2050, protein: 128, fat: 48, carbs: 277 });
  assert.equal(program.adjustedProgram(moreCarbs, up, 80).custom, undefined);
  assert.deepEqual(step(step(floor, -50, 80, moreCarbs), 50, 80, moreCarbs), floor);
  for (const diet of ["balanced", "lower-fat", "lower-carb"])
    for (const protein of [1.4, 1.6, 2, 2.2])
      for (let weight = 50; weight <= 120; weight += 5)
        for (let calories = 1600; calories <= 3400; calories += 150) {
          const own = { ...moreCarbs, diet, protein };
          // Only calories the program can allocate; the rest never become a proposal.
          const allocates = (kcal) =>
            program.programTargets({ calories: kcal }, weight, own).protein;
          if (!allocates(calories)) continue;
          const start = program.programMacros(calories, weight, own);
          for (const delta of [-50, 50].filter((delta) => allocates(calories + delta)))
            assert.deepEqual(
              program.adjustedProgram(own, step(start, delta, weight, own), weight),
              own,
              `${diet} ${protein} g/kg at ${weight} kg, ${calories} ${delta} kcal`
            );
        }
  // A custom split already kept stays exactly as it was.
  const kept = { ...moreCarbs, custom: { carbPct: 45 } };
  assert.deepEqual(
    program.adjustedProgram(kept, step(program.programMacros(2400, 80, kept), 50, 80, kept), 80),
    kept
  );
});

test("Maintain at the goal weight answers a due check-in in one tap", () => {
  const data = coachingDatabase("2024-02-01");
  const { diary, store } = data;
  seedProgram(data, "2024-02-01");
  assert.equal(store.reachedGoal(store.currentGoal(), store.currentReview()), false);
  assert.throws(() => store.maintainGoal(), /reached your goal/);

  const done = coachingDatabase("2024-02-01");
  seedProgram(done, "2024-02-01", { changes: { targetWeightKg: 80.5 } });
  const review = done.store.currentReview();
  assert.equal(review.desiredWeeklyKg, 0);
  assert.match(review.reason, /choose Maintain/);
  assert.equal(done.store.reachedGoal(done.store.currentGoal(), review), true);
  const result = done.store.maintainGoal();
  assert.deepEqual(result, { calories: 2530, protein: 128, fat: 90, carbs: 302 });
  assert.deepEqual(done.diary.targetsForDay("2024-02-01"), result);
  const goal = done.store.currentGoal();
  assert.equal(goal.mode, "maintain");
  assert.equal(goal.pace, 0);
  assert.equal(goal.startedDay, "2024-02-01");
  assert.equal(goal.program.targetWeightKg, 80.5);
  assert.equal(goal.program.weightKg, 80);
  assert.equal(goal.program.initialExpenditure, review.expenditure);
  const [checkIn] = done.store.checkInHistory();
  assert.equal(checkIn.decision, "adjusted");
  assert.deepEqual(checkIn.targets, result);
  assert.equal(done.store.coachingSnapshot().isDue, false);
  assert.equal(done.store.nextCheckInDay(), "2024-02-08");
  assert.throws(() => done.store.maintainGoal(), /reached your goal/);

  // Between check-ins it only switches the program, from the last reviewed estimate.
  const later = coachingDatabase("2024-02-01");
  seedProgram(later, "2024-02-01", { changes: { targetWeightKg: 80.5 } });
  later.store.finishCheckIn("kept");
  const maintained = later.store.maintainGoal();
  assert.equal(later.store.checkInHistory().length, 1);
  assert.equal(later.store.currentGoal().mode, "maintain");
  assert.equal(later.store.currentGoal().program.initialExpenditure, review.expenditure);
  assert.deepEqual(later.diary.targetsForDay("2024-02-01"), maintained);
  assert.equal(later.store.nextCheckInDay(), "2024-02-08");
  assert.equal(diary.targetsForDay("2024-02-01").calories, targets.calories);
  for (const database of [data, done, later]) database.sqlite.close();
});

test("ignored weigh-ins stay in history but leave the trend, check-ins, CSV and backups flagged", async () => {
  assert.deepEqual(
    metrics
      .weightTrend([
        { measuredAt: "2024-01-01", weightKg: 80 },
        { measuredAt: "2024-01-02", weightKg: 60, excluded: true },
        { measuredAt: "2024-01-03", weightKg: 80, excluded: false },
      ])
      .map((row) => row.day),
    ["2024-01-01", "2024-01-03"]
  );
  const data = coachingDatabase("2024-02-01");
  const { db, store, weighIn, weights } = data;
  seedProgram(data, "2024-02-01", { weight: (date) => (date === "2024-01-21" ? null : 80) });
  const health = load("src/lib/health.ts", {
    "expo-constants": { appOwnership: "standalone" },
    "@/db": { db, ...schema },
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
    authorize: async () => ({ read: ["weight"], write: ["weight"] }),
    read: async () => [sample],
    write: async () => "exported",
    remove: async () => {},
  };
  assert.deepEqual(await health.syncHealth(adapter), { imported: 1, exported: 21 });
  const held = store.currentReview();
  assert.equal(held.outlier.kg, 76.9);
  const ignored = weighIn.setWeightExcluded(held.outlier.id, true);
  assert.equal(ignored.excluded, true);
  assert.equal(store.currentReview().status, "ready");
  // Sync neither re-imports nor re-exports it, and a corrected Health value stays ignored.
  assert.deepEqual(await health.syncHealth(adapter), { imported: 0, exported: 0 });
  sample.value = 77.1;
  assert.deepEqual(await health.syncHealth(adapter), { imported: 1, exported: 0 });
  const row = weights().find((w) => w.id === ignored.id);
  assert.equal(row.weightKg, 77.1);
  assert.equal(row.excluded, true);
  assert.equal(weights().length, 22);
  assert.equal(store.currentReview().status, "ready");

  const ownership = load("src/lib/data-ownership.ts", { "@/db": { db, ...schema } });
  const lines = ownership.exportWeightCsv().replace(/^﻿/, "").trimEnd().split("\r\n");
  assert.equal(lines[0], '"measured_at","weight_kg","excluded"');
  assert.ok(lines.includes(`"${sample.measuredAt}","77.1","true"`));
  assert.equal(lines.filter((line) => line.endsWith('"false"')).length, 21);

  const backup = loadBackup(db);
  const copy = backup.createBackup();
  assert.equal(copy.data.weights.filter((w) => w.excluded).length, 1);
  backup.restoreBackup(copy);
  assert.deepEqual(backup.createBackup().data, copy.data);
  const legacy = structuredClone(copy);
  legacy.data.weights.forEach((w) => delete w.excluded);
  backup.restoreBackup(legacy);
  assert.equal(weights().filter((w) => w.excluded).length, 0);
  assert.equal(store.currentReview().outlier.kg, 77.1);

  weighIn.setWeightExcluded(store.currentReview().outlier.id, true);
  weighIn.setWeightExcluded(ignored.id, false);
  assert.equal(store.currentReview().status, "holding", "included again, it holds again");
  data.sqlite.close();
});

const checkInDependencies = (data) => ({
  "@/lib/coaching-store": data.store,
  "@/lib/metrics": data.fakeMetrics,
  "./metrics": data.fakeMetrics,
  "@/lib/weigh-in": data.weighIn,
  "@/lib/program": program,
});
const renderCheckIn = (harness, HomeCheckIn, done = []) =>
  nodes(
    harness.render(HomeCheckIn, {
      onDone: (message) => done.push(message),
      onWeighIn() {},
      onReviewLogs() {},
    })
  );
const labelled = (tree, label) => tree.find((node) => node.props.accessibilityLabel === label);
const adjusterInputs = Object.assign(() => null, { Input: "Input", Suffix: "Suffix" });

test("compiled check-in adjusts the proposal from Home and keeps Accept one tap", () => {
  const data = coachingDatabase("2024-02-01");
  seedProgram(data, "2024-02-01");
  const home = screenHarness(checkInDependencies(data), { weights: data.weights() });
  const { HomeCheckIn } = home.load("src/components/nutrition/home-check-in.tsx");
  const done = [];
  let tree = renderCheckIn(home, HomeCheckIn, done);
  assert.equal(shown(tree, "Button", "Accept plan").props.variant, "primary");
  assert.equal(
    tree.find((node) => node.type === "CheckInAdjuster"),
    undefined
  );
  labelled(tree, "Adjust targets").props.onPress();
  tree = renderCheckIn(home, HomeCheckIn, done);
  assert.equal(shown(tree, "Button", "Accept plan"), undefined);
  const adjuster = tree.find((node) => node.type === "CheckInAdjuster");
  assert.deepEqual(adjuster.props.start, data.store.currentReview().proposed);
  assert.equal(adjuster.props.weight, 80);
  assert.deepEqual(adjuster.props.program, data.store.currentGoal().program);

  adjuster.props.onSave({ calories: 2362, protein: 100, carbs: 306, fat: 82 });
  tree = renderCheckIn(home, HomeCheckIn, done);
  assert.match(tree.find((node) => node.type === "Error").props.message, /112 g/);
  assert.deepEqual(done, []);
  adjuster.props.onSave({ calories: 2362, protein: 150, carbs: 256, fat: 82 });
  adjuster.props.onSave({ calories: 2362, protein: 150, carbs: 256, fat: 82 });
  assert.deepEqual(done, ["Check-in done. Your adjusted targets start today."]);
  assert.equal(data.store.checkInHistory().length, 1);
  assert.equal(data.diary.targetsForDay("2024-02-01").protein, 150);
  data.sqlite.close();
});

test("compiled adjuster steps 50 kcal, recounts typed grams and saves them", () => {
  const data = coachingDatabase("2024-02-01");
  const InputGroup = adjusterInputs;
  const screen = screenHarness({
    ...checkInDependencies(data),
    "heroui-native": { InputGroup },
  });
  const { CheckInAdjuster } = screen.load("src/components/nutrition/check-in-adjuster.tsx");
  const saved = [];
  const props = {
    start: { calories: 2310, protein: 128, fat: 80, carbs: 270 },
    weight: 80,
    onSave: (targets) => saved.push(targets),
    onCancel() {},
  };
  const render = () => nodes(screen.render(CheckInAdjuster, props));
  const calories = (tree) =>
    [tree.find((node) => node.props.accessibilityLiveRegion === "polite").props.children]
      .flat()
      .join("");
  const input = (tree, label) => labelled(tree, `${label} in grams`);
  let tree = render();
  assert.equal(calories(tree), "2310 kcal/day");
  labelled(tree, "50 kcal more").props.onPress();
  tree = render();
  assert.equal(calories(tree), "2360 kcal/day");
  assert.deepEqual(
    ["Protein", "Carbs", "Fat"].map((label) => input(tree, label).props.value),
    ["128", "278", "82"]
  );
  input(tree, "Protein").props.onChangeText("150");
  input(render(), "Carbs").props.onChangeText("256");
  tree = render();
  assert.equal(calories(tree), "2362 kcal/day");
  shown(tree, "Button", "Save targets").props.onPress();
  assert.deepEqual(saved, [{ calories: 2362, protein: 150, carbs: 256, fat: 82 }]);
  input(tree, "Fat").props.onChangeText("");
  tree = render();
  assert.equal(shown(tree, "Button", "Save targets").props.isDisabled, true);
  assert.equal(labelled(tree, "50 kcal more").props.isDisabled, true);

  const low = screenHarness({ ...checkInDependencies(data), "heroui-native": { InputGroup } });
  const lowTree = nodes(
    low.render(low.load("src/components/nutrition/check-in-adjuster.tsx").CheckInAdjuster, {
      ...props,
      start: { calories: 1520, protein: 128, fat: 50, carbs: 140 },
    })
  );
  assert.equal(labelled(lowTree, "50 kcal less").props.isDisabled, true);
  data.sqlite.close();
});

test("adjusting a learning week starts from the program at today's trend", () => {
  // Targets set a week ago at 81 kg; the trend is now 80 kg and the review is still learning.
  const data = coachingDatabase("2024-02-01");
  seedProgram(data, "2024-02-01", { complete: () => false });
  const own = data.store.currentGoal().program;
  data.diary.saveTargets("2024-01-25", program.programMacros(2155, 81, own));
  const home = screenHarness(checkInDependencies(data), { weights: data.weights() });
  const { HomeCheckIn } = home.load("src/components/nutrition/home-check-in.tsx");
  const adjusterScreen = (database) => {
    const screen = screenHarness({
      ...checkInDependencies(database),
      "heroui-native": { InputGroup: adjusterInputs },
    });
    const { CheckInAdjuster } = screen.load("src/components/nutrition/check-in-adjuster.tsx");
    return (props) => nodes(screen.render(CheckInAdjuster, props));
  };
  const done = [];
  let tree = renderCheckIn(home, HomeCheckIn, done);
  assert.equal(data.store.currentReview().status, "learning");
  labelled(tree, "Adjust targets").props.onPress();
  tree = renderCheckIn(home, HomeCheckIn, done);
  const adjuster = tree.find((node) => node.type === "CheckInAdjuster");
  assert.equal(adjuster.props.start.protein, 130);
  assert.deepEqual(adjuster.props.program, own);
  const adjust = adjusterScreen(data);
  const render = () => adjust(adjuster.props);
  assert.equal(labelled(render(), "Protein in grams").props.value, "128");
  labelled(render(), "50 kcal less").props.onPress();
  shown(render(), "Button", "Save targets").props.onPress();
  assert.deepEqual(done, ["Check-in done. Your adjusted targets start today."]);
  assert.deepEqual(data.diary.targetsForDay("2024-02-01"), program.programMacros(2105, 80, own));
  assert.equal(data.store.currentGoal().program.custom, undefined);
  assert.equal(data.db.select().from(schema.coachingGoals).all().length, 1);
  data.sqlite.close();

  // At 1.4 g/kg, protein set at 78 kg would sit under today's floor; the start meets it.
  const bulk = coachingDatabase("2024-02-01");
  seedProgram(bulk, "2024-02-01", { complete: () => false, changes: { protein: 1.4 } });
  const low = bulk.store.currentGoal().program;
  bulk.diary.saveTargets("2024-01-25", program.programMacros(2600, 78, low));
  const saved = [];
  const props = {
    start: bulk.diary.targetsForDay("2024-02-01"),
    weight: 80,
    program: low,
    onSave: (targets) => saved.push(bulk.store.finishCheckIn("adjusted", targets)),
    onCancel() {},
  };
  assert.equal(props.start.protein, 109);
  const bulkAdjust = adjusterScreen(bulk);
  const draw = () => bulkAdjust(props);
  labelled(draw(), "50 kcal more").props.onPress();
  shown(draw(), "Button", "Save targets").props.onPress();
  assert.equal(saved[0].protein, 112);
  assert.equal(bulk.store.currentGoal().program.custom, undefined);

  // Typed protein carries through later steps, which still allocate as the program would.
  const moreCarbs = { ...low, protein: 1.6, diet: "lower-fat" };
  const typed = [];
  const typedProps = {
    ...props,
    start: program.programMacros(2000, 80, moreCarbs),
    program: moreCarbs,
    onSave: (targets) => typed.push(targets),
  };
  const typedAdjust = adjusterScreen(bulk);
  labelled(typedAdjust(typedProps), "Protein in grams").props.onChangeText("150");
  labelled(typedAdjust(typedProps), "50 kcal more").props.onPress();
  shown(typedAdjust(typedProps), "Button", "Save targets").props.onPress();
  const plan = { ...moreCarbs, custom: { proteinG: 150 } };
  assert.deepEqual(typed, [program.programMacros(2138, 80, plan)]);
  assert.deepEqual(program.adjustedProgram(moreCarbs, typed[0], 80), plan);
  bulk.sqlite.close();
});

test("compiled check-in offers Maintain at the goal weight once the trend reaches it", () => {
  const data = coachingDatabase("2024-02-01");
  seedProgram(data, "2024-02-01", { changes: { targetWeightKg: 80.5 } });
  const home = screenHarness(checkInDependencies(data), { weights: data.weights() });
  const { HomeCheckIn } = home.load("src/components/nutrition/home-check-in.tsx");
  const done = [];
  const tree = renderCheckIn(home, HomeCheckIn, done);
  assert.equal(shown(tree, "Button", "Accept plan").props.variant, "secondary");
  const maintain = shown(tree, "Button", "Maintain 80.5 kg");
  maintain.props.onPress();
  maintain.props.onPress();
  assert.deepEqual(done, ["Check-in done. You’re now maintaining 80.5 kg."]);
  assert.equal(data.store.currentGoal().mode, "maintain");
  assert.equal(data.db.select().from(schema.coachingGoals).all().length, 2);
  data.sqlite.close();
});

test("compiled weight history dims an ignored weigh-in and includes it again in one tap", () => {
  const Timeline = Object.assign(() => null, {
    Item: "Item",
    Rail: "Rail",
    Content: "Content",
    Title: "Title",
    Description: "Description",
  });
  const screen = screenHarness(
    {
      "./metrics": metrics,
      "@expo/vector-icons": { Feather: "Feather" },
      "heroui-native": { useThemeColor: () => "#000000" },
      "heroui-native-pro": { Timeline },
    },
    { t: (key) => ({ weight: "Weight" })[key] ?? key }
  );
  const { MeasurementHistory } = screen.load("src/components/measurements/measurement-history.tsx");
  const calls = [];
  const rows = [
    { id: 2, measuredAt: "2024-01-21", values: { weight: 76.9 }, excluded: true },
    { id: 1, measuredAt: "2024-01-20", values: { weight: 80 }, excluded: false },
  ];
  const tree = nodes(
    screen.render(MeasurementHistory, {
      log: {
        rows,
        fields: ["weight"],
        format: (key, value) => `${value} kg`,
        limit: 30,
        setLimit() {},
        launch() {},
        exclude: (row, excluded) => calls.push([row.id, excluded]),
      },
    })
  );
  const includes = tree.filter(
    (node) => node.type === "Button" && node.props.children === "Include"
  );
  assert.equal(includes.length, 1);
  includes[0].props.onPress();
  assert.deepEqual(calls, [[2, false]]);
  const labels = tree
    .filter((node) => node.type === "Description")
    .map((node) => node.props.children);
  assert.deepEqual(labels, ["Weight · Ignored", "Weight"]);
  const dimmed = tree.filter((node) => /opacity-50/.test(node.props.className ?? ""));
  assert.equal(dimmed.length, 2, "the ignored row's date and value");
});
