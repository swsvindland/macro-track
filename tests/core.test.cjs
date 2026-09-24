const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, readdirSync } = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const ts = require("typescript");
const { drizzle } = require(
  require("node:path").join(
    require("node:path").dirname(require.resolve("drizzle-orm/expo-sqlite")),
    "driver.cjs"
  )
);
const { eq } = require("drizzle-orm");

// Execute production TypeScript under Node while substituting only native boundaries.
function load(file, dependencies = {}) {
  const output = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const sourceRequire = require("node:module").createRequire(require("node:path").resolve(file));
  new Function("require", "module", "exports", output)(
    (name) => (name in dependencies ? dependencies[name] : sourceRequire(name)),
    module,
    module.exports
  );
  return module.exports;
}
const metrics = load("src/lib/metrics.ts");
const schema = load("src/db/schema.ts");
const { dictionaries, languagePreference, resolveLanguage } = load("src/lib/translations.ts");
const close = (a, b, epsilon = 1e-8) => assert.ok(Math.abs(a - b) < epsilon, `${a} ≠ ${b}`);

test("units round-trip and reject partial numeric input", () => {
  for (const unit of ["metric", "imperial", "stone"]) {
    close(metrics.toKg(metrics.fromKg(82.375, unit), unit), 82.375);
    close(metrics.toCm(metrics.fromCm(181.2, unit), unit), 181.2);
  }
  close(metrics.toKg(14, "stone"), 88.90410452);
  close(metrics.toCm(70, "imperial"), 177.8);
  assert.equal(metrics.parseNumber("75,25"), 75.25);
  for (const input of ["75kg", "1.2.3", "", "Infinity", "1e2", "-5", "1,234.5"])
    assert.ok(Number.isNaN(metrics.parseNumber(input)));
});
test("height uses feet and inches with precise conversion and rounding carry", () => {
  const number = (value, digits = 1) =>
    new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value);
  close(metrics.parseHeight("5", "11"), 180.34);
  close(metrics.parseHeight("6", ""), 182.88);
  close(metrics.parseHeight("5", "11,5"), 181.61);
  close(metrics.parseHeight("0", "11"), 27.94);
  assert.deepEqual(metrics.heightParts(180.34), { feet: 5, inches: 11 });
  assert.deepEqual(metrics.heightParts(182.88), { feet: 6, inches: 0 });
  for (const units of ["imperial", "stone"]) {
    assert.equal(metrics.formatHeight(180.34, units, number), "5' 11\"");
    assert.equal(metrics.formatHeight(181.61, units, number), "5' 11.5\"");
    assert.equal(metrics.formatHeight(182.88, units, number), "6' 0\"");
    assert.equal(metrics.formatHeight(182.879, units, number), "6' 0\"");
  }
  assert.equal(metrics.formatHeight(180.34, "metric", number), "180.3 cm");
  for (const [feet, inches] of [
    ["5.5", "1"],
    ["5", "12"],
    ["-1", "1"],
    ["", ""],
    ["5", "-1"],
    ["5", "11in"],
  ])
    assert.ok(Number.isNaN(metrics.parseHeight(feet, inches)));
});
test("calendar validation and local dates avoid UTC shifts", () => {
  assert.equal(metrics.validDay("2024-02-29"), true);
  for (const day of ["2025-02-29", "2024-04-31", "2024-13-01", "2999-01-01", "2024-2-2"])
    assert.equal(metrics.validDay(day), false);
  assert.equal(metrics.localDay(new Date(2024, 0, 1, 23, 30)), "2024-01-01");
});
test("trend averages same-day records, sorts history and handles gaps", () => {
  const trend = metrics.weightTrend([
    { measuredAt: "2024-01-08", weightKg: 90 },
    { measuredAt: "2024-01-01", weightKg: 78 },
    { measuredAt: "2024-01-01", weightKg: 82 },
    { measuredAt: "2024-01-09", weightKg: NaN },
  ]);
  assert.equal(trend.length, 2);
  assert.equal(trend[0].raw, 80);
  close(trend[1].trend, 85);
  const steady = metrics.weightTrend([
    { measuredAt: "2024-01-01", weightKg: 80 },
    { measuredAt: "2024-01-02", weightKg: 80 },
  ]);
  close(steady[1].trend, 80);
  assert.deepEqual(metrics.weightTrend([]), []);
});
test("BMI, Navy equations, manual body fat and missing inputs", () => {
  close(metrics.composition(80, 180, 20).bmi, 24.691358024691358);
  close(metrics.composition(80, 180, 20).ffmi, 19.753086419753085);
  const male = metrics.bodyFat({ neck: 40, abdomen: 90 }, 180, "male");
  assert.ok(male > 18 && male < 19);
  const female = metrics.bodyFat({ neck: 33, waist: 75, hips: 100 }, 165, "female");
  close(female, 29.739407691790603);
  assert.equal(metrics.bodyFat({ bodyFat: 24 }, undefined, "none"), 24);
  assert.equal(metrics.bodyFat({ neck: 40 }, 180, "male"), null);
  assert.equal(metrics.bodyFat({ neck: 40, abdomen: 30 }, 180, "male"), null);
  assert.deepEqual(metrics.composition(undefined, undefined, null), { bmi: null, ffmi: null });
});
test("all 11 languages contain every interface string", () => {
  assert.equal(Object.keys(dictionaries).length, 11);
  for (const [locale, dictionary] of Object.entries(dictionaries)) {
    assert.deepEqual(Object.keys(dictionary), Object.keys(dictionaries.en));
    for (const [key, value] of Object.entries(dictionary))
      assert.ok(typeof value === "string" && value.length, `${locale}.${key}`);
  }
});
test("language follows the device by default and allows a persistent override", () => {
  assert.equal(languagePreference(undefined), "system");
  assert.equal(languagePreference("system"), "system");
  assert.equal(resolveLanguage(languagePreference(undefined), "es"), "es");
  assert.equal(resolveLanguage(languagePreference("system"), "fr"), "fr");
  assert.equal(resolveLanguage(languagePreference("en"), "es"), "en");
  for (const language of Object.keys(dictionaries)) {
    assert.equal(languagePreference(language), language);
    assert.equal(resolveLanguage(languagePreference(language), "es"), language);
  }
  for (const unsupported of [null, undefined, "ar", "toString"]) {
    assert.equal(resolveLanguage("system", unsupported), "en");
  }
  assert.equal(languagePreference("toString"), "system");
});
function database() {
  const sqlite = new DatabaseSync(":memory:");
  for (const migration of readdirSync("drizzle")
    .filter((f) => f.endsWith(".sql"))
    .sort())
    sqlite.exec(readFileSync(`drizzle/${migration}`, "utf8"));
  // Same Drizzle Expo driver as production, backed by real SQLite instead of a phone.
  const client = {
    prepareSync(sql) {
      return {
        executeSync(params) {
          const stmt = sqlite.prepare(sql);
          if (!stmt.columns().length) {
            const result = stmt.run(...params);
            return { changes: result.changes, lastInsertRowId: result.lastInsertRowid };
          }
          const rows = stmt.all(...params);
          return { getAllSync: () => rows, getFirstSync: () => rows[0] };
        },
        executeForRawResultSync(params) {
          const stmt = sqlite.prepare(sql);
          stmt.setReturnArrays(true);
          const rows = stmt.all(...params);
          return { getAllSync: () => rows };
        },
      };
    },
  };
  return { sqlite, db: drizzle(client, { schema }) };
}
test("migration preserves old weight data and creates new storage", () => {
  const sqlite = new DatabaseSync(":memory:");
  const migrations = readdirSync("drizzle")
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of migrations.slice(0, 2)) sqlite.exec(readFileSync(`drizzle/${file}`, "utf8"));
  sqlite.exec("INSERT INTO weight_entries (weight_kg, measured_at) VALUES (80.5, '2024-01-01')");
  for (const file of migrations.slice(2)) sqlite.exec(readFileSync(`drizzle/${file}`, "utf8"));
  assert.equal(sqlite.prepare("SELECT weight_kg FROM weight_entries").get().weight_kg, 80.5);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM photos").get().n, 0);
  sqlite.close();
});
test("health sync is repeatable, updates exports and never resurrects deleted imports", async () => {
  const { db, sqlite } = database();
  const health = load("src/lib/health.ts", {
    "expo-constants": { appOwnership: "standalone" },
    "@/db": { db, ...schema },
    "./health-native": {},
    "./metrics": metrics,
  });
  const local = db
    .insert(schema.weightEntries)
    .values({ weightKg: 80, measuredAt: "2024-01-01T12:00:00Z" })
    .returning()
    .get();
  const records = new Map([
    [
      "external",
      { id: "external", kind: "height", value: 180, measuredAt: "2024-01-02T12:00:00Z" },
    ],
  ]);
  let writes = 0;
  const adapter = {
    authorize: async () => {},
    read: async () => [...records.values()],
    write: async (record) => {
      writes++;
      const id = record.clientId;
      records.set(id, { ...record, id });
      return id;
    },
    remove: async (_, id) => {
      records.delete(id);
    },
  };
  assert.deepEqual(await health.syncHealth(adapter), { imported: 1, exported: 1 });
  assert.deepEqual(await health.syncHealth(adapter), { imported: 0, exported: 0 });
  assert.equal(db.select().from(schema.weightEntries).all().length, 1);
  assert.equal(db.select().from(schema.measurements).all().length, 1);
  db.update(schema.weightEntries)
    .set({ weightKg: 81 })
    .where(eq(schema.weightEntries.id, local.id))
    .run();
  await health.syncHealth(adapter);
  assert.equal(writes, 2);
  assert.equal(records.size, 2);
  db.delete(schema.measurements).run();
  records.set("external", { ...records.get("external"), value: 181 });
  await health.syncHealth(adapter);
  assert.equal(db.select().from(schema.measurements).all().length, 0);
  db.delete(schema.weightEntries).run();
  await health.syncHealth(adapter);
  assert.equal(records.size, 1);
  sqlite.close();
});
test("failed sync retries safely and doesn't claim success", async () => {
  const { db, sqlite } = database();
  const health = load("src/lib/health.ts", {
    "expo-constants": {},
    "@/db": { db, ...schema },
    "./health-native": {},
    "./metrics": metrics,
  });
  db.insert(schema.weightEntries)
    .values({ weightKg: 80, measuredAt: "2024-01-01T12:00:00Z" })
    .run();
  let writes = 0;
  const adapter = {
    authorize: async () => {},
    write: async () => {
      writes++;
      return "saved";
    },
    read: async () => {
      throw new Error("offline");
    },
    remove: async () => {},
  };
  await assert.rejects(health.syncHealth(adapter), /offline/);
  assert.equal(
    db.select().from(schema.preferences).where(eq(schema.preferences.key, "lastSync")).get(),
    undefined
  );
  adapter.read = async () => [];
  await health.syncHealth(adapter);
  assert.equal(writes, 1);
  sqlite.close();
});

