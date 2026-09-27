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

test("a cut can run up to 1.5% a week for a mini-cut, and a bulk up to 0.5%", () => {
  const { store, sqlite } = coachingDatabase("2024-01-01");
  const draft = { ...profile, activity: "high", checkInDay: 1 };
  const expenditure = program.initialExpenditure(draft);
  const kcal = (mode, pace, changes = {}) =>
    store.previewProgram(mode, pace, { ...draft, ...changes }).targets.calories;
  // 1.5% of 80 kg is 1.2 kg a week, 1,320 kcal a day under the estimate.
  assert.equal(kcal("lose", 1.5), expenditure - 1320);
  assert.equal(kcal("lose", 0.1), expenditure - 88);
  assert.equal(kcal("gain", 0.5, { targetWeightKg: 90 }), expenditure + 440);
  assert.throws(() => kcal("lose", 1.55), /supported goal and pace/);
  assert.throws(() => kcal("gain", 0.55, { targetWeightKg: 90 }), /supported goal and pace/);
  // The calorie floor still applies to a fast cut from a small budget.
  assert.throws(() => kcal("lose", 1.5, { activity: "low" }), /Choose a slower pace/);
  sqlite.close();
});

test("compiled pace slider marks the recommended band and lands on its steps", () => {
  const changes = [];
  const slider = { Track: "Track", Fill: "Fill", Thumb: "Thumb" };
  const harness = screenHarness({
    "heroui-native": {
      Slider: slider,
      useSlider: () => ({ minValue: 0.1, maxValue: 1.5, trackSize: 308, thumbSize: 28 }),
    },
  });
  const { PaceSlider } = harness.load("src/components/plan/pace-slider.tsx");
  const render = (mode, value) =>
    nodes(
      harness.render(PaceSlider, { mode, value, weightKg: 80, onChange: (v) => changes.push(v) })
    );

  let tree = render("lose", 1.25);
  const root = tree.find((node) => node.type === slider);
  assert.deepEqual([root.props.minValue, root.props.maxValue, root.props.step], [0.1, 1.5, 0.05]);
  const thumb = tree.find((node) => node.type === "Thumb");
  assert.equal(thumb.props.accessibilityValue.text, "1.25% of body weight · −1.0 kg/wk");
  assert.equal(thumb.props.accessibilityHint, "Recommended 0.5–1% of body weight a week");
  // Drags and screen-reader adjustments land on whole steps inside the range.
  root.props.onChange(0.7000000000000001);
  root.props.onChange([2]);
  thumb.props.onAccessibilityAction({ nativeEvent: { actionName: "increment" } });
  thumb.props.onAccessibilityAction({ nativeEvent: { actionName: "decrement" } });
  assert.deepEqual(changes, [0.7, 1.5, 1.3, 1.2]);
  assert.ok(tree.some((node) => node.type === "Text" && text(node) === "Recommended 0.5–1%"));
  assert.ok(tree.some((node) => node.type === "Text" && /mini-cut of 2–4 weeks/.test(text(node))));
  // The band sits where the thumb's centre is at 0.5% and 1%.
  const band = tree.find((node) => typeof node.type === "function");
  const bar = nodes(band.type(band.props)).find((node) => node.props?.style);
  assert.deepEqual(
    [bar.props.style.left, bar.props.style.width].map((px) => Math.round(px * 100) / 100),
    [94, 100]
  );

  tree = render("lose", 0.75);
  assert.ok(!tree.some((node) => node.type === "Text" && /mini-cut/.test(text(node))));
  tree = render("gain", 0.25);
  assert.equal(tree.find((node) => node.type === slider).props.maxValue, 0.5);
  assert.ok(tree.some((node) => node.type === "Text" && text(node) === "Recommended 0.1–0.25%"));
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
  const card = programCard(planCard(data)).props;
  assert.deepEqual(card.week, Array(7).fill(lower), "each day gets the budget itself");
  assert.deepEqual(card.notes, [
    "Calorie shifting is paused: it doesn’t fit this budget.",
    "Trend 80.0 kg · Goal 75.0 kg · Custom macros",
  ]);
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
    "./metrics": metrics,
    "./program": program,
  });
  const copy = backup.createBackup();
  backup.restoreBackup(copy);
  assert.deepEqual(store.currentGoal().program.shift, { days: [1, 3, 4], size: 49, unit: "kcal" });
  assert.equal(diary.targetsForDay("2024-01-29").calories, 2249);

  const ownership = load("src/lib/data-ownership.ts", {
    "@/db": { db, ...schema },
    "./nutrition": load("src/lib/nutrition.ts"),
  });
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
    measurements: [],
    healthProfile: {},
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
  all["./health-schedule"] ??= { syncHealthFood: async () => {} };
  all["./widget"] ??= { updateWidget: () => {} };
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

