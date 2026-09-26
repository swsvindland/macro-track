const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, readdirSync } = require("node:fs");
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
// Weekends higher, as a weekday (0 = Sunday) list.
const weekends = { days: [0, 6], size: 15, unit: "%" };

const sum = (week, key) => week.reduce((total, day) => total + day[key], 0);
const energy = (targets) => targets.protein * 4 + targets.carbs * 4 + targets.fat * 9;
const days = (from, count) => Array.from({ length: count }, (_, i) => nutrition.shiftDay(from, i));

/** A migrated in-memory database with the diary and coaching modules on a clock the test sets. */
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
  const insights = load("src/lib/insights.ts", {
    "@/db": dbModule,
    "./coaching-store": store,
    "./metrics": fakeMetrics,
    "./nutrition": nutrition,
    "./program": program,
  });
  return { sqlite, db, clock, fakeMetrics, diary, store, insights };
}

/**
 * A cut running since Jan 1: 2,400 kcal logged on each of the 21 days before `day`, and a
 * weigh-in at local noon on each of those days and the one before them.
 */
function seedProgram({ db, diary }, day, changes = {}) {
  db.insert(schema.coachingGoals)
    .values({
      mode: "lose",
      pace: 0.25,
      startedDay: "2024-01-01",
      program: { ...profile, initialExpenditure: 2600, ...changes },
    })
    .run();
  diary.saveTargets("2024-01-01", { calories: 2200, protein: 150, carbs: 250, fat: 66 });
  for (let i = -22; i < 0; i++) {
    const date = nutrition.shiftDay(day, i);
    if (i >= -21) {
      diary.saveEntry({ day: date, meal: "Breakfast", food, amount: 1, portionLabel: "1 serving" });
      diary.setDayStatus(date, "complete");
    }
    db.insert(schema.weightEntries)
      .values({ weightKg: 80, measuredAt: new Date(`${date}T12:00:00`).toISOString() })
      .run();
  }
}

test("calorie shifting keeps the week at seven budgets, protein fixed and macros adding up", () => {
  const budgets = [
    { calories: 1738, protein: 184, carbs: 119, fat: 57 },
    { calories: 2200, protein: 150, carbs: 250, fat: 67 },
    { calories: 1543, protein: 130, carbs: 101, fat: 66 },
    { calories: 3105, protein: 200, carbs: 390, fat: 85 },
  ];
  const patterns = [
    { days: [6], size: 20, unit: "%" },
    { days: [1, 3, 4], size: 49, unit: "kcal" },
    weekends,
    { days: [1, 2, 3, 4, 5], size: 5, unit: "%" },
    { days: [0, 1, 2, 3, 4, 5], size: 3, unit: "%" },
    { days: [5, 6], size: 333, unit: "kcal" },
  ];
  for (const targets of budgets)
    for (const shift of patterns) {
      const label = `${targets.calories} kcal, ${JSON.stringify(shift)}`;
      const week = nutrition.shiftWeek(targets, shift);
      assert.equal(week.length, 7);
      assert.equal(sum(week, "calories"), 7 * targets.calories, label);
      assert.equal(sum(week, "carbs"), 7 * targets.carbs, label);
      assert.equal(sum(week, "fat"), 7 * targets.fat, label);
      const raise = shift.unit === "%" ? (targets.calories * shift.size) / 100 : shift.size;
      const high = week.filter((_, day) => shift.days.includes(day)).map((day) => day.calories),
        low = week.filter((_, day) => !shift.days.includes(day)).map((day) => day.calories);
      assert.ok(Math.max(...high) - Math.min(...high) <= 1, label);
      assert.ok(Math.max(...low) - Math.min(...low) <= 1, label);
      assert.ok(Math.min(...high) > Math.max(...low), label);
      for (const kcal of high) assert.ok(Math.abs(kcal - targets.calories - raise) <= 1, label);
      for (const day of week) {
        assert.equal(day.protein, targets.protein, label);
        for (const key of ["calories", "carbs", "fat"]) assert.ok(Number.isInteger(day[key]));
        // Each day's grams carry the same energy as its calories, within one gram of carbs.
        const drift = energy(day) - day.calories - (energy(targets) - targets.calories);
        assert.ok(Math.abs(drift) < 4, `${label}: ${drift}`);
      }
    }

  // The owner's MacroFactor week: three higher days, 1,787 and 1,702 kcal on the same protein.
  const owner = nutrition.shiftWeek(
    { calories: 1738, protein: 184, carbs: 119, fat: 57 },
    { days: [1, 3, 4], size: 49, unit: "kcal" }
  );
  assert.deepEqual(
    owner.map((day) => day.calories),
    [1702, 1787, 1701, 1787, 1787, 1701, 1701]
  );
  // Carbs and fat share the change in their current split: more carbs than fat grams.
  assert.ok(owner[1].carbs - owner[0].carbs > owner[1].fat - owner[0].fat);

  // A day reads its own weekday: Feb 5, 2024 is a Monday.
  const budget = budgets[1];
  assert.deepEqual(
    nutrition.shiftedTargets(budget, weekends, "2024-02-10"),
    nutrition.shiftWeek(budget, weekends)[6]
  );
  assert.deepEqual(
    nutrition.shiftedTargets(budget, weekends, "2024-02-05"),
    nutrition.shiftWeek(budget, weekends)[1]
  );
});