test("daily health schedule respects opt-in, due time, failures and opt-out", async () => {
  const { db, sqlite } = database();
  let task;
  let registered = false;
  let calls = 0;
  let fail = false;
  let failRegistration = false;
  const get = (key) =>
    db.select().from(schema.preferences).where(eq(schema.preferences.key, key)).get()?.value;
  const set = (key, value) =>
    db
      .insert(schema.preferences)
      .values({ key, value })
      .onConflictDoUpdate({ target: schema.preferences.key, set: { value } })
      .run();
  const schedule = load("src/lib/health-schedule.ts", {
    "expo-constants": { default: { appOwnership: "standalone" } },
    "react-native": { Platform: { OS: "ios" } },
    "@/db": { db, ...schema },
    "expo-task-manager": {
      defineTask: (_name, callback) => {
        task = callback;
      },
      isTaskRegisteredAsync: async () => registered,
    },
    "expo-background-task": {
      BackgroundTaskStatus: { Available: 2 },
      BackgroundTaskResult: { Success: 1, Failed: 2 },
      getStatusAsync: async () => 2,
      registerTaskAsync: async (_name, options) => {
        assert.equal(options.minimumInterval, 1440);
        if (failRegistration) throw new Error("scheduler");
        registered = true;
      },
      unregisterTaskAsync: async () => {
        registered = false;
      },
    },
    "./health": {
      syncHealth: async (_adapter, interactive) => {
        calls++;
        if (get("healthSyncEnabled") === "true") assert.equal(interactive, false);
        if (fail) throw new Error("offline");
        set("lastSync", new Date().toISOString());
      },
    },
  });
  const now = Date.now();
  assert.equal(schedule.healthSyncDue(undefined, now), true);
  assert.equal(schedule.healthSyncDue("invalid", now), true);
  assert.equal(schedule.healthSyncDue(new Date(now - 86400000).toISOString(), now), true);
  assert.equal(schedule.healthSyncDue(new Date(now - 86399999).toISOString(), now), false);
  assert.equal(schedule.healthSyncDue(new Date(now + 1).toISOString(), now), true);
  await task();
  assert.equal(calls, 0);
  fail = true;
  await assert.rejects(schedule.enableHealthSync(), /offline/);
  assert.notEqual(get("healthSyncEnabled"), "true");
  fail = false;
  await schedule.enableHealthSync();
  assert.equal(registered, true);
  assert.equal(get("healthSyncEnabled"), "true");
  const afterEnable = calls;
  await task();
  assert.equal(calls, afterEnable);
  const overdue = new Date(now - 86400001).toISOString();
  set("lastSync", overdue);
  fail = true;
  assert.equal(await task(), 2);
  assert.equal(get("lastSync"), overdue);
  assert.equal(get("healthSyncError"), "syncFailed");
  fail = false;
  assert.equal(await task(), 1);
  assert.equal(get("healthSyncError"), "");
  await schedule.disableHealthSync();
  assert.equal(registered, false);
  set("lastSync", overdue);
  const afterDisable = calls;
  await task();
  assert.equal(calls, afterDisable);
  failRegistration = true;
  await assert.rejects(schedule.enableHealthSync(), /scheduler/);
  assert.equal(get("healthSyncEnabled"), "false");
  sqlite.close();
});