test("a first program starts from Health's birthday and sex and the logged height", () => {
  const data = coachingDatabase("2024-01-10");
  const { diary, store, fakeMetrics, sqlite } = data;
  const editorFor = (overrides) => {
    const harness = screenHarness(
      {
        "@/lib/coaching-store": store,
        "@/lib/diary": diary,
        "@/lib/metrics": fakeMetrics,
        "./metrics": fakeMetrics,
        "@/components/plan/calorie-shift": { CalorieShiftPicker: "CalorieShiftPicker" },
        "@/components/plan/pace-slider": { PaceSlider: "PaceSlider" },
      },
      overrides
    );
    const { ProgramEditor } = harness.load("src/components/nutrition/program-editor.tsx");
    const tree = nodes(harness.render(ProgramEditor, { close() {} }));
    const field = (label) =>
      tree.find((node) => node.type === "Field" && node.props.label === label).props.value;
    const sex = tree.find((node) => node.type === "Choices" && node.props.values.includes("female"))
      .props.value;
    return { field, sex };
  };
  // The birthday is still a day away, so 33 turns 34 tomorrow.
  const known = editorFor({
    healthProfile: { birthDate: "1990-01-11", sex: "female" },
    measurements: [{ kind: "height", values: { height: 172.72 } }],
    units: "imperial",
  });
  assert.equal(known.field("Age"), "33");
  assert.equal(known.field("Height (total inches)"), "68");
  assert.equal(known.sex, "female");
  const unknown = editorFor({});
  assert.equal(unknown.field("Age"), "");
  assert.equal(unknown.field("Height (cm)"), "");
  assert.equal(unknown.sex, "");
  sqlite.close();
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
    "@/components/plan/pace-slider": { PaceSlider: "PaceSlider" },
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
    "@/components/plan/pace-slider": { PaceSlider: "PaceSlider" },
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

/** Plan's compiled coaching panel on one set of hook slots, with the real check for a shift. */
function planHarness(data) {
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
    "@/components/plan/strategy": { CheckInRing: "CheckInRing", ProgramCard: "ProgramCard" },
    "./check-in-adjuster": { CheckInAdjuster: "CheckInAdjuster" },
    "./home-check-in": { OutlierPrompt: "OutlierPrompt" },
    "./program-editor": { ProgramEditor: "ProgramEditor" },
  });
  const { CoachingPanel } = harness.load("src/components/nutrition/coaching-panel.tsx");
  return { harness, render: () => nodes(harness.render(CoachingPanel, { onTargetsChanged() {} })) };
}
const planCard = (data) => planHarness(data).render();
const programCard = (tree) => tree.find((node) => node.type === "ProgramCard");

test("compiled Plan card shows the budget as a weekly average with the shifted week", () => {
  const data = coachingDatabase("2024-02-01");
  seedProgram(data, "2024-02-01", { shift: weekends });
  const tree = planCard(data);
  const budget = { calories: 2200, protein: 150, carbs: 250, fat: 66 };
  const card = programCard(tree).props;
  assert.deepEqual(card.week, nutrition.shiftWeek(budget, weekends));
  assert.deepEqual(card.notes, [
    "2200 kcal/day on average",
    "Trend 80.0 kg · Goal 75.0 kg · Balanced",
  ]);
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
    "@/components/plan/pace-slider": { PaceSlider: "PaceSlider" },
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
  const slider = tree.find((node) => node.type === "PaceSlider");
  assert.equal(slider.props.mode, "lose");
  slider.props.onChange(1.25);
  tree = render();
  assert.ok(button(tree, "Start this program"));
  assert.notDeepEqual(tree.find((node) => node.type === "CalorieShiftPicker").props.budget, kept);
  sqlite.close();
});