test("no shift leaves every day as it is, and a shift that can't apply falls back to the budget", () => {
  const targets = { calories: 2200, protein: 150, carbs: 250, fat: 66.667 };
  for (const shift of [undefined, null, { days: [], size: 10, unit: "%" }]) {
    assert.ok(nutrition.shiftWeek(targets, shift).every((day) => day === targets));
    assert.equal(nutrition.shiftedTargets(targets, shift, "2024-02-10"), targets);
  }
  // Almost all protein: the lower days would need negative carbs and fat.
  const lean = { calories: 1500, protein: 370, carbs: 2, fat: 1 };
  const big = { days: [6], size: 300, unit: "kcal" };
  assert.throws(() => nutrition.shiftWeek(lean, big), /run out of carbs and fat/);
  assert.equal(nutrition.shiftedTargets(lean, big, "2024-02-10"), lean);
});

test("a shift needs one to six higher days and keeps the other days at 75% or more", () => {
  const budget = { calories: 2200, protein: 150, carbs: 250, fat: 67 };
  for (const shift of [
    { days: [], size: 10, unit: "%" },
    { days: [0, 1, 2, 3, 4, 5, 6], size: 10, unit: "%" },
    { days: [1, 1], size: 10, unit: "%" },
    { days: [7], size: 10, unit: "%" },
    { days: [1.5], size: 10, unit: "%" },
    { days: [6], size: 0, unit: "%" },
    { days: [6], size: 60, unit: "%" },
    { days: [6], size: 5, unit: "kcal" },
    { days: [6], size: NaN, unit: "kcal" },
    { days: [6], size: 10, unit: "g" },
  ])
    assert.throws(
      () => program.validateShift(shift),
      /one to six higher days/,
      JSON.stringify(shift)
    );
  program.validateShift({ days: [1, 3, 4], size: 10, unit: "%" }, budget);
  program.validateShift({ days: [6], size: 1000, unit: "kcal" }, budget);
  // Six days 10% higher take 60% from the seventh.
  assert.throws(
    () => program.validateShift({ days: [0, 1, 2, 3, 4, 5], size: 10, unit: "%" }, budget),
    /more than a quarter/
  );
  // A program checks its shift's shape; its budget is checked when the targets are known.
  assert.throws(
    () =>
      program.validateProgram({
        ...profile,
        initialExpenditure: 2600,
        shift: { days: [9], size: 10, unit: "%" },
      }),
    /one to six higher days/
  );
  program.validateProgram({ ...profile, initialExpenditure: 2600, shift: weekends });
});