test("dashboard ratio uses shoulder / waist and the 1.62 goal", () => {
  const { shoulderWaistRatio, metricContext } = load("src/lib/metric-context.ts");
  close(shoulderWaistRatio({ shoulders: 129.6, waist: 80 }), 1.62);
  for (const values of [
    undefined,
    {},
    { waist: 80 },
    { shoulders: 120, waist: 0 },
    { shoulders: Infinity, waist: 80 },
  ])
    assert.equal(shoulderWaistRatio(values), null);
  assert.equal(metricContext("shoulderWaistRatio", 1.5, "none").label, "ratioBelowGoal");
  assert.equal(metricContext("shoulderWaistRatio", 1.62, "none").tone, "success");
  assert.equal(metricContext("shoulderWaistRatio", 1.8, "none").label, "ratioAboveGoal");
  assert.equal(metricContext("bmi", 18.5, "none").tone, "success");
  assert.equal(metricContext("bmi", 25, "none").label, "bmiElevated");
  assert.equal(metricContext("bmi", 30, "none").tone, "danger");
  assert.equal(metricContext("bodyFat", 25, "male").label, "fatHigh");
  assert.equal(metricContext("bodyFat", 25, "female").label, "fatTypical");
  assert.equal(metricContext("bodyFat", 25, "none").tone, "neutral");
  assert.equal(metricContext("ffmi", 21, "male").label, "ffmiHigh");
  assert.equal(metricContext("ffmi", 16, "female").label, "ffmiTypical");
  assert.equal(metricContext("ffmi", null, "male").label, "metricMissing");
});

