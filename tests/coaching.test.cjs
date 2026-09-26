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

function load(file, dependencies = {}) {
  const output = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
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