test("targets follow the program running each day, and earlier days never change", () => {
  const data = coachingDatabase("2024-01-01");
  const { db, clock, diary, store, insights, sqlite } = data;
  const draft = { ...profile, checkInDay: 1 };
  store.createProgram("lose", 0.25, draft);
  const first = diary.baseTargetsForDay("2024-01-01");
  const before = days("2024-01-01", 9).map(diary.targetsForDay);
  assert.ok(before.every((targets) => JSON.stringify(targets) === JSON.stringify(first)));
  const stored = db.select().from(schema.nutritionTargets).all();

  // Wednesday Jan 10: weekends get 15% more from here on.
  clock.today = "2024-01-10";
  store.createProgram("lose", 0.25, { ...draft, shift: weekends });
  assert.deepEqual(store.currentGoal().program.shift, weekends);
  assert.deepEqual(days("2024-01-01", 9).map(diary.targetsForDay), before);
  assert.deepEqual(
    db
      .select()
      .from(schema.nutritionTargets)
      .all()
      .filter((row) => row.effectiveDay < "2024-01-10"),
    stored
  );
  const budget = diary.baseTargetsForDay("2024-01-10");
  const shifted = days("2024-01-10", 14).map(diary.targetsForDay);
  assert.deepEqual(
    shifted,
    days("2024-01-10", 14).map((day) => nutrition.shiftedTargets(budget, weekends, day))
  );
  // Sat Jan 13 and Sun Jan 14 are higher; Monday is lower; protein holds.
  assert.ok(diary.targetsForDay("2024-01-13").calories > budget.calories);
  assert.ok(diary.targetsForDay("2024-01-14").calories > budget.calories);
  assert.ok(diary.targetsForDay("2024-01-15").calories < budget.calories);
  assert.ok(shifted.every((targets) => targets.protein === budget.protein));
  // Any seven days in a row, not just a calendar week, add up to seven budgets.
  for (let start = 0; start < 8; start++)
    assert.equal(sum(shifted.slice(start, start + 7), "calories"), 7 * budget.calories);
  // Check-ins and the Plan card see the budget itself.
  assert.deepEqual(store.coachingSnapshot().targets, budget);

  // Progress reads the same targets, so a week eaten exactly on target is exactly on budget.
  const targetOn = insights.targetTimeline();
  for (const day of days("2024-01-01", 23))
    assert.deepEqual(targetOn(day), diary.targetsForDay(day), day);
  const week = days("2024-01-15", 7);
  const intake = new Map(
    week.map((day) => [day, { ...diary.targetsForDay(day), entries: 1, status: "complete" }])
  );
  const onTarget = insights.weekBudget(
    insights.weekDays("2024-01-15", intake, targetOn),
    "2024-01-21"
  );
  assert.equal(onTarget.balance, 0);
  assert.equal(onTarget.averageTarget, budget.calories);

  // Switching to manual targets stops shifting from that day.
  clock.today = "2024-01-20";
  store.saveGoal("manual", 0);
  assert.deepEqual(diary.targetsForDay("2024-01-20"), budget);
  assert.deepEqual(diary.targetsForDay("2024-01-13"), shifted[3]);
  sqlite.close();
});

test("a check-in reviews the daily budget and re-applies the shift to what it proposes", () => {
  const plain = coachingDatabase("2024-02-01"),
    shifting = coachingDatabase("2024-02-01");
  seedProgram(plain, "2024-02-01");
  seedProgram(shifting, "2024-02-01", { shift: weekends });
  const review = shifting.store.currentReview();
  assert.equal(review.status, "ready");
  assert.deepEqual(review, plain.store.currentReview());
  assert.deepEqual(shifting.store.coachingSnapshot().targets, {
    calories: 2200,
    protein: 150,
    carbs: 250,
    fat: 66,
  });
  const { diary, store } = shifting;
  const yesterday = diary.targetsForDay("2024-01-31");
  assert.deepEqual(store.finishCheckIn("accepted"), review.proposed);
  assert.deepEqual(store.checkInHistory()[0].targets, review.proposed);
  assert.deepEqual(diary.baseTargetsForDay("2024-02-01"), review.proposed);
  const week = days("2024-02-01", 7).map(diary.targetsForDay);
  assert.deepEqual(
    week,
    days("2024-02-01", 7).map((day) => nutrition.shiftedTargets(review.proposed, weekends, day))
  );
  assert.equal(sum(week, "calories"), 7 * review.proposed.calories);
  assert.deepEqual(diary.targetsForDay("2024-01-31"), yesterday, "earlier days keep theirs");
  plain.sqlite.close();

  // Adjusted by hand, the program's new revision keeps its shift.
  const adjusting = coachingDatabase("2024-02-01");
  seedProgram(adjusting, "2024-02-01", { shift: weekends });
  const adjusted = { calories: 2300, protein: 170, carbs: 240, fat: 70 };
  adjusting.store.finishCheckIn("adjusted", adjusted);
  const goal = adjusting.store.currentGoal();
  assert.equal(goal.program.custom.proteinG, 170);
  assert.deepEqual(goal.program.shift, weekends);
  assert.deepEqual(
    adjusting.diary.targetsForDay("2024-02-03"),
    nutrition.shiftWeek(adjusted, weekends)[6]
  );
  shifting.sqlite.close();
  adjusting.sqlite.close();
});

