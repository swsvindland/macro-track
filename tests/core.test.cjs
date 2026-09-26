const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const ts = require("typescript");
const drizzleExpo = path.dirname(require.resolve("drizzle-orm/expo-sqlite"));
const { drizzle } = require(path.join(drizzleExpo, "driver.cjs"));
const { migrate } = require(path.join(drizzleExpo, "migrator.cjs"));
const { eq } = require("drizzle-orm");

// Execute production TypeScript under Node while substituting only native boundaries.
function load(file, dependencies = {}) {
  const output = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const sourceRequire = require("node:module").createRequire(path.resolve(file));
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
  return { sqlite, db: drizzle(expoClient(sqlite), { schema }) };
}
// Same Drizzle Expo driver as production, backed by real SQLite instead of a phone.
function expoClient(sqlite) {
  return {
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
    getFirstSync: (sql, ...params) => sqlite.prepare(sql).get(...params) ?? null,
    runSync: (sql, ...params) => sqlite.prepare(sql).run(...params),
    execSync: (sql) => sqlite.exec(sql),
  };
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
const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
// Drizzle's own migrator on real SQLite, stopping at any journal version.
function versionedDatabase(filename = ":memory:") {
  const sqlite = new DatabaseSync(filename);
  const expoDb = expoClient(sqlite);
  const db = drizzle(expoDb, { schema });
  const migrations = Object.fromEntries(
    journal.entries.map((entry) => [
      `m${String(entry.idx).padStart(4, "0")}`,
      readFileSync(`drizzle/${entry.tag}.sql`, "utf8"),
    ])
  );
  const upgrade = (count) =>
    migrate(db, { journal: { entries: journal.entries.slice(0, count) }, migrations });
  return { sqlite, db, expoDb, upgrade };
}
// A real temporary folder stands in for the app's Documents directory.
function documentsFolder() {
  const root = mkdtempSync(path.join(tmpdir(), "macro-track-"));
  const local = (uri) => decodeURIComponent(uri.replace(/^file:\/\//, ""));
  class Directory {
    constructor(parent, name) {
      this.uri = `${parent.uri}/${name}`;
    }
    get exists() {
      return existsSync(local(this.uri));
    }
    create() {
      mkdirSync(local(this.uri), { recursive: true });
    }
    delete() {
      rmSync(local(this.uri), { recursive: true });
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
    delete() {
      rmSync(local(this.uri));
    }
    moveSync(destination) {
      renameSync(local(this.uri), local(destination.uri));
      this.uri = destination.uri;
    }
  }
  const document = { uri: `file://${root}` };
  mkdirSync(path.join(root, "cache"));
  const fileSystem = {
    Directory,
    File,
    Paths: { document, cache: new Directory(document, "cache"), availableDiskSpace: Infinity },
  };
  const backups = path.join(root, "MacroTrackBackups");
  const files = () => (existsSync(backups) ? readdirSync(backups).sort() : []);
  const snapshot = load("src/db/snapshot.ts", { "expo-file-system": fileSystem });
  return { root, backups, files, fileSystem, snapshot };
}
test("a pending migration snapshots the database once; current and fresh databases are skipped", async (t) => {
  const { root, backups, files, snapshot } = documentsFolder();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fresh = new DatabaseSync(":memory:");
  assert.equal(snapshot.snapshotBeforeMigrations(expoClient(fresh), journal), null);
  // Drizzle creates its table before a first migration that may then roll back.
  fresh.exec(
    "CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text, created_at numeric)"
  );
  assert.equal(snapshot.snapshotBeforeMigrations(expoClient(fresh), journal), null);
  assert.deepEqual(files(), []);

  const { sqlite, db, expoDb, upgrade } = versionedDatabase();
  const latest = journal.entries.length - 1;
  await upgrade(latest);
  db.insert(schema.weightEntries).values({ weightKg: 80.5, measuredAt: "2024-01-01" }).run();
  assert.deepEqual(snapshot.migrationState(expoDb, journal), { applied: latest, pending: 1 });
  const name = `pre-migration-${latest}.db`;
  assert.equal(snapshot.snapshotBeforeMigrations(expoDb, journal).name, name);
  // A relaunch after a failed migration replaces the copy instead of failing on it.
  assert.equal(snapshot.snapshotBeforeMigrations(expoDb, journal).name, name);
  assert.deepEqual(files(), [name]);
  const copy = new DatabaseSync(path.join(backups, name), { readOnly: true });
  assert.equal(copy.prepare("SELECT weight_kg FROM weight_entries").get().weight_kg, 80.5);
  assert.equal(copy.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get().n, latest);
  copy.close();

  await upgrade(latest + 1);
  assert.equal(snapshot.snapshotBeforeMigrations(expoDb, journal), null);
  assert.deepEqual(files(), [name]);
  sqlite.close();
});
test("pre-migration snapshots keep the newest two and never block migrations", async (t) => {
  const { root, backups, files, fileSystem, snapshot } = documentsFolder();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { sqlite, expoDb, upgrade } = versionedDatabase();
  const count = journal.entries.length;
  await upgrade(count - 4);
  mkdirSync(backups);
  writeFileSync(path.join(backups, "before-restore-1.backup.json"), "{}");
  // Three app updates, each adding one migration.
  for (let applied = count - 4; applied < count - 1; applied++) {
    const bundled = { entries: journal.entries.slice(0, applied + 1) };
    assert.ok(snapshot.snapshotBeforeMigrations(expoDb, bundled));
    await upgrade(applied + 1);
  }
  const kept = [count - 3, count - 2].map((version) => `pre-migration-${version}.db`);
  assert.deepEqual(files(), ["before-restore-1.backup.json", ...kept].sort());

  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    // The disk fills partway through the copy; the half-written file must not keep the space.
    const full = {
      ...expoDb,
      runSync: (sql, target) => {
        expoDb.runSync(sql, target);
        writeFileSync(`${target}-journal`, "");
        throw new Error("database or disk is full");
      },
    };
    assert.equal(snapshot.snapshotBeforeMigrations(full, journal), null);
    assert.deepEqual(files(), ["before-restore-1.backup.json", ...kept].sort());
    // A copy killed with the app is cleared, and low storage leaves the space to the migration.
    writeFileSync(path.join(backups, "pre-migration.partial"), "x");
    writeFileSync(path.join(backups, "pre-migration.partial-journal"), "");
    fileSystem.Paths.availableDiskSpace = snapshot.snapshotSpace(expoDb) - 1;
    assert.equal(snapshot.snapshotBeforeMigrations(expoDb, journal), null);
    assert.deepEqual(files(), ["before-restore-1.backup.json", ...kept].sort());
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.length, 2);
  await upgrade(count);
  assert.deepEqual(snapshot.migrationState(expoDb, journal), { applied: count, pending: 0 });
  sqlite.close();
});
test("the migration error screen shares a database copy and erase removes every copy", async (t) => {
  const { root, backups, files, fileSystem, snapshot } = documentsFolder();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { sqlite, expoDb, upgrade } = versionedDatabase();
  const latest = journal.entries.length - 1;
  await upgrade(latest);
  const shared = [];
  const dataFiles = (migrationSnapshot) =>
    load("src/lib/data-files.ts", {
      "expo-file-system": fileSystem,
      "expo-sharing": {
        isAvailableAsync: async () => true,
        shareAsync: async (uri) => shared.push(uri),
      },
      "@/db": { expoDb, migrationSnapshot },
      "@/db/snapshot": snapshot,
      "./data-ownership": { erasePersonalRecords: () => {} },
      "./health": { withHealthPaused: (work) => work() },
      "./health-schedule": { configureHealthSchedule: async () => {} },
    });
  const startup = snapshot.snapshotBeforeMigrations(expoDb, journal);
  await dataFiles(startup).shareDatabaseCopy();
  // If the startup copy failed (low storage), the button tries again.
  rmSync(path.join(backups, startup.name));
  fileSystem.Paths.availableDiskSpace = snapshot.snapshotSpace(expoDb) - 1;
  await assert.rejects(dataFiles(null).shareDatabaseCopy(), /Not enough free storage/);
  fileSystem.Paths.availableDiskSpace = Infinity;
  await dataFiles(null).shareDatabaseCopy();
  assert.deepEqual(shared, [startup.uri, startup.uri]);
  assert.deepEqual(files(), [startup.name]);
  await dataFiles(startup).eraseLocalData();
  assert.equal(existsSync(backups), false);
  sqlite.close();
});
test("the diary database writes ahead to a log that copies include and erase empties", async (t) => {
  const { root, backups, fileSystem, snapshot } = documentsFolder();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "macro_track.db");
  const { sqlite, db, expoDb, upgrade } = versionedDatabase(file);
  const latest = journal.entries.length - 1;
  await upgrade(latest);
  const opened = load("src/db/index.ts", {
    "expo-sqlite": { openDatabaseSync: () => expoDb },
    "drizzle-orm/expo-sqlite": { drizzle },
    "./schema": schema,
    "./snapshot": snapshot,
  });
  assert.equal(sqlite.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  assert.equal(sqlite.prepare("PRAGMA synchronous").get().synchronous, 1, "NORMAL");
  assert.equal(opened.migrationSnapshot.name, `pre-migration-${latest}.db`);
  db.insert(schema.weightEntries).values({ weightKg: 80.5, measuredAt: "2024-01-01" }).run();
  assert.ok(statSync(`${file}-wal`).size > 0, "the new weight is still in the log");
  const copy = new DatabaseSync(path.join(backups, snapshot.snapshotDatabase(expoDb, 99).name), {
    readOnly: true,
  });
  assert.equal(copy.prepare("SELECT weight_kg FROM weight_entries").get().weight_kg, 80.5);
  assert.equal(copy.prepare("PRAGMA journal_mode").get().journal_mode, "delete", "self-contained");
  copy.close();
  const dataFiles = load("src/lib/data-files.ts", {
    "expo-file-system": fileSystem,
    "expo-sharing": {},
    "@/db": { expoDb, migrationSnapshot: null },
    "@/db/snapshot": snapshot,
    "./data-ownership": { erasePersonalRecords: () => db.delete(schema.weightEntries).run() },
    "./health": { withHealthPaused: (work) => work() },
    "./health-schedule": { configureHealthSchedule: async () => {} },
  });
  await dataFiles.eraseLocalData();
  assert.equal(statSync(`${file}-wal`).size, 0, "erased rows don't stay behind in the log");
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM weight_entries").get().n, 0);
  sqlite.close();
});
const fullAccess = { read: ["weight", "height"], write: ["weight", "height", "waist", "bodyFat"] };
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
    authorize: async () => fullAccess,
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
    authorize: async () => fullAccess,
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
  let fail = "";
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
        if (fail) throw new Error(fail);
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
  fail = "offline";
  await assert.rejects(schedule.enableHealthSync(), /offline/);
  assert.notEqual(get("healthSyncEnabled"), "true");
  fail = "";
  await schedule.enableHealthSync();
  assert.equal(registered, true);
  assert.equal(get("healthSyncEnabled"), "true");
  const afterEnable = calls;
  await task();
  assert.equal(calls, afterEnable);
  const overdue = new Date(now - 86400001).toISOString();
  set("lastSync", overdue);
  fail = "offline";
  assert.equal(await task(), 2);
  assert.equal(get("lastSync"), overdue);
  assert.equal(get("healthSyncError"), "syncFailed");
  fail = "healthWeightDenied";
  assert.equal(await task(), 2);
  assert.equal(get("healthSyncError"), "healthWeightDenied");
  fail = "";
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

test("body exports follow granted kinds and handle edits, removed fields and retries", async () => {
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
      authorize: async () => ({
        read: ["weight", "height"],
        write: ["weight", "height", ...bodyWriteKinds],
      }),
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
  assert.deepEqual(await adapter.authorize(), fullAccess);
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
  assert.deepEqual(await adapter.authorize(), {
    read: ["weight", "height"],
    write: ["weight", "height", "bodyFat"],
  });
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

test("health sync imports weights and skips exports and deletions for denied kinds", async () => {
  const { db, sqlite } = database();
  const health = load("src/lib/health.ts", {
    "expo-constants": { appOwnership: "standalone" },
    "@/db": { db, ...schema },
    "./health-native": {},
    "./metrics": metrics,
  });
  db.insert(schema.weightEntries)
    .values({ weightKg: 80, measuredAt: "2024-01-01T12:00:00Z" })
    .run();
  db.insert(schema.measurements)
    .values({ kind: "height", measuredAt: "2024-01-01", values: { height: 180 }, updatedAt: 1 })
    .run();
  const body = db
    .insert(schema.measurements)
    .values({
      kind: "body",
      values: { waist: 80, bodyFat: 20 },
      measuredAt: "2024-01-01T12:00:00Z",
      updatedAt: 1,
    })
    .returning()
    .get();
  const remote = new Map([
    ["scale", { id: "scale", kind: "weight", value: 79.5, measuredAt: "2024-01-02T07:00:00Z" }],
  ]);
  let access = { read: ["weight", "height"], write: ["weight", "height"] };
  let readKinds;
  const removed = [];
  const adapter = {
    authorize: async () => access,
    read: async (kinds) => {
      readKinds = kinds;
      return [...remote.values()].filter((record) => kinds.includes(record.kind));
    },
    write: async (record) => {
      if (!access.write.includes(record.kind)) throw new Error("denied");
      remote.set(record.clientId, { ...record, id: record.clientId });
      return record.clientId;
    },
    remove: async (kind, id) => {
      if (!access.write.includes(kind)) throw new Error("denied");
      removed.push(kind);
      remote.delete(id);
    },
  };
  // Waist and body fat denied: weights still import; only granted kinds export.
  assert.deepEqual(await health.syncHealth(adapter), { imported: 1, exported: 2 });
  assert.deepEqual(readKinds, ["weight", "height"]);
  assert.deepEqual([...remote.values()].map((r) => r.kind).sort(), ["height", "weight", "weight"]);
  assert.equal(db.select().from(schema.weightEntries).all().length, 2);
  // Granting body fat later exports it; revoking it again leaves Health untouched on delete.
  access = { read: ["weight", "height"], write: ["weight", "height", "bodyFat"] };
  assert.equal((await health.syncHealth(adapter)).exported, 1);
  access = { read: ["weight"], write: ["weight"] };
  db.delete(schema.measurements).where(eq(schema.measurements.id, body.id)).run();
  assert.deepEqual(await health.syncHealth(adapter), { imported: 0, exported: 0 });
  assert.deepEqual(readKinds, ["weight"]);
  assert.deepEqual(removed, []);
  assert.ok([...remote.values()].some((r) => r.kind === "bodyFat"));
  access = { read: ["weight", "height"], write: ["weight", "height", "bodyFat"] };
  await health.syncHealth(adapter);
  assert.deepEqual(removed, ["bodyFat"]);
  sqlite.close();
});

test("health sync names denied weight access and changes nothing", async () => {
  const { db, sqlite } = database();
  const health = load("src/lib/health.ts", {
    "expo-constants": { appOwnership: "standalone" },
    "@/db": { db, ...schema },
    "./health-native": {},
    "./metrics": metrics,
  });
  db.insert(schema.weightEntries)
    .values({ weightKg: 80, measuredAt: "2024-01-01T12:00:00Z" })
    .run();
  let calls = 0;
  const adapter = {
    authorize: async () => ({ read: ["height"], write: ["weight", "height"] }),
    read: async () => {
      calls++;
      return [];
    },
    write: async () => {
      calls++;
      return "remote";
    },
    remove: async () => {},
  };
  await assert.rejects(health.syncHealth(adapter), /^Error: healthWeightDenied$/);
  assert.equal(calls, 0);
  assert.equal(db.select().from(schema.healthLinks).all().length, 0);
  assert.equal(
    db.select().from(schema.preferences).where(eq(schema.preferences.key, "lastSync")).get(),
    undefined
  );
  sqlite.close();
});

function healthKit(samples = {}) {
  const hk = {
    denied: [],
    queried: [],
    saved: 0,
    isHealthDataAvailable: () => true,
    requestAuthorization: async () => true,
    authorizationStatusFor: (type) => (hk.denied.includes(type) ? 1 : 2),
    AuthorizationStatus: { sharingAuthorized: 2 },
    queryQuantitySamples: async (type) => {
      hk.queried.push(type);
      return (samples[type] ?? []).map(([uuid, quantity, date, sync]) => ({
        uuid,
        quantity,
        startDate: new Date(date),
        metadata: sync ? { HKSyncIdentifier: sync } : {},
      }));
    },
    saveQuantitySample: async () => {
      hk.saved++;
      return { uuid: "saved" };
    },
  };
  return hk;
}
const mass = "HKQuantityTypeIdentifierBodyMass";
const heightType = "HKQuantityTypeIdentifierHeight";
const waistType = "HKQuantityTypeIdentifierWaistCircumference";
const fatType = "HKQuantityTypeIdentifierBodyFatPercentage";

test("HealthKit reports granted writes and reads only requested kinds", async () => {
  const samples = { [mass]: [] };
  const hk = healthKit(samples);
  const { getHealthAdapter } = load("src/lib/health-native.ios.ts", {
    "@kingstinct/react-native-healthkit": hk,
  });
  const adapter = await getHealthAdapter();
  hk.denied = [waistType, fatType];
  assert.deepEqual(await adapter.authorize(false), {
    read: ["weight", "height"],
    write: ["weight", "height"],
  });
  // Weight write off alone still imports, even with nothing in Health yet.
  hk.denied = [mass];
  assert.deepEqual((await adapter.authorize(false)).read, ["weight", "height"]);
  assert.deepEqual(await adapter.read(["weight"]), []);
  assert.deepEqual(hk.queried, [mass]);
  // Every write off: only an outside weight tells an import-only grant from "Don't Allow".
  hk.denied = [mass, heightType, waistType, fatType];
  assert.deepEqual(await adapter.authorize(false), { read: ["weight", "height"], write: [] });
  await assert.rejects(adapter.read(["weight", "height"]), /^Error: healthWeightDenied$/);
  samples[mass] = [["own", 80, "2024-01-01T12:00:00Z", "macro-track:1:weight:1"]];
  await assert.rejects(adapter.read(["weight", "height"]), /^Error: healthWeightDenied$/);
  samples[mass].push(["scale", 79.5, "2024-01-02T07:00:00Z"]);
  assert.deepEqual(
    (await adapter.read(["weight"])).map((record) => record.id),
    ["own", "scale"]
  );
});

test("HealthKit import-only grant imports weights; Don't Allow changes nothing", async () => {
  const { db, sqlite } = database();
  const health = load("src/lib/health.ts", {
    "expo-constants": { appOwnership: "standalone" },
    "@/db": { db, ...schema },
    "./health-native": {},
    "./metrics": metrics,
  });
  db.insert(schema.weightEntries)
    .values({ weightKg: 80, measuredAt: "2024-01-01T12:00:00Z" })
    .run();
  const samples = {};
  const hk = healthKit(samples);
  hk.denied = [mass, heightType, waistType, fatType];
  const { getHealthAdapter } = load("src/lib/health-native.ios.ts", {
    "@kingstinct/react-native-healthkit": hk,
  });
  await assert.rejects(
    health.syncHealth(await getHealthAdapter(), false),
    /^Error: healthWeightDenied$/
  );
  assert.equal(db.select().from(schema.weightEntries).all().length, 1);
  assert.equal(
    db.select().from(schema.preferences).where(eq(schema.preferences.key, "lastSync")).get(),
    undefined
  );
  samples[mass] = [["scale", 79.5, "2024-01-02T07:00:00Z"]];
  samples[heightType] = [["tape", 180, "2024-01-02T07:00:00Z"]];
  assert.deepEqual(await health.syncHealth(await getHealthAdapter(), false), {
    imported: 2,
    exported: 0,
  });
  assert.equal(hk.saved, 0);
  assert.deepEqual(
    db
      .select()
      .from(schema.weightEntries)
      .all()
      .map((w) => w.weightKg)
      .sort(),
    [79.5, 80]
  );
  sqlite.close();
});

test("Health Connect reports each granted permission and reads only those types", async () => {
  let granted = [];
  const read = [];
  const hc = {
    SdkAvailabilityStatus: { SDK_AVAILABLE: 3 },
    getSdkStatus: async () => 3,
    initialize: async () => true,
    getGrantedPermissions: async () => granted,
    readRecords: async (type) => {
      read.push(type);
      return { records: [] };
    },
  };
  const { getHealthAdapter } = load("src/lib/health-native.android.ts", {
    "react-native-health-connect": hc,
  });
  const adapter = await getHealthAdapter();
  const allow = (recordType, accessType) => ({ recordType, accessType });
  granted = [allow("Weight", "read"), allow("Weight", "write"), allow("Height", "read")];
  assert.deepEqual(await adapter.authorize(false), {
    read: ["weight", "height"],
    write: ["weight"],
  });
  granted = [allow("Weight", "write"), allow("BodyFat", "write")];
  assert.deepEqual(await adapter.authorize(false), { read: [], write: ["weight", "bodyFat"] });
  await adapter.read(["weight"]);
  assert.deepEqual(read, ["Weight"]);
});

test("restore maintenance excludes health sync and releases the lock after failure", async () => {
  const { db, sqlite } = database();
  const health = load("src/lib/health.ts", {
    "expo-constants": { appOwnership: "standalone" },
    "@/db": { db, ...schema },
    "./health-native": {},
    "./metrics": metrics,
  });
  const adapter = {
    authorize: async () => fullAccess,
    read: async () => [],
    write: async () => "remote",
    remove: async () => {},
  };
  await health.withHealthPaused(async () => {
    await assert.rejects(() => health.syncHealth(adapter), /syncing/);
    await assert.rejects(() => health.withHealthPaused(async () => {}), /Wait for health sync/);
  });
  await assert.rejects(
    () =>
      health.withHealthPaused(async () => {
        throw new Error("disk full");
      }),
    /disk full/
  );
  await health.syncHealth(adapter);
  let unblock;
  const gate = new Promise((resolve) => (unblock = resolve));
  const pending = health.syncHealth({ ...adapter, authorize: () => gate });
  await assert.rejects(() => health.withHealthPaused(async () => {}), /Wait for health sync/);
  unblock(fullAccess);
  await pending;
  sqlite.close();
});

test("restored weight IDs use a new health namespace without changing other exports", async () => {
  const { db, sqlite } = database();
  const health = load("src/lib/health.ts", {
    "expo-constants": { appOwnership: "standalone" },
    "@/db": { db, ...schema },
    "./health-native": {},
    "./metrics": metrics,
  });
  db.insert(schema.preferences).values({ key: "installation", value: "test-phone" }).run();
  db.insert(schema.preferences).values({ key: "weightSyncEpoch", value: "restore-1" }).run();
  db.insert(schema.weightEntries).values({ weightKg: 80, measuredAt: "2024-01-01" }).run();
  db.insert(schema.measurements)
    .values({ kind: "height", measuredAt: "2024-01-01", values: { height: 180 }, updatedAt: 1 })
    .run();
  const writes = [];
  await health.syncHealth({
    authorize: async () => fullAccess,
    read: async () => [],
    write: async (record) => {
      writes.push(record);
      return record.clientId;
    },
    remove: async () => {},
  });
  assert.ok(
    writes
      .find((row) => row.kind === "weight")
      .clientId.startsWith("macro-track:test-phone:restored-restore-1:weight:")
  );
  assert.ok(
    writes
      .find((row) => row.kind === "height")
      .clientId.startsWith("macro-track:test-phone:height:")
  );
  sqlite.close();
});