test("the check-in countdown covers each cycle, and goal progress runs from the starting weight", () => {
  assert.deepEqual(program.checkInCycle("2024-01-10", "2024-01-22", "2024-01-10"), {
    days: 12,
    progress: 0,
  });
  assert.deepEqual(program.checkInCycle("2024-01-16", "2024-01-22", "2024-01-10"), {
    days: 6,
    progress: 0.5,
  });
  assert.deepEqual(program.checkInCycle("2024-01-22", "2024-01-22", "2024-01-15"), {
    days: 0,
    progress: 1,
  });
  assert.deepEqual(program.checkInCycle("2024-01-24", "2024-01-22", "2024-01-15"), {
    days: -2,
    progress: 1,
  });
  // Whole days across a daylight-saving change.
  assert.deepEqual(program.checkInCycle("2024-03-07", "2024-03-14", "2024-03-07"), {
    days: 7,
    progress: 0,
  });
  const cut = { mode: "lose", pace: 0.5, startedDay: "2024-01-01" },
    bulk = { mode: "gain", pace: 0.25, startedDay: "2024-01-01" };
  assert.equal(program.goalProgress(cut, 80, 78, 75), 0.4);
  assert.equal(program.goalProgress(cut, 80, 81, 75), 0, "moving away isn't progress");
  assert.equal(program.goalProgress(cut, 80, 74.8, 75), 1);
  assert.equal(program.goalProgress(bulk, 70, 72.5, 75), 0.5);
  assert.equal(program.goalProgress(bulk, 70, 75.2, 75), 1);
  assert.equal(program.goalProgress({ ...cut, mode: "maintain" }, 80, 80, 80), null);
  assert.equal(program.goalProgress({ ...cut, mode: "manual" }, 80, 78, 75), null);
});

test("Plan counts down from the last check-in or the program's start, dated from its first revision", () => {
  const data = coachingDatabase("2024-01-10");
  const { db, clock, store, sqlite } = data;
  assert.equal(store.planSnapshot().since, null, "nothing to date yet");
  // Wednesday Jan 10, checking in on Mondays: the first is due after a full week, Jan 22.
  store.createProgram("lose", 0.25, { ...profile, checkInDay: 1 });
  let plan = store.planSnapshot();
  assert.deepEqual(plan.since, { day: "2024-01-10", weightKg: 80 });
  assert.equal(plan.due, "2024-01-22");
  assert.deepEqual(plan.countdown, { days: 12, progress: 0 });
  assert.equal(plan.goalProgress, 0);

  clock.today = "2024-01-16";
  for (const day of days("2024-01-10", 7))
    db.insert(schema.weightEntries)
      .values({ weightKg: 78, measuredAt: new Date(`${day}T12:00:00`).toISOString() })
      .run();
  plan = store.planSnapshot();
  assert.deepEqual(plan.countdown, { days: 6, progress: 0.5 });
  assert.equal(plan.goalProgress, (80 - plan.review.trendWeightKg) / 5);
  assert.ok(plan.goalProgress > 0.3 && plan.goalProgress < 0.5);

  clock.today = "2024-01-22";
  plan = store.planSnapshot();
  assert.equal(plan.isDue, true);
  assert.deepEqual(plan.countdown, { days: 0, progress: 1 });
  store.finishCheckIn("kept");
  assert.deepEqual(store.planSnapshot().countdown, { days: 7, progress: 0 });

  // Edits are revisions of the same program.
  clock.today = "2024-01-25";
  store.saveShift(weekends);
  plan = store.planSnapshot();
  assert.deepEqual(plan.since, { day: "2024-01-10", weightKg: 80 });
  assert.deepEqual(plan.countdown, { days: 4, progress: 1 - 4 / 7 });
  clock.today = "2024-01-30";
  assert.deepEqual(store.planSnapshot().countdown, { days: -1, progress: 1 }, "overdue");

  // Another goal is another program, on the same check-in schedule.
  clock.today = "2024-01-31";
  store.createProgram("maintain", 0.25, { ...profile, checkInDay: 1, targetWeightKg: 78 });
  plan = store.planSnapshot();
  assert.equal(plan.since.day, "2024-01-31");
  assert.equal(plan.goalProgress, null, "maintenance has no distance to cover");
  assert.deepEqual(plan.countdown, { days: -2, progress: 1 });

  clock.today = "2024-02-02";
  store.saveGoal("manual", 0);
  plan = store.planSnapshot();
  assert.deepEqual(plan.since, { day: "2024-02-02", weightKg: null });
  assert.equal(plan.countdown, null);
  assert.equal(plan.goalProgress, null);

  clock.today = "2024-02-05";
  store.createProgram("lose", 0.25, { ...profile, checkInDay: 1 });
  plan = store.planSnapshot();
  assert.equal(plan.since.day, "2024-02-05", "rebuilt after manual targets");
  assert.equal(plan.due, "2024-02-12");
  assert.deepEqual(plan.countdown, { days: 7, progress: 0 });
  sqlite.close();

  // Targets set without a goal date from the first ones saved.
  const manual = coachingDatabase("2024-03-01");
  manual.diary.saveTargets("2024-02-20", { calories: 2100, protein: 150, carbs: 220, fat: 70 });
  manual.diary.saveTargets("2024-02-25", { calories: 2000, protein: 150, carbs: 200, fat: 70 });
  plan = manual.store.planSnapshot();
  assert.deepEqual(plan.since, { day: "2024-02-20", weightKg: null });
  assert.equal(plan.countdown, null);
  manual.sqlite.close();
});