test("every shifted day stays in the coached range, and a shift a new budget can't fit pauses", () => {
  const owner = { calories: 1738, protein: 184, carbs: 119, fat: 57 };
  const threeDays = { days: [1, 3, 5], size: 20, unit: "%" };
  // Four days of 1,477 kcal: under a quarter less, but below what coaching supports.
  assert.throws(() => program.validateShift(threeDays, owner), /1,500 and 5,000 kcal/);
  assert.throws(
    () => program.validateShift(threeDays, { calories: 1600, protein: 150, carbs: 120, fat: 58 }),
    /1,500 and 5,000 kcal/
  );
  assert.throws(
    () =>
      program.validateShift(
        { days: [6], size: 10, unit: "%" },
        { calories: 4800, protein: 200, carbs: 650, fat: 155 }
      ),
    /1,500 and 5,000 kcal/
  );
  const macroFactor = { days: [1, 3, 4], size: 49, unit: "kcal" };
  program.validateShift(macroFactor, owner);
  assert.deepEqual(
    nutrition.coachedWeek(owner, macroFactor),
    nutrition.shiftWeek(owner, macroFactor)
  );
  assert.equal(nutrition.shiftedTargets(owner, threeDays, "2024-02-05"), owner);

  // 300 kcal more on weekends fits 2,200 kcal, but not a budget adjusted down to 1,600.
  const data = coachingDatabase("2024-02-01");
  const weekendKcal = { days: [0, 6], size: 300, unit: "kcal" };
  seedProgram(data, "2024-02-01", { shift: weekendKcal });
  const { diary, store, insights } = data;
  const before = diary.targetsForDay("2024-01-27");
  assert.equal(before.calories, 2500);
  const lower = { calories: 1600, protein: 150, carbs: 138, fat: 50 };
  store.finishCheckIn("adjusted", lower);
  assert.deepEqual(store.currentGoal().program.shift, weekendKcal);
  const targetOn = insights.targetTimeline();
  for (const day of days("2024-02-01", 7)) {
    assert.deepEqual(diary.targetsForDay(day), lower, day);
    assert.deepEqual(targetOn(day), lower, day);
  }
  assert.deepEqual(diary.targetsForDay("2024-01-27"), before, "earlier days keep theirs");
  const card = planCard(data);
  assert.equal(
    card.find((node) => node.type === "ShiftWeek"),
    undefined
  );
  assert.ok(card.some((node) => node.type === "Text" && text(node) === " kcal/day"));
  assert.ok(card.some((node) => node.type === "Text" && /shifting is paused/.test(text(node))));
  data.sqlite.close();
});

test("changing only the shift keeps the budget a check-in kept or adjusted", () => {
  for (const decision of ["kept", "adjusted"]) {
    const data = coachingDatabase("2024-02-01");
    seedProgram(data, "2024-02-01");
    const { db, clock, diary, store } = data;
    const review = store.currentReview();
    assert.notEqual(review.proposed.calories, 2200);
    if (decision === "kept") store.finishCheckIn("kept");
    else store.finishCheckIn("adjusted", { calories: 2300, protein: 170, carbs: 240, fat: 70 });
    const budget = diary.baseTargetsForDay("2024-02-01"),
      program = store.currentGoal().program,
      due = store.nextCheckInDay(),
      stored = db.select().from(schema.nutritionTargets).all();

    clock.today = "2024-02-02";
    store.saveShift(weekends);
    assert.deepEqual(diary.baseTargetsForDay("2024-02-02"), budget, decision);
    assert.deepEqual(db.select().from(schema.nutritionTargets).all(), stored);
    assert.deepEqual(diary.targetsForDay("2024-02-03"), nutrition.shiftWeek(budget, weekends)[6]);
    assert.deepEqual(diary.targetsForDay("2024-02-01"), budget, "earlier days keep theirs");
    const goal = store.currentGoal();
    assert.equal(goal.startedDay, "2024-02-02");
    assert.deepEqual(goal.program, {
      ...program,
      initialExpenditure: review.expenditure,
      shift: weekends,
    });
    assert.equal(store.nextCheckInDay(), due);
    // The next review still starts from this check-in's estimate.
    clock.today = due;
    assert.equal(store.currentReview().expenditure, review.expenditure);

    clock.today = "2024-02-03";
    store.saveShift();
    assert.equal(store.currentGoal().program.shift, undefined);
    assert.deepEqual(diary.targetsForDay("2024-02-03"), budget);
    assert.deepEqual(diary.targetsForDay("2024-02-02"), nutrition.shiftWeek(budget, weekends)[5]);
    assert.deepEqual(diary.targetsForDay("2024-02-10"), budget);
    assert.throws(
      () => store.saveShift({ days: [0, 1, 2, 3, 4, 5], size: 20, unit: "%" }),
      /more than a quarter/
    );
    store.saveGoal("manual", 0);
    assert.throws(() => store.saveShift(weekends), /Set up your program/);
    data.sqlite.close();
  }
});

