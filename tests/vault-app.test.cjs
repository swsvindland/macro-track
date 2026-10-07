// Pendum Macros' own vault tests (docs/vault.md §12; spec §13.3): the Health provenance of a restore — the 30-day food
// window, a cross-platform restore, the iPhone → Android → new iPhone round trip, a v1 backup restored on the phone
// that made it, a restored Health import at an id this phone wrote to Health — the Health engine changes the vault
// relies on (the pause, the lineage, content adoption, removal by client id, idempotent deletes) and the macro
// validators. They run the vault, src/lib/health.ts and the real
// HealthKit / Health Connect adapters in harness worlds (tests/vault-harness.cjs); the Health stores are fakes that
// answer like the real ones: an upsert under a client id replaces, a delete that matches nothing fails on iOS.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const fs = require("node:fs");

const vault = require("./vault-harness.cjs");

const PASSWORD = "correct horse battery staple";
const pad = (n) => String(n).padStart(2, "0");
const localDay = (date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
/** The local day `n` days back, as the diary writes days. */
const daysAgo = (n) => {
  const date = new Date();
  date.setDate(date.getDate() - n);
  return localDay(date);
};
/** A morning `n` days back, as an ISO time (weights, measurements). */
const morning = (n) => {
  const date = new Date();
  date.setDate(date.getDate() - n);
  date.setHours(7, 0, 0, 0);
  return date.toISOString();
};

// ---------------------------------------------------------------------------------------------------------------
// Health stores

/**
 * One HealthKit store (an Apple Account's Health data, which its iPhones share) as the app's iOS adapter sees it:
 * a sample saved under an HKSyncIdentifier replaces the sample with that identifier unless its HKSyncVersion is
 * older; a delete by uuid or by sync identifier that matches nothing rejects, as HealthKit does. A uuid delete with an
 * empty id is recorded as a violation. Sample uuids start with `name`, so two stores never issue the same one.
 */
function healthKit(name = "HK") {
  const samples = new Map();
  const violations = [];
  let next = 0;
  const syncId = (s) => s.metadata.HKSyncIdentifier;
  const notFound = () => new Error("No data available for the specified predicate.");
  const module = {
    isHealthDataAvailable: () => true,
    requestAuthorization: async () => true,
    authorizationStatusFor: () => 2,
    AuthorizationStatus: { sharingAuthorized: 2 },
    ComparisonPredicateOperator: { equalTo: 4 },
    BiologicalSex: { notSet: 0, female: 1, male: 2 },
    getDateOfBirthAsync: async () => undefined,
    getBiologicalSexAsync: async () => 0,
    async queryQuantitySamples(type) {
      return [...samples.values()]
        .filter((s) => s.type === type)
        .map((s) => ({ ...s, startDate: new Date(s.startDate) }));
    },
    async saveQuantitySample(type, unit, quantity, start, end, metadata) {
      const id = metadata?.HKSyncIdentifier;
      const old =
        id === undefined
          ? undefined
          : [...samples.values()].find((s) => s.type === type && syncId(s) === id);
      if (old) {
        if (metadata.HKSyncVersion < old.metadata.HKSyncVersion) return { uuid: old.uuid };
        samples.delete(old.uuid);
      }
      const uuid = `${name}-${++next}`;
      samples.set(uuid, {
        uuid,
        type,
        quantity,
        startDate: start.toISOString(),
        metadata: { ...metadata },
      });
      return { uuid };
    },
    async deleteObjects(type, filter) {
      if ("uuid" in filter) {
        if (!filter.uuid) violations.push(`uuid delete with an empty id (${type})`);
        const sample = samples.get(filter.uuid);
        if (!sample || sample.type !== type) throw notFound();
        samples.delete(sample.uuid);
        return 1;
      }
      const matched = [...samples.values()].filter(
        (s) => s.type === type && syncId(s) === filter.metadata.value
      );
      if (!matched.length) throw notFound();
      for (const s of matched) samples.delete(s.uuid);
      return matched.length;
    },
  };
  const dietary = (s) => s.type.startsWith("HKQuantityTypeIdentifierDietary");
  return {
    module,
    violations,
    samples,
    /** A reading another app saved (no sync identifier). */
    add(type, quantity, at) {
      const uuid = `${name}-${++next}`;
      samples.set(uuid, { uuid, type, quantity, startDate: at, metadata: {} });
      return uuid;
    },
    /** This app's body samples (weight, height, waist, body fat) by sync identifier. */
    body: () =>
      [...samples.values()]
        .filter((s) => !dietary(s) && syncId(s))
        .map(syncId)
        .sort(),
    /** Body samples by sync identifier → their value. */
    quantities: () =>
      Object.fromEntries(
        [...samples.values()]
          .filter((s) => !dietary(s) && syncId(s))
          .map((s) => [syncId(s), s.quantity])
      ),
    /** Body samples by sync identifier → uuid and version. */
    versions: () =>
      Object.fromEntries(
        [...samples.values()]
          .filter((s) => !dietary(s) && syncId(s))
          .map((s) => [syncId(s), [s.uuid, s.metadata.HKSyncVersion]])
      ),
    /** Diary entries: the client id their nutrient samples share. */
    food: () =>
      [
        ...new Set(
          [...samples.values()].filter(dietary).map((s) => syncId(s).replace(/:[A-Za-z0-9]+$/, ""))
        ),
      ].sort(),
  };
}

/**
 * One Health Connect store as the app's Android adapter sees it: a record inserted under a clientRecordId updates the
 * record with that id unless its version is older; reads honour the time range; deletes of unknown ids do nothing.
 */
function healthConnect() {
  const records = new Map();
  const violations = [];
  let next = 0;
  const granted = [
    ...["Weight", "Height"].flatMap((recordType) =>
      ["read", "write"].map((accessType) => ({ recordType, accessType }))
    ),
    { recordType: "BodyFat", accessType: "write" },
    { recordType: "Nutrition", accessType: "write" },
  ];
  const clientOf = (r) => r.metadata?.clientRecordId;
  const module = {
    SdkAvailabilityStatus: { SDK_AVAILABLE: 3 },
    getSdkStatus: async () => 3,
    initialize: async () => true,
    requestPermission: async (permissions) => permissions,
    getGrantedPermissions: async () => granted,
    RecordingMethod: { RECORDING_METHOD_MANUAL_ENTRY: 3 },
    MealType: { BREAKFAST: 1, LUNCH: 2, DINNER: 3, SNACK: 4 },
    async readRecords(type, { timeRangeFilter }) {
      const from = Date.parse(timeRangeFilter.startTime);
      const to = Date.parse(timeRangeFilter.endTime);
      const found = [...records.values()].filter(
        (r) => r.recordType === type && Date.parse(r.time) >= from && Date.parse(r.time) <= to
      );
      return {
        records: found.map((r) => ({
          time: r.time,
          ...(type === "Weight"
            ? { weight: { inKilograms: r.weight.value } }
            : { height: { inMeters: r.height.value } }),
          metadata: { id: r.id, clientRecordId: clientOf(r) },
        })),
        pageToken: undefined,
      };
    },
    async insertRecords(list) {
      return list.map((record) => {
        const client = clientOf(record);
        const old = client
          ? [...records.values()].find(
              (r) => r.recordType === record.recordType && clientOf(r) === client
            )
          : undefined;
        if (old && record.metadata.clientRecordVersion < old.metadata.clientRecordVersion)
          return old.id;
        const id = old ? old.id : `HC-${++next}`;
        records.set(id, { ...record, id });
        return id;
      });
    },
    async deleteRecordsByUuids(type, ids, clientIds) {
      for (const id of ids) {
        if (!id) violations.push(`uuid delete with an empty id (${type})`);
        if (records.get(id)?.recordType === type) records.delete(id);
      }
      for (const client of clientIds)
        for (const r of [...records.values()])
          if (r.recordType === type && clientOf(r) === client) records.delete(r.id);
    },
  };
  return {
    module,
    violations,
    records,
    /** Client ids of one record type. */
    clients: (type) =>
      [...records.values()]
        .filter((r) => r.recordType === type)
        .map(clientOf)
        .sort(),
  };
}

/** A Health adapter (src/lib/health-types.ts) that records what sync asks of it and accepts everything. */
function recorder() {
  const calls = [];
  let next = 0;
  return {
    calls,
    adapter: {
      authorize: async () => ({
        read: ["weight", "height"],
        write: ["weight", "height", "waist", "bodyFat", "food"],
      }),
      read: async () => [],
      write: async (record) => {
        calls.push({ call: "write", clientId: record.clientId });
        return `R-${++next}`;
      },
      remove: async (kind, id, clientId) => {
        calls.push({ call: "remove", kind, id, clientId });
      },
      writeFood: async (food) => {
        calls.push({ call: "writeFood", clientId: food.clientId, replacing: food.replacing });
        return `R-${++next}`;
      },
      removeFood: async (clientId, id) => {
        calls.push({ call: "removeFood", clientId, id });
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Devices and data

/**
 * A phone: a harness world with the app's migrated database, the vault's entry points and the app's real Health
 * engine (src/lib/health.ts, whose adapter is the platform's real one over `stubs`).
 */
async function phone(t, platform, stubs = {}) {
  const w = await vault.world({ platform, stubs });
  t.after(() => w.close());
  const db = await w.live();
  return {
    w,
    db,
    File: w.require("expo-file-system").File,
    app: w.vaultApp,
    ops: w.require("@/vault/ops"),
    paths: w.require("@/vault/engine/paths"),
    health: w.require("src/lib/health.ts"),
  };
}

let files = 0;
/** A manual export of `from`, copied into `to`'s Documents/in/ (a file shared between phones). */
async function carry(from, to) {
  fs.mkdirSync(from.w.file("out"), { recursive: true });
  const name = `macros-${++files}.pendummacros`;
  const { file } = await from.ops.runExport({
    kind: "manual",
    destination: new from.File(from.w.uri("out", name)),
    embedMedia: true,
    csv: false,
    deflateLevel: 6,
  });
  fs.mkdirSync(to.w.file("in"), { recursive: true });
  fs.copyFileSync(from.paths.fsPath(file), to.w.file("in", name));
  return new to.File(to.w.uri("in", name));
}

/** Opens and restores a file on `device`, as the import screen does. */
async function restore(device, file, options = {}) {
  const archive = await device.ops.runOpen(file, options);
  try {
    return await device.ops.runRestore(archive, { reason: "file" });
  } finally {
    archive.close();
  }
}

const food = (name, calories) => ({
  id: `usda:${name.toLowerCase().replaceAll(" ", "-")}`,
  name,
  brand: "",
  barcode: null,
  basis: "g",
  nutrients: { calories, protein: 10, carbs: 20, fat: 5, fiber: null, sodium: null },
  portions: [{ label: "1 cup", amount: 100 }],
  source: "usda",
  sourceVersion: "2024-10",
});

/**
 * A library: food logged 60, 2 and 1 days ago (entries 1–3), three weights, a height and a body measurement with
 * waist and body fat, and the given Health preferences.
 */
function library(db, preferences = {}) {
  const meals = [
    [1, daysAgo(60), "Lunch", "Brown rice", 220],
    [2, daysAgo(2), "Breakfast", "Rolled oats", 380],
    [3, daysAgo(1), "Dinner", "Roast chicken", 165],
  ];
  for (const [id, day, meal, name, calories] of meals) {
    const f = food(name, calories);
    db.runSync(
      "INSERT INTO food_entries (id, day, meal, food, amount, portion_label, nutrients, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [id, day, meal, JSON.stringify(f), 100, "100 g", JSON.stringify(f.nutrients), Date.now()]
    );
  }
  for (const [id, kg, at] of [
    [1, 80, morning(20)],
    [2, 79.5, morning(10)],
    [3, 79, morning(3)],
  ])
    db.runSync(
      "INSERT INTO weight_entries (id, weight_kg, measured_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      [id, kg, at, Math.floor(Date.parse(at) / 1000), Math.floor(Date.parse(at) / 1000)]
    );
  db.runSync(
    "INSERT INTO measurements (id, kind, measured_at, \"values\", updated_at) VALUES (1, 'height', ?, ?, 1)",
    [morning(20), JSON.stringify({ height: 172 })]
  );
  db.runSync(
    "INSERT INTO measurements (id, kind, measured_at, \"values\", updated_at) VALUES (2, 'body', ?, ?, 1)",
    [morning(20), JSON.stringify({ waist: 80, bodyFat: 22 })]
  );
  for (const [key, value] of Object.entries(preferences))
    db.runSync("INSERT INTO preferences (key, value) VALUES (?, ?)", [key, value]);
}

const pref = (db, key) =>
  db.getFirstSync("SELECT value FROM preferences WHERE key = ?", [key])?.value;
const links = (db, where = "1") =>
  Object.fromEntries(
    db
      .getAllSync(
        `SELECT key, local_kind, local_id, remote_id, fingerprint, origin FROM health_links WHERE ${where} ORDER BY key`
      )
      .map((l) => [l.key, { ...l }])
  );
const count = (db, table) => db.getFirstSync(`SELECT count(*) AS n FROM ${table}`).n;
/** The tables a v1 backup holds (src/vault-legacy.ts; spec §2.11). */
const V1_TABLES = [
  "weight_entries",
  "food_entries",
  "custom_foods",
  "saved_foods",
  "diary_days",
  "nutrition_targets",
  "saved_meals",
  "recipes",
  "coaching_goals",
  "check_ins",
];
/** A table's rows in key order, without the vault's sync ids (a v1 file carries none; restored rows get new ones). */
const rows = (db, table) =>
  db.getAllSync(`SELECT * FROM ${table} ORDER BY 1`).map((row) => {
    const copy = { ...row };
    delete copy.sync_id;
    return copy;
  });
const weightsOf = (db) =>
  db
    .getAllSync("SELECT id, weight_kg AS kg FROM weight_entries ORDER BY id")
    .map((r) => [r.id, r.kg]);
const measurementsOf = (db) =>
  db.getAllSync('SELECT id, kind, "values" FROM measurements ORDER BY id').map((r) => ({ ...r }));

// ---------------------------------------------------------------------------------------------------------------
// Provenance on restore (spec §5.3)

test(
  "another phone on the same platform rewrites only the last 30 days of food, under the archive's client ids",
  { skip: vault.skip },
  async (t) => {
    const source = await phone(t, "ios");
    library(source.db, { installation: "A", healthFoodSince: daysAgo(90) });
    const first = recorder();
    await source.health.syncHealth(first.adapter);
    const exported = links(source.db);
    assert.deepEqual(Object.keys(exported), [
      "macro-track:A:bodyFat:2",
      "macro-track:A:food:1",
      "macro-track:A:food:2",
      "macro-track:A:food:3",
      "macro-track:A:height:1",
      "macro-track:A:waist:2",
      "macro-track:A:weight:1",
      "macro-track:A:weight:2",
      "macro-track:A:weight:3",
    ]);

    const target = await phone(t, "ios");
    await restore(target, await carry(source, target));
    const restored = links(target.db);
    assert.deepEqual(Object.keys(restored), Object.keys(exported), "every link travels");
    for (const [key, link] of Object.entries(restored)) {
      assert.equal(link.remote_id, exported[key].remote_id, `${key}: same platform keeps ids`);
      // Food logged before the 30-day window keeps its fingerprint; everything else is written again once.
      const kept = key === "macro-track:A:food:1";
      assert.equal(link.fingerprint, kept ? exported[key].fingerprint : "", key);
    }
    const installation = pref(target.db, "installation");
    assert.notEqual(installation, "A", "another phone gets its own installation");
    assert.deepEqual(JSON.parse(pref(target.db, "healthInstallations")), ["A"]);
    assert.equal(pref(target.db, "healthFoodSince"), daysAgo(90));
    assert.equal(pref(target.db, "healthSyncEnabled"), "false");

    const next = recorder();
    await target.health.syncHealth(next.adapter, false, "food");
    assert.deepEqual(next.calls, [
      { call: "writeFood", clientId: "macro-track:A:food:2", replacing: true },
      { call: "writeFood", clientId: "macro-track:A:food:3", replacing: true },
    ]);
    const all = recorder();
    await target.health.syncHealth(all.adapter);
    assert.deepEqual(
      all.calls.map((c) => c.clientId).sort(),
      [
        "macro-track:A:bodyFat:2",
        "macro-track:A:height:1",
        "macro-track:A:waist:2",
        "macro-track:A:weight:1",
        "macro-track:A:weight:2",
        "macro-track:A:weight:3",
      ],
      "body records upsert under their own client ids; food is in sync"
    );
    assert.deepEqual(
      JSON.parse(pref(target.db, "healthInstallations")),
      ["A", installation].sort(),
      "syncing adds this phone's installation to the lineage"
    );
  }
);

test(
  "a cross-platform restore keeps the archive's client ids, drops old food links and food tombstones, and restarts the food window",
  { skip: vault.skip },
  async (t) => {
    const source = await phone(t, "ios");
    library(source.db, {
      installation: "A",
      weightSyncEpoch: "E",
      healthFoodSince: daysAgo(90),
    });
    await source.health.syncHealth(recorder().adapter);
    // Entry 3 deleted and removed from Health: its link is a tombstone.
    source.db.runSync("DELETE FROM food_entries WHERE id = 3");
    await source.health.syncHealth(recorder().adapter, false, "food");
    assert.equal(links(source.db)["macro-track:A:food:3"].fingerprint, "deleted");

    const target = await phone(t, "android");
    await restore(target, await carry(source, target));
    const restored = links(target.db);
    assert.deepEqual(Object.keys(restored), [
      "macro-track:A:bodyFat:2",
      "macro-track:A:food:2",
      "macro-track:A:height:1",
      "macro-track:A:restored-E:weight:1",
      "macro-track:A:restored-E:weight:2",
      "macro-track:A:restored-E:weight:3",
      "macro-track:A:waist:2",
    ]);
    for (const [key, link] of Object.entries(restored))
      assert.deepEqual([link.remote_id, link.fingerprint], ["", ""], key);
    assert.equal(pref(target.db, "healthFoodSince"), undefined, "the food window restarts");
    assert.equal(pref(target.db, "weightSyncEpoch"), "E", "restored weights keep their keys");

    const next = recorder();
    await target.health.syncHealth(next.adapter, false, "food");
    assert.deepEqual(next.calls, [
      { call: "writeFood", clientId: "macro-track:A:food:2", replacing: true },
    ]);
    // The window health.ts opens on a first food sync: 30 × 24 hours back.
    assert.equal(
      pref(target.db, "healthFoodSince"),
      localDay(new Date(Date.now() - 30 * 86400000))
    );
  }
);

test(
  "iPhone → Android → new iPhone: every record keeps its client id, Health holds each once, new records get each phone's installation",
  { skip: vault.skip },
  async (t) => {
    const apple = healthKit(); // one Apple Account: both iPhones share its Health data
    const google = healthConnect();
    const iphone = await phone(t, "ios", { "@kingstinct/react-native-healthkit": apple.module });
    library(iphone.db, { installation: "A", weightSyncEpoch: "E" });
    await iphone.health.syncHealth();
    const original = [
      "macro-track:A:bodyFat:2",
      "macro-track:A:height:1",
      "macro-track:A:restored-E:weight:1",
      "macro-track:A:restored-E:weight:2",
      "macro-track:A:restored-E:weight:3",
      "macro-track:A:waist:2",
    ];
    assert.deepEqual(apple.body(), original);
    assert.deepEqual(apple.food(), ["macro-track:A:food:2", "macro-track:A:food:3"]);
    const before = apple.versions();

    // Android: the same records, under the same client ids, in its own Health Connect store.
    const android = await phone(t, "android", { "react-native-health-connect": google.module });
    await restore(android, await carry(iphone, android));
    await android.health.syncHealth();
    assert.deepEqual(
      google.clients("Weight"),
      original.filter((k) => k.includes(":weight:"))
    );
    assert.deepEqual(google.clients("Height"), ["macro-track:A:height:1"]);
    assert.deepEqual(google.clients("BodyFat"), ["macro-track:A:bodyFat:2"]);
    assert.deepEqual(google.clients("Nutrition"), ["macro-track:A:food:2", "macro-track:A:food:3"]);
    // A weight added and another deleted on Android.
    const b = pref(android.db, "installation");
    assert.ok(b && b !== "A");
    android.db.runSync(
      "INSERT INTO weight_entries (id, weight_kg, measured_at, created_at, updated_at) VALUES (4, 78.8, ?, 1, 1)",
      [morning(1)]
    );
    android.db.runSync("DELETE FROM weight_entries WHERE id = 2");
    await android.health.syncHealth();
    assert.deepEqual(
      google.clients("Weight"),
      [
        "macro-track:A:restored-E:weight:1",
        "macro-track:A:restored-E:weight:3",
        `macro-track:${b}:restored-E:weight:4`,
      ].sort()
    );
    assert.equal(count(android.db, "health_links WHERE origin = 'health'"), 0, "nothing imported");

    // The new iPhone shares the first one's Health data, which still holds every original sample.
    const newPhone = await phone(t, "ios", { "@kingstinct/react-native-healthkit": apple.module });
    await restore(newPhone, await carry(android, newPhone));
    await newPhone.health.syncHealth();
    const expected = [
      ...original.filter((k) => k !== "macro-track:A:restored-E:weight:2"),
      `macro-track:${b}:restored-E:weight:4`,
    ].sort();
    assert.deepEqual(
      apple.body(),
      expected,
      "iPhone 1's samples + Android's addition − its deletion"
    );
    assert.equal(apple.body().length, original.length + 1 - 1);
    const after = apple.versions();
    for (const key of original.filter((k) => k in after))
      assert.ok(after[key][1] > before[key][1], `${key} was replaced under its own client id`);
    assert.deepEqual(apple.food(), ["macro-track:A:food:2", "macro-track:A:food:3"]);
    assert.equal(count(newPhone.db, "weight_entries"), 3, "no own sample comes back as a reading");
    assert.equal(count(newPhone.db, "health_links WHERE origin = 'health'"), 0);

    const c = pref(newPhone.db, "installation");
    assert.ok(c && c !== "A" && c !== b, "a third installation");
    newPhone.db.runSync(
      "INSERT INTO weight_entries (id, weight_kg, measured_at, created_at, updated_at) VALUES (5, 78.6, ?, 1, 1)",
      [morning(0)]
    );
    await newPhone.health.syncHealth();
    assert.ok(apple.body().includes(`macro-track:${c}:restored-E:weight:5`));
    assert.deepEqual(
      [...apple.violations, ...google.violations],
      [],
      "no uuid delete with an empty id"
    );
  }
);

test(
  "a v1 backup restored on the phone that made it: its ten tables come back from the file, only weight links are replaced, installation and weight namespace kept, no Health duplicates",
  { skip: vault.skip },
  async (t) => {
    const apple = healthKit();
    const device = await phone(t, "ios", { "@kingstinct/react-native-healthkit": apple.module });
    const { db } = device;
    library(db, { installation: "A", weightSyncEpoch: "E", healthFoodSince: daysAgo(90) });
    // A scale reading and a height from other apps, imported as weight 4 and measurement 3.
    apple.add("HKQuantityTypeIdentifierBodyMass", 79.2, morning(5));
    apple.add("HKQuantityTypeIdentifierHeight", 175, morning(15));
    await device.health.syncHealth();
    assert.equal(count(db, "weight_entries"), 4);
    const importedHeight = links(db, "origin = 'health' AND local_kind = 'height'");
    assert.deepEqual(
      Object.values(importedHeight).map((l) => l.local_id),
      [3],
      "a height imported from Health: a link outside the v1 scope"
    );
    const samples = apple.body();
    const backedUp = Object.fromEntries(V1_TABLES.map((table) => [table, rows(db, table)]));
    const { createBackup } = device.w.require("@/lib/backup-data");
    const { encryptBackupText } = device.w.require("@/lib/backup-crypto");
    const text = await encryptBackupText(
      JSON.stringify(createBackup()),
      PASSWORD,
      async (n) => new Uint8Array(randomBytes(n))
    );
    fs.mkdirSync(device.w.file("in"), { recursive: true });
    fs.writeFileSync(device.w.file("in", "macro-track-1.backup.json"), text);
    const file = new device.File(device.w.uri("in", "macro-track-1.backup.json"));

    // After the backup, every table the file holds changes: a food entry deleted and another edited, a new weight,
    // and a row in each of the others. So do things it does not hold: a new height and a changed setting.
    db.runSync("DELETE FROM food_entries WHERE id = 1");
    db.runSync("UPDATE food_entries SET amount = 250 WHERE id = 2");
    db.runSync(
      "INSERT INTO weight_entries (id, weight_kg, measured_at, created_at, updated_at) VALUES (5, 78.9, ?, 1, 1)",
      [morning(1)]
    );
    const rice = JSON.stringify(food("Brown rice", 220));
    const targets = JSON.stringify({ calories: 2100, protein: 150, carbs: 220, fat: 70 });
    for (const [sql, params] of [
      ["INSERT INTO custom_foods (id, name, food) VALUES ('custom:rice', 'Rice', ?)", [rice]],
      ["INSERT INTO saved_foods (id, food, saved_at) VALUES ('usda:brown-rice', ?, 1)", [rice]],
      ["INSERT INTO diary_days (day, status) VALUES (?, 'complete')", [daysAgo(1)]],
      [
        "INSERT INTO nutrition_targets (effective_day, targets) VALUES (?, ?)",
        [daysAgo(1), targets],
      ],
      ["INSERT INTO saved_meals (name, items, created_at) VALUES ('Lunch', '[]', 1)", []],
      [
        "INSERT INTO recipes (id, name, servings, ingredients, revision) VALUES ('r-1', 'Bowl', 2, '[]', 1)",
        [],
      ],
      [
        "INSERT INTO coaching_goals (id, mode, pace, started_day) VALUES (1, 'manual', 0, ?)",
        [daysAgo(1)],
      ],
      [
        "INSERT INTO check_ins (day, goal_id, decision, review, targets) VALUES (?, 1, 'kept', '{}', ?)",
        [daysAgo(1), targets],
      ],
    ])
      db.runSync(sql, params);
    db.runSync(
      "INSERT INTO measurements (id, kind, measured_at, \"values\", updated_at) VALUES (4, 'height', ?, ?, 2)",
      [morning(1), JSON.stringify({ height: 173 })]
    );
    db.runSync("INSERT INTO preferences (key, value) VALUES ('theme', 'dark')");
    await device.health.syncHealth();
    for (const table of V1_TABLES)
      assert.notDeepEqual(rows(db, table), backedUp[table], `${table} changed after the backup`);
    const otherLinks = links(db, "local_kind <> 'weight'");
    const measurements = measurementsOf(db);

    await assert.rejects(device.ops.runOpen(file), { code: "legacyPasswordRequired" });
    await restore(device, file, { password: PASSWORD });

    for (const table of V1_TABLES)
      assert.deepEqual(rows(db, table), backedUp[table], `${table}: the file's rows`);
    assert.deepEqual(
      db.getAllSync("SELECT id FROM weight_entries ORDER BY id").map((r) => r.id),
      [1, 2, 3, 4],
      "the backup's weights"
    );
    assert.deepEqual(
      links(db, "local_kind <> 'weight'"),
      otherLinks,
      "only weight links replaced: the imported height keeps its link"
    );
    assert.deepEqual(measurementsOf(db), measurements, "measurements kept");
    assert.equal(pref(db, "theme"), "dark", "preferences kept");
    assert.equal(pref(db, "installation"), "A");
    assert.equal(pref(db, "weightSyncEpoch"), "E");
    assert.deepEqual(JSON.parse(pref(db, "healthInstallations")), ["*", "A"]);
    assert.equal(pref(db, "settledDay"), daysAgo(1));
    assert.equal(pref(db, "healthSyncEnabled"), "false");

    await device.health.syncHealth();
    assert.deepEqual(
      apple.body(),
      [...samples, "macro-track:A:height:4"].sort(),
      "the same samples; the weight added after the backup is removed from Health again"
    );
    assert.equal(count(db, "weight_entries"), 4, "the imported reading stays linked, nothing new");
    assert.deepEqual(measurementsOf(db), measurements, "the imported height is not imported again");
    assert.deepEqual(
      links(db, "origin = 'health' AND local_kind = 'height'"),
      importedHeight,
      "its link survives the sync"
    );
    assert.deepEqual(apple.violations, []);
  }
);

test(
  "a weight or height this phone wrote to Health leaves its store when the restored row with that id is a Health import (another phone's archive, its v1 file)",
  { skip: vault.skip },
  async (t) => {
    // The old phone: a scale reading and a height from other apps, imported as weight 1 and measurement 1, and a
    // weight typed there (2), written under its installation O.
    const scale = healthKit("OLD");
    const old = await phone(t, "ios", { "@kingstinct/react-native-healthkit": scale.module });
    old.db.runSync("INSERT INTO preferences (key, value) VALUES ('installation', 'O')");
    scale.add("HKQuantityTypeIdentifierBodyMass", 90, morning(6));
    scale.add("HKQuantityTypeIdentifierHeight", 180, morning(6));
    await old.health.syncHealth();
    old.db.runSync(
      "INSERT INTO weight_entries (id, weight_kg, measured_at, created_at, updated_at) VALUES (2, 89, ?, 1, 1)",
      [morning(2)]
    );
    await old.health.syncHealth();
    assert.deepEqual(
      Object.entries(links(old.db)).map(([key, l]) => [key, l.local_id, l.origin]),
      [
        ["health:height:OLD-2", 1, "health"],
        ["health:weight:OLD-1", 1, "health"],
        ["macro-track:O:weight:2", 2, "local"],
      ]
    );

    /** A new phone with its own Health store, where weights 1 and 2 and a height were typed and written. */
    const newPhone = async (installation) => {
      const store = healthKit(installation);
      const device = await phone(t, "ios", { "@kingstinct/react-native-healthkit": store.module });
      device.db.runSync("INSERT INTO preferences (key, value) VALUES ('installation', ?)", [
        installation,
      ]);
      for (const [id, kg, at] of [
        [1, 70, morning(4)],
        [2, 71, morning(3)],
      ])
        device.db.runSync(
          "INSERT INTO weight_entries (id, weight_kg, measured_at, created_at, updated_at) VALUES (?, ?, ?, 1, 1)",
          [id, kg, at]
        );
      device.db.runSync(
        "INSERT INTO measurements (id, kind, measured_at, \"values\", updated_at) VALUES (1, 'height', ?, ?, 1)",
        [morning(4), JSON.stringify({ height: 172 })]
      );
      await device.health.syncHealth();
      const own = `macro-track:${installation}:`;
      assert.deepEqual(store.quantities(), {
        [`${own}weight:1`]: 70,
        [`${own}weight:2`]: 71,
        [`${own}height:1`]: 172,
      });
      return { ...device, store };
    };
    /** Health sync turned back on, twice: the second one changes nothing. */
    const reenable = async (device) => {
      await device.health.syncHealth();
      const settled = [device.store.versions(), links(device.db), weightsOf(device.db)];
      await device.health.syncHealth();
      assert.deepEqual(
        [device.store.versions(), links(device.db), weightsOf(device.db)],
        settled,
        "settled"
      );
      assert.deepEqual(device.store.violations, []);
    };

    // Another phone's archive: weights, measurements and their links are the old phone's. This phone's samples of
    // its own weights 1 and 2 and height 1 have no record left (1 is an import there, 2 the old phone's typed weight).
    const second = await newPhone("L");
    await restore(second, await carry(old, second));
    assert.deepEqual(weightsOf(second.db), [
      [1, 90],
      [2, 89],
    ]);
    assert.deepEqual(measurementsOf(second.db), [
      { id: 1, kind: "height", values: JSON.stringify({ height: 180 }) },
    ]);
    await reenable(second);
    assert.deepEqual(
      second.store.quantities(),
      { "macro-track:O:weight:2": 89 },
      "none of this phone's samples is left; the old phone's typed weight is written under its own key"
    );
    assert.equal(count(second.db, "weight_entries"), 2, "nothing comes back as a reading");
    assert.equal(count(second.db, "measurements"), 1);

    // The old phone's v1 file: weights and their import links come from the file; measurements stay as they are.
    const { createBackup } = old.w.require("@/lib/backup-data");
    const third = await newPhone("M");
    fs.mkdirSync(third.w.file("in"), { recursive: true });
    fs.writeFileSync(
      third.w.file("in", "macro-track-old.backup.json"),
      JSON.stringify(createBackup())
    );
    await restore(third, new third.File(third.w.uri("in", "macro-track-old.backup.json")));
    assert.deepEqual(weightsOf(third.db), [
      [1, 90],
      [2, 89],
    ]);
    await reenable(third);
    assert.deepEqual(
      third.store.quantities(),
      { "macro-track:M:height:1": 172, "macro-track:M:weight:2": 89 },
      "weight 1's sample is gone; weight 2 (no link in the file) replaces this phone's sample; the height stays"
    );
    assert.equal(count(third.db, "weight_entries"), 2, "nothing comes back as a reading");
  }
);

test(
  "sync removes this phone's sample of a weight or height whose row a restore left as a Health import, whatever link the restore kept",
  { skip: vault.skip },
  async (t) => {
    const apple = healthKit();
    const { db, health } = await phone(t, "ios", {
      "@kingstinct/react-native-healthkit": apple.module,
    });
    db.runSync("INSERT INTO preferences (key, value) VALUES ('installation', 'L')");
    db.runSync(
      "INSERT INTO weight_entries (id, weight_kg, measured_at, created_at, updated_at) VALUES (1, 70, ?, 1, 1)",
      [morning(4)]
    );
    db.runSync(
      "INSERT INTO measurements (id, kind, measured_at, \"values\", updated_at) VALUES (1, 'height', ?, ?, 1)",
      [morning(4), JSON.stringify({ height: 172 })]
    );
    await health.syncHealth();
    assert.deepEqual(apple.body(), ["macro-track:L:height:1", "macro-track:L:weight:1"]);

    // What a restore under vault 1.0.0 left (spec §5.4, M1 review): rows 1 are now readings imported from Health
    // (here also in this store), and this phone's own links still name them.
    const at = morning(6);
    const imports = [
      ["weight", apple.add("HKQuantityTypeIdentifierBodyMass", 90, at), 90],
      ["height", apple.add("HKQuantityTypeIdentifierHeight", 180, at), 180],
    ];
    db.runSync("UPDATE weight_entries SET weight_kg = 90, measured_at = ? WHERE id = 1", [at]);
    db.runSync('UPDATE measurements SET measured_at = ?, "values" = ? WHERE id = 1', [
      at,
      JSON.stringify({ height: 180 }),
    ]);
    for (const [kind, uuid, value] of imports)
      db.runSync(
        "INSERT INTO health_links (key, local_kind, local_id, remote_id, fingerprint, origin) VALUES (?, ?, 1, ?, ?, 'health')",
        [`health:${kind}:${uuid}`, kind, uuid, `${value}:${at}`]
      );
    const before = links(db, "origin = 'local'");
    assert.deepEqual(
      Object.values(before).map((l) => [l.local_id, l.fingerprint]),
      [
        [1, `172:${morning(4)}`],
        [1, `70:${morning(4)}`],
      ]
    );

    await health.syncHealth();
    assert.deepEqual(apple.body(), [], "this phone's samples are removed");
    assert.deepEqual(
      links(db, "origin = 'local'"),
      Object.fromEntries(
        Object.entries(before).map(([key, l]) => [key, { ...l, fingerprint: "deleted" }])
      ),
      "and their links kept as deletions"
    );
    assert.deepEqual(weightsOf(db), [[1, 90]], "the imports stay");
    assert.deepEqual(measurementsOf(db), [
      { id: 1, kind: "height", values: JSON.stringify({ height: 180 }) },
    ]);
    const settled = links(db);
    await health.syncHealth();
    assert.deepEqual(links(db), settled, "the next sync changes nothing");
    assert.deepEqual([apple.samples.size, count(db, "weight_entries")], [2, 1]);
    assert.deepEqual(apple.violations, []);
  }
);

// ---------------------------------------------------------------------------------------------------------------
// Health engine (spec §5.8)

test(
  "pauseWhenIdle waits for a running sync, holds new ones off, and gives up after its timeout",
  { skip: vault.skip },
  async (t) => {
    const { health } = await phone(t, "ios");
    const quiet = recorder().adapter;
    let open;
    const gate = new Promise((resolve) => (open = resolve));
    const running = health.syncHealth({ ...quiet, authorize: () => gate });
    let ran = false;
    await assert.rejects(
      health.pauseWhenIdle(async () => {
        ran = true;
      }, 300),
      /syncing/
    );
    assert.equal(ran, false, "nothing runs after a timeout");
    const paused = health.pauseWhenIdle(async () => {
      await assert.rejects(health.syncHealth(quiet), /syncing/);
      await assert.rejects(
        health.withHealthPaused(async () => {}),
        /Wait for health sync/
      );
      return "done";
    }, 5000);
    open(await quiet.authorize());
    await running;
    assert.equal(await paused, "done");
    await health.syncHealth(quiet);
  }
);

test(
  "imports skip every installation in the lineage and adopt a re-issued reading instead of duplicating it",
  { skip: vault.skip },
  async (t) => {
    const { db, health } = await phone(t, "ios");
    db.runSync(
      "INSERT INTO preferences (key, value) VALUES ('installation', 'C'), ('healthInstallations', '[\"B\"]')"
    );
    let samples = [
      {
        id: "own",
        kind: "weight",
        value: 81,
        measuredAt: morning(9),
        clientId: "macro-track:B:weight:7",
      },
      {
        id: "earlier",
        kind: "weight",
        value: 82,
        measuredAt: morning(8),
        clientId: "macro-track:Z:weight:1",
      },
      { id: "scale-1", kind: "weight", value: 80.4, measuredAt: morning(7) },
    ];
    const adapter = { ...recorder().adapter, read: async () => samples };
    await health.syncHealth(adapter);
    assert.deepEqual(
      db.getAllSync("SELECT weight_kg AS kg FROM weight_entries ORDER BY id").map((r) => r.kg),
      [82, 80.4],
      "an installation outside the lineage is an outside reading; B's sample is this app's own"
    );
    assert.deepEqual(JSON.parse(pref(db, "healthInstallations")), ["B", "C"]);
    const scale = links(db)["health:weight:scale-1"];

    // The other platform issues the same reading under a new id (its value converted back and forth).
    samples = [{ id: "scale-2", kind: "weight", value: 80.40000001, measuredAt: morning(7) }];
    await health.syncHealth(adapter);
    assert.equal(count(db, "weight_entries"), 2, "adopted, not imported again");
    assert.equal(links(db)["health:weight:scale-2"].local_id, scale.local_id);

    // Deleted here: a third copy of the reading stays deleted.
    db.runSync("DELETE FROM weight_entries WHERE id = ?", [scale.local_id]);
    samples = [{ id: "scale-3", kind: "weight", value: 80.4, measuredAt: morning(7) }];
    await health.syncHealth(adapter);
    assert.equal(count(db, "weight_entries"), 1);
  }
);

test(
  "the Health adapters delete by client id when a restore cleared the id, and treat an already deleted sample as done",
  { skip: vault.skip },
  async (t) => {
    const w = await vault.world({ platform: "ios" });
    t.after(() => w.close());
    const apple = healthKit();
    const ios = await w
      .load("src/lib/health-native.ios.ts", { "@kingstinct/react-native-healthkit": apple.module })
      .getHealthAdapter();
    await ios.authorize(false);
    const uuid = await ios.write({
      kind: "weight",
      value: 80,
      measuredAt: morning(1),
      clientId: "macro-track:A:weight:1",
      version: 1,
    });
    await ios.remove("weight", "", "macro-track:A:weight:1");
    assert.deepEqual(apple.body(), [], "removed by its sync identifier");
    await ios.remove("weight", uuid, "macro-track:A:weight:1");
    await ios.remove("weight", "", "macro-track:A:weight:1");
    await ios.remove("weight", "");
    apple.module.deleteObjects = async () => {
      throw new Error("Authorization not determined");
    };
    await assert.rejects(ios.remove("weight", "HK-9"), /Authorization not determined/);
    assert.deepEqual(apple.violations, []);

    const deleted = [];
    const android = await w
      .load("src/lib/health-native.android.ts", {
        "react-native-health-connect": {
          ...healthConnect().module,
          deleteRecordsByUuids: async (...args) => {
            deleted.push(args);
            if (args[1][0] === "gone") throw new Error("Record not found");
            if (args[1][0] === "locked") throw new Error("Rate limited");
          },
        },
      })
      .getHealthAdapter();
    await android.remove("weight", "", "macro-track:A:weight:1");
    await android.remove("weight", "gone");
    await android.remove("bodyFat", "");
    await assert.rejects(android.remove("height", "locked"), /Rate limited/);
    assert.deepEqual(deleted, [
      ["Weight", [], ["macro-track:A:weight:1"]],
      ["Weight", ["gone"], []],
      ["Height", ["locked"], []],
    ]);
  }
);

// ---------------------------------------------------------------------------------------------------------------
// Validators (spec §4.4)

test(
  "a check-in whose goal is missing is reported but restores; values the app cannot read are fatal",
  { skip: vault.skip },
  async (t) => {
    const source = await phone(t, "ios");
    library(source.db);
    const review = {
      method: 2,
      day: daysAgo(3),
      start: daysAgo(10),
      end: daysAgo(4),
      completeDays: 6,
      weightDays: 5,
      status: "ready",
      reason: "onTrack",
      intake: 2100,
      expenditure: 2500,
      weeklyKg: -0.4,
      desiredWeeklyKg: -0.5,
      proposed: null,
    };
    const targets = JSON.stringify({ calories: 2100, protein: 150, carbs: 220, fat: 70 });
    source.db.runSync(
      "INSERT INTO check_ins (day, goal_id, decision, review, targets) VALUES (?, 9, 'kept', ?, ?)",
      [daysAgo(3), JSON.stringify(review), targets]
    );
    assert.deepEqual(source.app.validate(source.db), [
      { table: "check_ins", fatal: false, message: "ref:goal_id" },
    ]);

    const target = await phone(t, "ios");
    await restore(target, await carry(source, target));
    assert.equal(count(target.db, "check_ins"), 1);

    target.db.runSync("UPDATE food_entries SET meal = 'Brunch' WHERE id = 1");
    target.db.runSync(
      "INSERT INTO saved_meals (name, items, created_at) VALUES ('Lunch', 'not json', 1)"
    );
    assert.deepEqual(
      target.app.validate(target.db).filter((issue) => issue.fatal),
      [
        { table: "saved_meals", fatal: true, message: "json:items" },
        { table: "food_entries", fatal: true, message: "value:meal" },
      ]
    );
  }
);