test("compiled Plan leads with the countdown, puts a due check-in right under it and opens the program from its card", () => {
  const data = coachingDatabase("2024-02-01");
  seedProgram(data, "2024-02-01", { shift: weekends });
  const plan = planHarness(data);
  let tree = plan.render();
  const at = (find) => tree.findIndex(find);
  const button = (label) =>
    tree.find((node) => node.type === "Button" && node.props.children === label);
  // First due a week after Monday Jan 1, on its Thursday check-in day.
  assert.deepEqual(tree.find((node) => node.type === "CheckInRing").props, {
    days: -21,
    progress: 1,
    goal: 0,
    due: "2024-01-11",
  });
  const ring = at((node) => node.type === "CheckInRing"),
    accept = at((node) => node === button("Accept this week’s plan")),
    card = at((node) => node.type === "ProgramCard");
  assert.equal(tree[0].props.children[0].type, "CheckInRing", "first on the screen");
  assert.ok(ring < accept && accept < card, `${ring} ${accept} ${card}`);

  const budget = { calories: 2200, protein: 150, carbs: 250, fat: 66 };
  const props = programCard(tree).props;
  assert.equal(props.name, "Coached program");
  assert.equal(props.since, "2024-01-01");
  assert.equal(props.detail, "Cut 0.25%/wk");
  assert.equal(props.today, 4, "Thursday");
  assert.deepEqual(props.week, nutrition.shiftWeek(budget, weekends));
  assert.equal(props.action.type, "ActionMenu");
  assert.equal(
    tree.find((node) => node.type === "ProgramEditor"),
    undefined
  );
  props.onPress();
  tree = plan.render();
  assert.ok(tree.find((node) => node.type === "ProgramEditor"));

  // Answered, the countdown restarts and the review follows the program as its evidence.
  button("Keep current plan").props.onPress();
  tree = plan.render();
  assert.deepEqual(tree.find((node) => node.type === "CheckInRing").props, {
    days: 7,
    progress: 0,
    goal: 0,
    due: "2024-02-08",
  });
  const next = at((node) => node.type === "Label" && text(node) === "Next check-in · Thu, Feb 8");
  assert.ok(at((node) => node.type === "ProgramCard") < next);
  assert.ok(tree.some((node) => node.props?.title === "Goal pace"));
  assert.ok(tree.some((node) => node.type === "Label" && text(node) === "Recent check-ins"));
  assert.equal(button("Keep current plan"), undefined);
  data.sqlite.close();
});