test("programs without a shift read targets exactly as stored", () => {
  const data = coachingDatabase("2024-02-01");
  seedProgram(data, "2024-02-01");
  const stored = { calories: 2200, protein: 150, carbs: 250, fat: 66 };
  const targetOn = data.insights.targetTimeline();
  for (const day of days("2024-01-01", 45)) {
    assert.deepEqual(data.diary.targetsForDay(day), stored);
    assert.deepEqual(data.diary.baseTargetsForDay(day), stored);
    assert.deepEqual(targetOn(day), stored);
  }
  assert.equal(data.diary.targetsForDay("2023-12-31"), null);
  data.sqlite.close();
});

test("backups and the targets CSV carry the shift, and older backups restore without one", () => {
  const data = coachingDatabase("2024-02-01");
  const { db, diary, store, sqlite } = data;
  seedProgram(data, "2024-02-01", { shift: { days: [1, 3, 4], size: 49, unit: "kcal" } });
  const backup = load("src/lib/backup-data.ts", {
    "@/db": { db, ...schema },
    "./nutrition": nutrition,
  });
  const copy = backup.createBackup();
  backup.restoreBackup(copy);
  assert.deepEqual(store.currentGoal().program.shift, { days: [1, 3, 4], size: 49, unit: "kcal" });
  assert.equal(diary.targetsForDay("2024-01-29").calories, 2249);

  const ownership = load("src/lib/data-ownership.ts", { "@/db": { db, ...schema } });
  const rows = ownership
    .exportTargetsCsv()
    .replace(/^﻿/, "")
    .trimEnd()
    .split("\r\n")
    .map((line) => JSON.parse(`[${line}]`));
  assert.deepEqual(rows, [
    [
      "date",
      "goal",
      "calories_kcal",
      "protein_g",
      "carbs_g",
      "fat_g",
      "higher_days",
      "higher_day_extra",
    ],
    ["2024-01-01", "lose", "2200", "150", "250", "66", "Mon Wed Thu", "49 kcal"],
  ]);

  const legacy = structuredClone(copy);
  legacy.data.goals.forEach((row) => delete row.program?.shift);
  backup.restoreBackup(legacy);
  assert.equal(store.currentGoal().program.shift, undefined);
  assert.deepEqual(diary.targetsForDay("2024-01-29"), diary.baseTargetsForDay("2024-01-29"));

  for (const shift of [
    { days: [7], size: 10, unit: "%" },
    { days: [1, 1], size: 10, unit: "%" },
    { days: [1], size: 10, unit: "g" },
    { days: [1], size: 10, unit: "%", extra: true },
  ]) {
    const invalid = structuredClone(copy);
    invalid.data.goals[0].program.shift = shift;
    assert.throws(() => backup.validateBackup(invalid), JSON.stringify(shift));
  }
  sqlite.close();
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
    units: "metric",
    language: "en",
    weights: [],
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
    "expo-localization": { useCalendars: () => [{ firstWeekday: 2 }] },
    "@/components/system": {
      SystemButton: "Button",
      SystemLabel: "Label",
      SystemPanel: { Body: "PanelBody" },
      SystemText: "Text",
    },
    "@/components/ui": {
      Choices: "Choices",
      Editor: "Editor",
      ErrorText: "Error",
      Field: "Field",
    },
    "@/lib/metrics": metrics,
    "./metrics": metrics,
    "@/lib/nutrition": nutrition,
    "@/lib/program": program,
    "@/lib/store": { useStore: () => store },
    "./store": { useStore: () => store },
    ...dependencies,
  };
  all["@/lib/nutrition-store"] = load("src/lib/nutrition-store.tsx", all, true);
  return {
    context,
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
const text = (node) => [node.props.children].flat().join("");

test("compiled shift picker toggles higher days from the locale's first weekday", () => {
  const budget = { calories: 2200, protein: 150, carbs: 250, fat: 67 };
  const changes = [];
  const picker = (value) => {
    const harness = screenHarness();
    const { CalorieShiftPicker } = harness.load("src/components/plan/calorie-shift.tsx");
    const props = { value, budget, onChange: (shift) => changes.push(shift) };
    return { tree: () => nodes(harness.render(CalorieShiftPicker, props)) };
  };
  const dayButtons = (tree) =>
    tree.filter(
      (node) => node.type === "Button" && /^Higher calories on /.test(node.props.accessibilityLabel)
    );

  // Off: seven weekday toggles, Monday first here, and nothing else to choose.
  let tree = picker().tree();
  assert.deepEqual(
    dayButtons(tree).map((node) => node.props.children),
    ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
  );
  assert.equal(
    tree.find((node) => node.type === "Choices"),
    undefined
  );
  dayButtons(tree)[0].props.onPress();
  assert.deepEqual(changes.pop(), { days: [1], size: 10, unit: "%" });

  // On: sizes, and the week it makes.
  const shift = { days: [1, 3, 4], size: 10, unit: "%" };
  const on = picker(shift);
  tree = on.tree();
  assert.deepEqual(
    dayButtons(tree).map((node) => node.props.accessibilityState.selected),
    [true, false, true, true, false, false, false]
  );
  const sizes = tree.find((node) => node.type === "Choices");
  assert.deepEqual(sizes.props.values, ["5", "10", "15", "20", "kcal"]);
  assert.equal(sizes.props.value, "10");
  assert.equal(sizes.props.label("15"), "+15%");
  const preview = tree.find((node) => typeof node.type === "function");
  assert.deepEqual(preview.props, { targets: budget, shift });
  // Rendered on its own hook slots, as React would.
  const own = screenHarness();
  const { ShiftWeek } = own.load("src/components/plan/calorie-shift.tsx");
  assert.equal(preview.type.name, "ShiftWeek");
  const week = nodes(own.render(ShiftWeek, preview.props)).filter(
    (node) => node.props.accessibilityLabel
  );
  const expected = nutrition.shiftWeek(budget, shift);
  assert.deepEqual(
    week.map((node) => node.props.accessibilityLabel),
    [
      `Monday, ${expected[1].calories.toFixed(0)} kcal, higher day`,
      `Tuesday, ${expected[2].calories.toFixed(0)} kcal`,
      `Wednesday, ${expected[3].calories.toFixed(0)} kcal, higher day`,
      `Thursday, ${expected[4].calories.toFixed(0)} kcal, higher day`,
      `Friday, ${expected[5].calories.toFixed(0)} kcal`,
      `Saturday, ${expected[6].calories.toFixed(0)} kcal`,
      `Sunday, ${expected[0].calories.toFixed(0)} kcal`,
    ]
  );
  dayButtons(tree)[2].props.onPress();
  assert.deepEqual(changes.pop(), { days: [1, 4], size: 10, unit: "%" });
  sizes.props.onChange("20");
  assert.deepEqual(changes.pop(), { days: [1, 3, 4], size: 20, unit: "%" });
  sizes.props.onChange("kcal");
  assert.deepEqual(changes.pop(), { days: [1, 3, 4], size: NaN, unit: "kcal" });
  assert.equal(tree.find((node) => node.type === "Error").props.message, "");

  // A kcal size is typed; an empty field isn't an error while it's typed.
  const typing = picker({ days: [6], size: NaN, unit: "kcal" });
  tree = typing.tree();
  assert.equal(tree.find((node) => node.type === "Error").props.message, "");
  tree.find((node) => node.type === "Field").props.onChange("150");
  assert.deepEqual(changes.pop(), { days: [6], size: 150, unit: "kcal" });

  // Too much: the reason shows instead of the week, and a seventh day can't be added.
  tree = picker({ days: [0, 1, 2, 3, 4, 5], size: 20, unit: "%" }).tree();
  assert.match(tree.find((node) => node.type === "Error").props.message, /more than a quarter/);
  assert.equal(
    tree.find((node) => typeof node.type === "function"),
    undefined
  );
  assert.equal(dayButtons(tree)[5].props.isDisabled, true, "Saturday");
  assert.equal(dayButtons(tree)[0].props.isDisabled, false);
});

test("compiled program editor previews the budget and saves the shift with the program", () => {
  const data = coachingDatabase("2024-01-10");
  const { db, diary, store, fakeMetrics, sqlite } = data;
  const harness = screenHarness({
    "@/lib/coaching-store": store,
    "@/lib/diary": diary,
    "@/lib/metrics": fakeMetrics,
    "./metrics": fakeMetrics,
    "@/components/plan/calorie-shift": { CalorieShiftPicker: "CalorieShiftPicker" },
  });
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
  render()
    .find((node) => node.type === "Button" && node.props.accessibilityState?.checked === false)
    .props.onPress();
  let tree = render();
  let picker = tree.find((node) => node.type === "CalorieShiftPicker");
  assert.equal(picker.props.value, undefined, "off by default");
  const budget = picker.props.budget;
  assert.ok(budget.calories > 1500);
  assert.equal(
    tree.find((node) => node.type === "Text" && text(node) === "Average across the week"),
    undefined
  );
  const start = () =>
    render()
      .find((node) => node.type === "Button" && node.props.children === "Start this program")
      .props.onPress();

  // A shift too big for the budget stops the save with its reason.
  picker.props.onChange({ days: [0, 1, 2, 3, 4, 5], size: 20, unit: "%" });
  start();
  assert.match(render().find((node) => node.type === "Error").props.message, /more than a quarter/);
  assert.equal(db.select().from(schema.coachingGoals).all().length, 0);

  picker = render().find((node) => node.type === "CalorieShiftPicker");
  picker.props.onChange(weekends);
  tree = render();
  picker = tree.find((node) => node.type === "CalorieShiftPicker");
  assert.deepEqual(picker.props.value, weekends);
  assert.deepEqual(picker.props.budget, budget, "the preview stays the unshifted budget");
  assert.ok(tree.find((node) => node.type === "Text" && text(node) === "Average across the week"));
  start();
  assert.equal(closed, 1);
  assert.deepEqual(store.currentGoal().program.shift, weekends);
  assert.deepEqual(diary.baseTargetsForDay("2024-01-10"), budget);
  assert.deepEqual(diary.targetsForDay("2024-01-13"), nutrition.shiftWeek(budget, weekends)[6]);

  // Reopened, the editor starts from the saved shift.
  const reopened = screenHarness({
    "@/lib/coaching-store": store,
    "@/lib/diary": diary,
    "@/lib/metrics": fakeMetrics,
    "./metrics": fakeMetrics,
    "@/components/plan/calorie-shift": { CalorieShiftPicker: "CalorieShiftPicker" },
  });
  const editor = reopened.load("src/components/nutrition/program-editor.tsx").ProgramEditor;
  assert.deepEqual(
    nodes(reopened.render(editor, { close() {} })).find(
      (node) => node.type === "CalorieShiftPicker"
    ).props.value,
    weekends
  );
  sqlite.close();
});

/** The Plan card's compiled tree for a database, with the real check for whether a shift fits. */
function planCard(data) {
  const { weekOf } = screenHarness().load("src/components/plan/calorie-shift.tsx");
  const harness = screenHarness({
    "react-native": { View: "View", AppState: {}, Alert: { alert() {} } },
    "@/lib/coaching-store": data.store,
    "@/lib/diary": data.diary,
    "@/lib/metrics": data.fakeMetrics,
    "./metrics": data.fakeMetrics,
    "@/components/system": {
      SystemButton: "Button",
      SystemIconButton: "IconButton",
      SystemLabel: "Label",
      SystemPanel: { Body: "PanelBody" },
      SystemText: "Text",
    },
    "@/components/ui": { ActionMenu: "ActionMenu", ErrorText: "Error" },
    "@/components/plan/calorie-shift": { ShiftWeek: "ShiftWeek", weekOf },
    "./check-in-adjuster": { CheckInAdjuster: "CheckInAdjuster" },
    "./home-check-in": { OutlierPrompt: "OutlierPrompt" },
    "./program-editor": { ProgramEditor: "ProgramEditor" },
  });
  const { CoachingPanel } = harness.load("src/components/nutrition/coaching-panel.tsx");
  return nodes(harness.render(CoachingPanel, { onTargetsChanged() {} }));
}

test("compiled Plan card shows the budget as a weekly average with the shifted week", () => {
  const data = coachingDatabase("2024-02-01");
  seedProgram(data, "2024-02-01", { shift: weekends });
  const tree = planCard(data);
  const budget = { calories: 2200, protein: 150, carbs: 250, fat: 66 };
  assert.deepEqual(tree.find((node) => node.type === "ShiftWeek").props, {
    targets: budget,
    shift: weekends,
  });
  assert.ok(tree.some((node) => node.type === "Text" && text(node) === " kcal/day on average"));
  // The due check-in proposes a new budget from the old one, not from Thursday's target.
  const proposal = tree.find((node) => node.type === "Text" && text(node).includes("→"));
  const proposed = data.store.currentReview().proposed.calories;
  assert.equal(text(proposal), `2200 → ${proposed} kcal/day`);
  data.sqlite.close();
});

test("compiled program editor saves a shift alone without rebuilding the budget", () => {
  const data = coachingDatabase("2024-02-01");
  seedProgram(data, "2024-02-01");
  const { clock, diary, store, fakeMetrics, sqlite } = data;
  store.finishCheckIn("kept");
  clock.today = "2024-02-02";
  const kept = diary.baseTargetsForDay("2024-02-02");
  const harness = screenHarness({
    "@/lib/coaching-store": store,
    "@/lib/diary": diary,
    "@/lib/metrics": fakeMetrics,
    "./metrics": fakeMetrics,
    "@/components/plan/calorie-shift": { CalorieShiftPicker: "CalorieShiftPicker" },
  });
  const { ProgramEditor } = harness.load("src/components/nutrition/program-editor.tsx");
  let closed = 0;
  const render = () => nodes(harness.render(ProgramEditor, { close: () => closed++ }));
  const button = (tree, label) =>
    tree.find((node) => node.type === "Button" && node.props.children === label);
  const eligibility = (tree) =>
    tree.find(
      (node) => node.type === "Button" && node.props.accessibilityState?.checked !== undefined
    );

  // Untouched, the editor offers to rebuild the program from the latest estimate.
  let tree = render();
  const rebuilt = tree.find((node) => node.type === "CalorieShiftPicker").props.budget;
  assert.notEqual(rebuilt.calories, kept.calories);
  assert.ok(button(tree, "Start this program"));
  assert.ok(eligibility(tree));

  // Weekends alone: today's budget stays, with no program restart to confirm.
  tree.find((node) => node.type === "CalorieShiftPicker").props.onChange(weekends);
  tree = render();
  assert.deepEqual(tree.find((node) => node.type === "CalorieShiftPicker").props.budget, kept);
  assert.ok(
    tree.some(
      (node) => node.type === "Text" && text(node) === "Your current budget, as a weekly average"
    )
  );
  assert.equal(eligibility(tree), undefined);
  const save = button(tree, "Save calorie shifting");
  assert.equal(save.props.isDisabled, false);
  save.props.onPress();
  assert.equal(closed, 1);
  assert.deepEqual(diary.baseTargetsForDay("2024-02-02"), kept);
  assert.deepEqual(store.currentGoal().program.shift, weekends);
  assert.deepEqual(diary.targetsForDay("2024-02-03"), nutrition.shiftWeek(kept, weekends)[6]);

  // Any other change rebuilds the program, shift and all.
  tree = render();
  assert.ok(button(tree, "Start this program"));
  tree
    .find((node) => node.type === "Choices" && node.props.values.includes("0.5"))
    .props.onChange("0.5");
  tree = render();
  assert.ok(button(tree, "Start this program"));
  assert.notDeepEqual(tree.find((node) => node.type === "CalorieShiftPicker").props.budget, kept);
  sqlite.close();
});