test("body exports follow platform support and handle edits, removed fields and retries", async () => {
  for (const bodyWriteKinds of [["bodyFat"], ["waist", "bodyFat"]]) {
    const { db, sqlite } = database();
    const health = load("src/lib/health.ts", {
      "expo-constants": { appOwnership: "standalone" },
      "@/db": { db, ...schema },
      "./health-native": {},
      "./metrics": metrics,
    });
    const local = db
      .insert(schema.measurements)
      .values({
        kind: "body",
        values: { waist: 80, shoulders: 130, bodyFat: 20 },
        measuredAt: "2024-01-01T12:00:00Z",
        updatedAt: 1,
      })
      .returning()
      .get();
    // A tape-only session must not export a calculated fat percentage.
    db.insert(schema.measurements)
      .values({
        kind: "body",
        values: { abdomen: 90, neck: 40 },
        measuredAt: "2024-01-02T12:00:00Z",
        updatedAt: 1,
      })
      .run();
    const remote = new Map();
    const adapter = {
      bodyWriteKinds,
      authorize: async () => {},
      read: async () => [...remote.values()],
      write: async (record) => {
        remote.set(record.clientId, { ...record, id: record.clientId });
        return record.clientId;
      },
      remove: async (_, id) => {
        remote.delete(id);
      },
    };
    assert.equal((await health.syncHealth(adapter)).exported, bodyWriteKinds.length);
    assert.equal((await health.syncHealth(adapter)).exported, 0);
    assert.equal(db.select().from(schema.measurements).all().length, 2);
    db.update(schema.measurements)
      .set({ values: { shoulders: 130, bodyFat: 21 }, updatedAt: 2 })
      .where(eq(schema.measurements.id, local.id))
      .run();
    await health.syncHealth(adapter);
    assert.equal(remote.size, 1);
    assert.equal([...remote.values()][0].value, 21);
    db.delete(schema.measurements).run();
    await health.syncHealth(adapter);
    assert.equal(remote.size, 0);
    sqlite.close();
  }
});