test("compiled Plan shows manual targets as the running program and offers to build one", () => {
  const data = coachingDatabase("2024-02-01");
  let tree = planCard(data);
  assert.equal(programCard(tree), undefined);
  assert.equal(
    tree.find((node) => node.type === "CheckInRing"),
    undefined
  );
  assert.ok(
    tree.some((node) => node.type === "Text" && text(node) === "Let your plan do the math")
  );

  const targets = { calories: 2100, protein: 150, carbs: 220, fat: 70 };
  data.diary.saveTargets("2024-01-20", targets);
  const plan = planHarness(data);
  tree = plan.render();
  const { props } = programCard(tree);
  assert.equal(props.name, "Manual");
  assert.equal(props.since, "2024-01-20");
  assert.equal(props.detail, undefined);
  assert.equal(props.onPress, undefined, "manual targets are edited below");
  assert.ok(!props.action);
  assert.deepEqual(props.notes, []);
  assert.deepEqual(props.week, Array(7).fill(targets));
  assert.equal(
    tree.find((node) => node.type === "CheckInRing"),
    undefined
  );
  const build = nodes(props.children).find((node) => node.type === "Button");
  assert.equal(build.props.children, "Build my program");
  build.props.onPress();
  assert.ok(plan.render().find((node) => node.type === "ProgramEditor"));
  data.sqlite.close();

  // Switching a program to manual targets stops the countdown and keeps the week.
  const switched = coachingDatabase("2024-02-01");
  seedProgram(switched, "2024-02-01");
  switched.store.saveGoal("manual", 0);
  tree = planCard(switched);
  assert.equal(programCard(tree).props.name, "Manual");
  assert.equal(programCard(tree).props.since, "2024-02-01");
  assert.equal(
    tree.find((node) => node.type === "CheckInRing"),
    undefined
  );
  assert.equal(
    tree.find((node) => node.props?.title === "Goal pace"),
    undefined
  );
  switched.sqlite.close();
});

/** The Plan components compiled on their own hook slots, with the real weekday helpers. */
function strategyHarness() {
  const weekdays = screenHarness().load("src/components/plan/calorie-shift.tsx");
  const harness = screenHarness({
    "react-native": { View: "View", AppState: {}, Pressable: "Pressable" },
    "react-native-svg": { default: "Svg", Circle: "Circle" },
    "heroui-native": { useThemeColor: (names) => names.map((name) => `var(--${name})`) },
    "@/components/system": {
      SystemIcon: "Icon",
      SystemLabel: "Label",
      SystemPanel: { Body: "PanelBody" },
      SystemText: "Text",
    },
    "@/components/plan/calorie-shift": weekdays,
  });
  return {
    strategy: harness.load("src/components/plan/strategy.tsx"),
    render: (Component, props) => nodes(harness.render(Component, props)),
  };
}

test("compiled program week stacks each day's macros under its calories, higher days taller", () => {
  const { strategy, render } = strategyHarness();
  const owner = { calories: 1738, protein: 184, carbs: 119, fat: 57 };
  const week = nutrition.shiftWeek(owner, { days: [1, 3, 4], size: 49, unit: "kcal" });
  const tree = render(strategy.ProgramWeek, { week, today: 3 });
  const columns = tree.filter((node) => typeof node.key === "number");
  assert.deepEqual(
    columns.map((column) => column.key),
    [1, 2, 3, 4, 5, 6, 0],
    "the locale's week, Monday first here"
  );
  const tallest = Math.max(...week.map((day) => day.calories));
  for (const column of columns) {
    const targets = week[column.key];
    const inside = nodes(column.props.children);
    assert.deepEqual(inside.filter((node) => node.type === "Text").map(text), [
      String(targets.calories),
      `${targets.protein} P`,
      `${targets.fat} F`,
      `${targets.carbs} C`,
      ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][column.key],
    ]);
    const stack = inside.find((node) => node.props.style?.gap === 2);
    assert.ok(Math.abs(stack.props.style.height - (150 * targets.calories) / tallest) < 1e-9);
    const segments = inside.filter((node) => ["protein", "fat", "carbs"].includes(node.key));
    const heights = segments.map((node) => node.props.style.height);
    assert.ok(Math.abs(heights.reduce((a, b) => a + b) + 4 - stack.props.style.height) < 1e-9);
    // Each macro takes its share of the day's energy.
    const energy = targets.protein * 4 + targets.fat * 9 + targets.carbs * 4;
    assert.ok(Math.abs(heights[1] / heights[0] - (targets.fat * 9) / (targets.protein * 4)) < 1e-9);
    assert.ok(
      Math.abs(heights[2] / (heights[0] + heights[1] + heights[2]) - (targets.carbs * 4) / energy) <
        1e-9
    );
    const day = inside.at(-1);
    assert.match(day.props.className, column.key === 3 ? /font-semibold/ : /text-muted/);
  }
  const high = columns.find((column) => column.key === 1),
    low = columns.find((column) => column.key === 2);
  const height = (column) =>
    nodes(column.props.children).find((node) => node.props.style?.gap === 2).props.style.height;
  assert.ok(height(high) > height(low));

  // Too thin to label, and nothing drawn for a macro without grams.
  const lean = render(strategy.ProgramWeek, {
    week: Array(7).fill({ calories: 1600, protein: 250, carbs: 150, fat: 1 }),
    today: 0,
  });
  const fat = lean.filter((node) => node.key === "fat");
  assert.equal(fat.length, 7);
  assert.ok(fat.every((node) => node.props.style.height < 16 && !node.props.children));
  const noFat = render(strategy.ProgramWeek, {
    week: Array(7).fill({ calories: 1600, protein: 250, carbs: 150, fat: 0 }),
    today: 0,
  });
  assert.equal(noFat.filter((node) => node.key === "fat").length, 0);

  // Screen readers hear the week once, days with the same targets together.
  const weekday = { calories: 2100, protein: 160, carbs: 210, fat: 70 },
    weekend = { calories: 2600, protein: 160, carbs: 290, fat: 90 };
  const split = [weekend, weekday, weekday, weekday, weekday, weekday, weekend];
  assert.equal(
    render(strategy.ProgramWeek, { week: split, today: 0 })[0].props.accessibilityLabel,
    "Monday, Tuesday, Wednesday, Thursday, Friday: 2100 kcal, 160 g protein, 70 g fat, 210 g carbs. Saturday, Sunday: 2600 kcal, 160 g protein, 90 g fat, 290 g carbs"
  );
  assert.equal(
    render(strategy.ProgramWeek, { week: Array(7).fill(weekday), today: 0 })[0].props
      .accessibilityLabel,
    "Every day 2100 kcal, 160 g protein, 70 g fat, 210 g carbs"
  );
});

