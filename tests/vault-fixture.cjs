// Pendum Macros' vault test fixture (tests/vault-fixture.cjs; app-owned, docs/vault.md §12). `seed` writes what a
// long-time user has at a schema level: diary entries in the last 30 days and months ago, custom and saved foods,
// day states, targets, saved meals, recipes, a coaching goal with check-ins, weights (one ignored, one imported,
// one deleted), measurements, a progress photo with its file, preferences with Health provenance and device state,
// and Health links for weights, measurements and food, including tombstones. Recent days are counted back from
// `now`, so the 30-day food window of a restore (spec §5.3) always splits the diary.
const { mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");

/** The vault ships at this schema level (journal length); `seed` writes the same rows at every later level. */
const FIRST_LEVEL = 14;

const INSTALLATION = "1789000000000-z8x7c6v5b4";
const WEIGHT_EPOCH = "1789500000000-n3m2l1k0j9";
const MEAL_TIMES = { Breakfast: "08:00", Lunch: "12:00", Dinner: "18:00", Snacks: "15:00" };

const json = (value) => JSON.stringify(value);
const ms = (iso) => Date.parse(iso);
const seconds = (iso) => Math.floor(Date.parse(iso) / 1000);
const pad = (n) => String(n).padStart(2, "0");
const localDay = (date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

function insert(db, table, rows) {
  for (const row of rows) {
    const columns = Object.keys(row);
    db.runSync(
      `INSERT INTO ${table} (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      columns.map((c) => row[c])
    );
  }
}

const nutrients = (calories, protein, carbs, fat, extra = {}) => ({
  calories,
  protein,
  carbs,
  fat,
  fiber: null,
  sodium: null,
  ...extra,
});
const OATS = {
  id: "usda:173904",
  name: "Oats, rolled",
  brand: "",
  barcode: null,
  basis: "g",
  nutrients: nutrients(379, 13.2, 67.7, 6.5, { fiber: 10.1, sodium: 6, sugar: 1 }),
  portions: [{ label: "1 cup", amount: 81 }],
  source: "usda",
  sourceVersion: "2024-10",
};
const CHICKEN = {
  id: "usda:171477",
  name: "Chicken breast, roasted",
  brand: "",
  barcode: null,
  basis: "g",
  nutrients: nutrients(165, 31, 0, 3.6, { sodium: 74 }),
  portions: [{ label: "1 breast", amount: 140 }],
  source: "usda",
  sourceVersion: "2024-10",
};
const YOGURT = {
  id: "off:4002971243703",
  name: "Skyr natur",
  brand: "Milbona",
  barcode: "4002971243703",
  basis: "g",
  nutrients: nutrients(63, 11, 4, 0.2, { sugar: 4 }),
  portions: [{ label: "1 cup", amount: 150 }],
  source: "off",
  sourceVersion: "2026-08-30",
};
const SHAKE = {
  id: "custom:1789100000000:k9j8h7",
  name: "Protein shake (2 scoops) — 🥤",
  brand: "",
  barcode: "0012345678905",
  basis: "serving",
  nutrients: nutrients(240, 48, 6, 3),
  portions: [{ label: "1 shaker", amount: 1 }],
  source: "custom",
  sourceVersion: "1",
};
const scaled = (food, amount) => {
  const factor = food.basis === "serving" ? amount : amount / 100;
  return Object.fromEntries(
    Object.entries(food.nutrients).map(([k, v]) => [
      k,
      v === null ? null : Math.round(v * factor * 10) / 10,
    ])
  );
};

function seed(db, { level, now = new Date(), documentDirectory }) {
  if (level < FIRST_LEVEL)
    throw new Error(`macro fixture: no seed below schema level ${FIRST_LEVEL}`);
  if (!documentDirectory)
    throw new Error("macro fixture: seed needs the document folder for the photo file");
  const daysAgo = (n) => {
    const date = new Date(now);
    date.setDate(date.getDate() - n);
    return localDay(date);
  };
  const recent = [daysAgo(2), daysAgo(1)];
  const old = "2026-03-14";
  db.withTransactionSync(() => {
    const entry = (id, day, meal, food, amount, portion, created, loggedTime = null) => ({
      id,
      day,
      meal,
      logged_time: loggedTime,
      food: json(food),
      amount,
      portion_label: portion.label,
      portion_unit: portion.unit,
      portion_count: portion.count,
      nutrients: json(scaled(food, amount)),
      created_at: created,
    });
    insert(db, "food_entries", [
      entry(
        1,
        old,
        "Breakfast",
        OATS,
        60,
        { label: "60 g", unit: "g", count: 60 },
        ms(`${old}T07:30:00.000Z`)
      ),
      entry(
        2,
        old,
        "Dinner",
        CHICKEN,
        140,
        { label: "1 breast", unit: null, count: null },
        ms(`${old}T18:10:00.000Z`)
      ),
      entry(
        3,
        recent[0],
        "Breakfast",
        YOGURT,
        150,
        { label: "1 cup", unit: "cup", count: 1 },
        ms(`${recent[0]}T07:00:00.000Z`),
        "07:15"
      ),
      entry(
        4,
        recent[0],
        "Lunch",
        CHICKEN,
        210,
        { label: "1.5 breast", unit: "breast", count: 1.5 },
        ms(`${recent[0]}T12:20:00.000Z`)
      ),
      entry(
        5,
        recent[0],
        "Snacks",
        SHAKE,
        1,
        { label: "1 shaker", unit: "shaker", count: 1 },
        ms(`${recent[0]}T16:00:00.000Z`)
      ),
      entry(
        6,
        recent[1],
        "Breakfast",
        OATS,
        80,
        { label: "80 g", unit: "g", count: 80 },
        ms(`${recent[1]}T07:40:00.000Z`)
      ),
      entry(
        7,
        recent[1],
        "Dinner",
        CHICKEN,
        150,
        { label: "150 g", unit: "g", count: 150 },
        ms(`${recent[1]}T19:00:00.000Z`)
      ),
    ]);
    // Deleted from the diary: the sequence stays at 7, its Health link is a tombstone.
    db.runSync("DELETE FROM food_entries WHERE id = 5");
    insert(db, "custom_foods", [
      { id: SHAKE.id, name: SHAKE.name, barcode: SHAKE.barcode, food: json(SHAKE) },
    ]);
    insert(db, "saved_foods", [
      { id: CHICKEN.id, food: json(CHICKEN), saved_at: ms("2026-03-14T18:11:00.000Z") },
      { id: SHAKE.id, food: json(SHAKE), saved_at: ms("2026-09-01T16:00:00.000Z") },
    ]);
    insert(db, "diary_days", [
      { day: old, status: "complete" },
      { day: recent[0], status: "complete" },
      { day: recent[1], status: "in-progress" },
      { day: "2026-03-15", status: "fasting" },
    ]);
    insert(db, "nutrition_targets", [
      {
        effective_day: "2026-03-01",
        targets: json({ calories: 2300, protein: 150, carbs: 250, fat: 75 }),
      },
      {
        effective_day: "2026-09-07",
        targets: json({ calories: 2150, protein: 160, carbs: 220, fat: 70 }),
      },
    ]);
    insert(db, "saved_meals", [
      {
        id: 1,
        name: "Usual breakfast",
        items: json([
          {
            food: OATS,
            amount: 60,
            portionLabel: "60 g",
            portionUnit: "g",
            portionCount: 60,
            nutrients: scaled(OATS, 60),
          },
          { food: YOGURT, amount: 150, portionLabel: "1 cup", nutrients: scaled(YOGURT, 150) },
        ]),
        created_at: ms("2026-04-02T07:00:00.000Z"),
      },
    ]);
    insert(db, "recipes", [
      {
        id: "1789200000000-b7v6c5",
        name: "Overnight oats",
        servings: 2,
        yield_grams: 520,
        ingredients: json([
          { food: OATS, amount: 120 },
          { food: YOGURT, amount: 300 },
        ]),
        revision: 3,
      },
    ]);
    const program = {
      age: 34,
      heightCm: 168,
      weightKg: 72.4,
      formula: "female",
      activity: "moderate",
      protein: 2,
      diet: "balanced",
      targetWeightKg: 68,
      initialExpenditure: 2400,
      checkInDay: 1,
    };
    insert(db, "coaching_goals", [
      { id: 1, mode: "manual", pace: 0, started_day: "2026-03-01", program: null },
      { id: 2, mode: "lose", pace: 0.5, started_day: "2026-09-07", program: json(program) },
    ]);
    const review = (day, start, end, proposed) => ({
      method: 2,
      trendWeightKg: 71.9,
      targetWeightKg: 68,
      observedDays: 7,
      day,
      start,
      end,
      completeDays: 6,
      weightDays: 5,
      status: "ready",
      reason: "onTrack",
      intake: 2140,
      expenditure: 2610,
      weeklyKg: -0.42,
      desiredWeeklyKg: -0.36,
      proposed,
    });
    insert(db, "check_ins", [
      {
        day: "2026-09-14",
        goal_id: 2,
        decision: "accepted",
        review: json(
          review("2026-09-14", "2026-09-07", "2026-09-13", {
            calories: 2100,
            protein: 160,
            carbs: 210,
            fat: 70,
          })
        ),
        targets: json({ calories: 2100, protein: 160, carbs: 210, fat: 70 }),
      },
      {
        day: "2026-09-21",
        goal_id: 2,
        decision: "kept",
        review: json(review("2026-09-21", "2026-09-14", "2026-09-20", null)),
        targets: json({ calories: 2100, protein: 160, carbs: 210, fat: 70 }),
      },
    ]);
    const weights = [
      [1, 72.4, "2026-09-07T06:30:00.000Z", 0],
      [2, 72.1, "2026-09-10T06:32:00.000Z", 0],
      [3, 73.6, "2026-09-12T21:00:00.000Z", 1],
      [4, 71.8, "2026-09-17T06:30:00.000Z", 0],
      [5, 71.9, "2026-09-21T06:28:00.000Z", 0],
      [6, 71.5, "2026-09-28T06:31:00.000Z", 0],
    ];
    insert(
      db,
      "weight_entries",
      weights.map(([id, kg, at, excluded]) => ({
        id,
        weight_kg: kg,
        measured_at: at,
        created_at: seconds(at),
        updated_at: seconds(at),
        excluded,
      }))
    );
    // Deleted by the user (4): the sequence stays at 6.
    db.runSync("DELETE FROM weight_entries WHERE id = 4");
    insert(db, "measurements", [
      {
        id: 1,
        kind: "height",
        measured_at: "2026-09-07T06:35:00.000Z",
        values: json({ height: 168 }),
        updated_at: ms("2026-09-07T06:35:00.000Z"),
      },
      {
        id: 2,
        kind: "body",
        measured_at: "2026-09-07T06:36:00.000Z",
        values: json({ waist: 78.5, hips: 101.2, neck: 33, bodyFat: 27.5 }),
        updated_at: ms("2026-09-07T06:36:00.000Z"),
      },
    ]);
    const photo = "1789300000000-p0o9i8.png";
    insert(db, "photos", [{ id: 1, uri: photo, pose: "front", measured_at: "2026-09-07" }]);
    const folder = path.join(documentDirectory, "progress-photos");
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      path.join(folder, photo),
      Uint8Array.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x50, 0x4b, 0x07, 0x08, 0, 1, 2, 3,
      ])
    );

    const preferences = {
      theme: "system",
      units: "imperial",
      language: "fr",
      diaryLayout: "meals",
      hideEmptyHours: "false",
      countLoggedDays: "true",
      installation: INSTALLATION,
      healthInstallations: json([INSTALLATION]),
      weightSyncEpoch: WEIGHT_EPOCH,
      healthFoodSince: daysAgo(30),
      // Device state: never exported.
      healthSyncEnabled: "true",
      healthSyncError: "",
      lastSync: "2026-09-28T07:00:00.000Z",
      healthPermissions: "2",
      healthBirthDate: "1992-04-18",
      healthSex: "female",
      weighInSkippedDay: daysAgo(3),
      settledDay: daysAgo(2),
      recoveryBackupUri:
        "file:///var/mobile/Containers/Data/Application/1A2B3C4D-5E6F-4A7B-8C9D-0E1F2A3B4C5D/Documents/MacroTrackBackups/macro-track-recovery-1788800000000.backup.json",
      formula: "female",
    };
    insert(
      db,
      "preferences",
      Object.entries(preferences).map(([key, value]) => ({ key, value }))
    );

    const prefix = `macro-track:${INSTALLATION}:`;
    const weightKey = (id) => `${prefix}restored-${WEIGHT_EPOCH}:weight:${id}`;
    const foodFingerprint = (id) => {
      const row = db.getFirstSync(
        "SELECT day, meal, logged_time, food, nutrients FROM food_entries WHERE id = ?",
        [id]
      );
      const eatenAt = new Date(
        `${row.day}T${row.logged_time ?? MEAL_TIMES[row.meal]}:00`
      ).toISOString();
      return json([JSON.parse(row.food).name, row.meal, eatenAt, JSON.parse(row.nutrients)]);
    };
    insert(
      db,
      "health_links",
      [
        [
          weightKey(1),
          "weight",
          1,
          "AA11BB22-CC33-4D44-8E55-FF6677889901",
          "72.4:2026-09-07T06:30:00.000Z",
          "local",
        ],
        [
          weightKey(2),
          "weight",
          2,
          "AA11BB22-CC33-4D44-8E55-FF6677889902",
          "72.1:2026-09-10T06:32:00.000Z",
          "local",
        ],
        // Deleted here and removed from Health.
        [weightKey(4), "weight", 4, "AA11BB22-CC33-4D44-8E55-FF6677889904", "deleted", "local"],
        [
          `${prefix}height:1`,
          "height",
          1,
          "BB22CC33-DD44-4E55-9F66-007788990011",
          "168:2026-09-07T06:35:00.000Z",
          "local",
        ],
        [
          `${prefix}waist:2`,
          "waist",
          2,
          "BB22CC33-DD44-4E55-9F66-007788990012",
          "78.5:2026-09-07T06:36:00.000Z",
          "local",
        ],
        [
          `${prefix}bodyFat:2`,
          "bodyFat",
          2,
          "BB22CC33-DD44-4E55-9F66-007788990013",
          "27.5:2026-09-07T06:36:00.000Z",
          "local",
        ],
        // Food written before the 30-day window and inside it; entry 5 was deleted here.
        [
          `${prefix}food:2`,
          "food",
          2,
          "CC33DD44-EE55-4F66-A077-118899001102",
          foodFingerprint(2),
          "local",
        ],
        [
          `${prefix}food:3`,
          "food",
          3,
          "CC33DD44-EE55-4F66-A077-118899001103",
          foodFingerprint(3),
          "local",
        ],
        [
          `${prefix}food:4`,
          "food",
          4,
          "CC33DD44-EE55-4F66-A077-118899001104",
          foodFingerprint(4),
          "local",
        ],
        [`${prefix}food:5`, "food", 5, "CC33DD44-EE55-4F66-A077-118899001105", "deleted", "local"],
        [
          `${prefix}food:6`,
          "food",
          6,
          "CC33DD44-EE55-4F66-A077-118899001106",
          foodFingerprint(6),
          "local",
        ],
        // Imported from Health.
        [
          "health:weight:DD44EE55-FF66-4077-8188-229900112205",
          "weight",
          5,
          "DD44EE55-FF66-4077-8188-229900112205",
          "71.9:2026-09-21T06:28:00.000Z",
          "health",
        ],
      ].map(([key, local_kind, local_id, remote_id, fingerprint, origin]) => ({
        key,
        local_kind,
        local_id,
        remote_id,
        fingerprint,
        origin,
      }))
    );
  });
}

module.exports = {
  levels: [FIRST_LEVEL],
  seed,
  // Modules the descriptor imports lazily; each world records the calls (`w.called(module)`). The CSV builders
  // (`@/lib/data-ownership`) run for real.
  stubs: {
    "@/lib/health": (w) => w.record("@/lib/health", { pauseWhenIdle: (work) => work() }),
    "@/lib/health-schedule": (w) =>
      w.record("@/lib/health-schedule", { configureHealthSchedule: async () => {} }),
  },
};