test("HealthKit exports waist in centimeters and body fat as a fraction", async () => {
  const writes = [];
  let permission;
  const hk = {
    isHealthDataAvailable: () => true,
    requestAuthorization: async (value) => {
      permission = value;
    },
    authorizationStatusFor: () => 2,
    AuthorizationStatus: { sharingAuthorized: 2 },
    saveQuantitySample: async (...args) => {
      writes.push(args);
      return { uuid: "saved" };
    },
  };
  const { getHealthAdapter } = load("src/lib/health-native.ios.ts", {
    "@kingstinct/react-native-healthkit": hk,
  });
  const adapter = await getHealthAdapter();
  await adapter.authorize();
  assert.ok(permission.toShare.includes("HKQuantityTypeIdentifierWaistCircumference"));
  assert.equal(permission.toRead.length, 2);
  for (const [kind, value] of [
    ["waist", 80],
    ["bodyFat", 20],
  ])
    await adapter.write({
      kind,
      value,
      measuredAt: "2024-01-01T12:00:00Z",
      clientId: kind,
      version: 1,
    });
  assert.deepEqual(
    writes.map((args) => args.slice(0, 3)),
    [
      ["HKQuantityTypeIdentifierWaistCircumference", "cm", 80],
      ["HKQuantityTypeIdentifierBodyFatPercentage", "%", 0.2],
    ]
  );
});

test("Health Connect requests body-fat write permission and uses percentage points", async () => {
  let permissions;
  let saved;
  const hc = {
    SdkAvailabilityStatus: { SDK_AVAILABLE: 3 },
    getSdkStatus: async () => 3,
    initialize: async () => true,
    requestPermission: async (value) => {
      if (value.length > 1) permissions = value;
      return value;
    },
    RecordingMethod: { RECORDING_METHOD_MANUAL_ENTRY: 3 },
    insertRecords: async (records) => {
      saved = records;
      return ["saved"];
    },
  };
  const { getHealthAdapter } = load("src/lib/health-native.android.ts", {
    "react-native-health-connect": hc,
  });
  const adapter = await getHealthAdapter();
  await adapter.authorize();
  assert.ok(permissions.some((p) => p.recordType === "BodyFat" && p.accessType === "write"));
  assert.ok(!permissions.some((p) => p.recordType === "BodyFat" && p.accessType === "read"));
  await adapter.write({
    kind: "bodyFat",
    value: 20,
    measuredAt: "2024-01-01T12:00:00Z",
    clientId: "fat",
    version: 1,
  });
  assert.equal(saved[0].recordType, "BodyFat");
  assert.equal(saved[0].percentage, 20);
  await assert.rejects(adapter.write({ kind: "waist", value: 80 }), /healthUnavailable/);
});