test("compiled program card opens the program as one button, with its menu outside it", () => {
  const { strategy, render } = strategyHarness();
  const week = Array(7).fill({ calories: 2200, protein: 150, carbs: 250, fat: 66 });
  let pressed = 0;
  const menu = { type: "ActionMenu", props: {} };
  const tree = render(strategy.ProgramCard, {
    name: "Coached program",
    since: "2024-01-01",
    detail: "Cut 0.25%/wk",
    week,
    today: 1,
    notes: ["Goal 75.0 kg · Balanced"],
    onPress: () => pressed++,
    action: menu,
  });
  const button = tree.find((node) => node.type === "Pressable");
  assert.equal(button.props.accessibilityRole, "button");
  assert.equal(
    button.props.accessibilityLabel,
    "Coached program. Jan 1 – now · Cut 0.25%/wk. Every day 2200 kcal, 150 g protein, 66 g fat, 250 g carbs. Goal 75.0 kg · Balanced"
  );
  button.props.onPress();
  assert.equal(pressed, 1);
  const card = nodes(button.props.children({ pressed: true }));
  assert.match(card[0].props.className, /opacity-70/);
  assert.ok(
    card.some((node) => node.type === "Text" && text(node) === "Jan 1 – now · Cut 0.25%/wk")
  );
  assert.ok(card.some((node) => node.type === "Icon" && node.props.name === "chevron-forward"));
  assert.deepEqual(card.find((node) => node.type === strategy.ProgramWeek).props, {
    week,
    today: 1,
  });
  assert.ok(!card.includes(menu));
  assert.ok(tree.includes(menu), "the menu is its own control");

  // Without an action it's a plain card that shows what it's given.
  const plain = render(strategy.ProgramCard, {
    name: "Manual",
    since: "2024-01-20",
    week,
    today: 1,
    children: { type: "Button", props: { children: "Build my program" } },
  });
  assert.equal(
    plain.find((node) => node.type === "Pressable"),
    undefined
  );
  assert.equal(
    plain.find((node) => node.type === "Icon"),
    undefined
  );
  assert.ok(plain.some((node) => node.type === "Text" && text(node) === "Jan 20 – now"));
  assert.ok(plain.some((node) => node.type === "Button"));
});

test("compiled check-in ring counts the days down and fills its arcs", () => {
  const ring = (props) => {
    const { strategy, render } = strategyHarness();
    return render(strategy.CheckInRing, { due: "2024-02-08", goal: null, ...props });
  };
  const texts = (tree) => tree.filter((node) => node.type === "Text").map(text);
  const arcs = (tree) => tree.filter((node) => node.type?.name === "Arc");
  const legend = (tree) =>
    tree
      .filter((node) => node.type?.name === "Legend")
      .map((node) => [node.props.label, node.props.value]);

  let tree = ring({ days: 2, progress: 5 / 7, goal: 0.25 });
  assert.equal(
    tree[0].props.accessibilityLabel,
    "2 days until check-in on Thursday. 25% of the way to your goal weight"
  );
  assert.deepEqual(texts(tree), ["2 days", "until check-in"]);
  assert.deepEqual(
    arcs(tree).map((arc) => [arc.props.value, arc.props.color]),
    [
      [0.25, "var(--success)"],
      [5 / 7, "var(--foreground)"],
    ]
  );
  assert.ok(arcs(tree)[0].props.radius > arcs(tree)[1].props.radius, "the goal rings the week");
  assert.deepEqual(legend(tree), [
    ["Goal", "25%"],
    ["Check-in", "Thu"],
  ]);
  const week = arcs(tree)[1];
  const circles = nodes(week.type(week.props)).filter((node) => node.type === "Circle");
  const length = 2 * Math.PI * week.props.radius;
  assert.equal(circles.length, 2, "the track and the arc");
  assert.equal(circles[1].props.strokeDasharray, `${(length * 5) / 7} ${length}`);
  const empty = { ...week.props, value: 0 };
  assert.equal(nodes(week.type(empty)).filter((node) => node.type === "Circle").length, 1);

  tree = ring({ days: 1, progress: 6 / 7 });
  assert.deepEqual(texts(tree), ["1 day", "until check-in"]);
  assert.equal(tree[0].props.accessibilityLabel, "1 day until check-in on Thursday");
  assert.equal(arcs(tree).length, 1, "no goal arc without a distance to cover");
  assert.deepEqual(legend(tree), [["Check-in", "Thu"]]);

  tree = ring({ days: 0, progress: 1, goal: 1 });
  assert.deepEqual(texts(tree), ["Check-in", "Today"]);
  assert.equal(
    tree[0].props.accessibilityLabel,
    "Check-in today. 100% of the way to your goal weight"
  );
  tree = ring({ days: -2, progress: 1 });
  assert.deepEqual(texts(tree), ["Check-in", "Due"]);
  assert.equal(tree[0].props.accessibilityLabel, "Check-in due since Thursday");
});

test("the program chart's labels keep AA contrast on their fills in both themes", () => {
  const css = readFileSync("src/global.css", "utf8");
  const theme = (variant) => {
    const block = css.slice(css.indexOf(`@variant ${variant}`)).split("}")[0];
    return Object.fromEntries(
      [...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6});/gi)].map(([, name, value]) => [name, value])
    );
  };
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (high + 0.05) / (low + 0.05);
  };
  for (const variant of ["light", "dark"]) {
    const colors = theme(variant);
    for (const fill of ["chart-calories", "chart-protein", "chart-fat", "chart-carbs"])
      assert.ok(
        contrast(colors.background, colors[fill]) >= 4.5,
        `${variant} ${fill}: ${contrast(colors.background, colors[fill]).toFixed(2)}`
      );
  }
});

test("compiled Plan screen leaves room for a bar floating over its bottom", () => {
  const data = coachingDatabase("2024-02-01");
  const harness = screenHarness({
    "react-native": {
      View: "View",
      AppState: {},
      Platform: { OS: "ios" },
      AccessibilityInfo: { announceForAccessibility() {} },
    },
    "@/lib/coaching-store": data.store,
    "@/lib/diary": data.diary,
    "@/lib/metrics": data.fakeMetrics,
    "./metrics": data.fakeMetrics,
    "@/components/system": {
      SystemButton: "Button",
      SystemPanel: { Body: "PanelBody" },
      SystemText: "Text",
    },
    "@/components/ui": { ErrorText: "Error", Field: "Field", Screen: "Screen" },
    "./coaching-panel": { CoachingPanel: "CoachingPanel" },
    "expo-router": { router: {} },
  });
  const { PlanScreen } = harness.load("src/components/nutrition/plan-screen.tsx");
  const bar = { type: "QuickLogBar", props: {} };
  assert.equal(harness.render(PlanScreen, { footer: bar }).props.footer, bar);
  assert.equal(harness.render(PlanScreen, {}).props.footer, undefined);
  data.sqlite.close();
});
