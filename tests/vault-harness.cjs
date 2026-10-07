// Vector Vault test harness (synced, hash-checked; one file for all four repos; docs/vault.md §12). The generic
// tests in tests/vault/<area>.cjs run the vault's real TypeScript against the repo's real descriptor in Node:
//   - TypeScript is transpiled with the repo's own `typescript` (CommonJS, react-jsx) and run through a resolver:
//     stubs first; then `@/…` and relative paths (`.ios`/`.android`/`.native` files first, as Metro picks them);
//     `drizzle/migrations` built from the journal; a few pure-JS packages; anything else throws "no stub".
//   - expo-sqlite runs over node:sqlite with the device's behaviour: foreign keys off on open, whole numbers bound
//     as INTEGER, integers read back as (lossy) doubles, connections shared per path unless `useNewConnection`.
//     The real Drizzle expo driver and migrator run on top of it unchanged.
//   - expo-file-system runs over node:fs (with expo-file-system's own path utilities), the VectorVault native
//     module over node:crypto, and AbortController/AbortSignal are React Native's own abort-controller@3 plus
//     Expo's `timeout`/`any` statics: no `throwIfAborted()`, no `reason` (spec §0.2.13).
//
// Usage (tests/vault/<area>.cjs):
//   const vault = require("../vault-harness.cjs");
//   test("…", { skip: vault.skip }, async (t) => {
//     const w = await vault.world({ platform: "ios" });
//     t.after(() => w.close());
//     const db = await w.live();                       // the app's own connection, migrated
//     w.seed(db);                                      // tests/vault-fixture.cjs, current schema level
//     const { exportArchive } = w.require("@/vault/engine/export");
//   });
//
// The fixture (tests/vault-fixture.cjs, app-owned) is `{ levels, seed(db, { level, now, documentDirectory }),
// fresh?(db, { documentDirectory }), stubs }`. A stub is a module object, or a function called once per world with
// the world that returns the module (to record calls with `w.record(…)` or to load a real file with extra stubs).
const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { fileURLToPath, pathToFileURL } = require("node:url");
const vm = require("node:vm");

/** The repo root (tests/ is one level down). In vector-design/vault there is no package.json: nothing to run. */
const root = path.resolve(module.path, "..");
const inRepo = fs.existsSync(path.join(root, "package.json"));
const repoRequire = createRequire(path.join(root, "package.json"));
const src = path.join(root, "src");
const MIGRATIONS = path.join(root, "drizzle", "migrations");

function sqliteSupported() {
  try {
    const { DatabaseSync, StatementSync } = require("node:sqlite");
    const probe = new DatabaseSync(":memory:");
    const ok =
      typeof StatementSync.prototype.columns === "function" &&
      typeof StatementSync.prototype.setReturnArrays === "function" &&
      typeof probe.isTransaction === "boolean";
    probe.close();
    return ok;
  } catch {
    return false;
  }
}

/** `test(name, { skip: vault.skip }, …)`: false, or why the vault tests cannot run here. */
const skip = !inRepo
  ? "vault tests run inside an app repo (vector-design/vault has no node_modules; use `vault-kit try`)"
  : !sqliteSupported()
    ? "vault tests need Node ≥ 22.16"
    : false;

/** Bare packages loaded as they are (pure JS, installed in every repo). Everything else needs a stub. */
const PACKAGES = ["drizzle-orm", "fflate", "zod", "@noble/hashes", "@noble/ciphers", "typescript"];

const rel = (file) => path.relative(root, file) || ".";
const once = (make) => {
  let value;
  let made = false;
  return () => {
    if (!made) {
      value = make();
      made = true;
    }
    return value;
  };
};

// ---------------------------------------------------------------------------------------------------------------
// Journal and migrations (the shape of drizzle/migrations.js)

const journal = once(() =>
  JSON.parse(fs.readFileSync(path.join(root, "drizzle", "meta", "_journal.json"), "utf8"))
);
const migrationFiles = once(() =>
  Object.fromEntries(
    journal().entries.map((e) => [
      `m${String(e.idx).padStart(4, "0")}`,
      fs.readFileSync(path.join(root, "drizzle", `${e.tag}.sql`), "utf8"),
    ])
  )
);

/** `{ journal, migrations }` as drizzle/migrations.js exports it, the journal cut to its first `level` entries. */
function migrations(level = journal().entries.length) {
  const all = journal();
  if (!Number.isInteger(level) || level < 0 || level > all.entries.length)
    throw new Error(`vault harness: no schema level ${level} (journal has ${all.entries.length})`);
  return {
    journal: { ...all, entries: all.entries.slice(0, level) },
    migrations: { ...migrationFiles() },
  };
}

const fixture = once(() => require(path.join(root, "tests", "vault-fixture.cjs")));

// ---------------------------------------------------------------------------------------------------------------
// Transpiling and running TypeScript

const PARAMS = ["require", "module", "exports", "__filename", "__dirname", "__DEV__"];
const compiled = new Map();

/** The file as a function of PARAMS, transpiled once per content (cached across worlds). */
function compile(file) {
  const stat = fs.statSync(file);
  const hit = compiled.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.fn;
  const ts = repoRequire("typescript");
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    fileName: file,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  });
  const fn = vm.compileFunction(outputText, PARAMS, { filename: file });
  compiled.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, fn });
  return fn;
}

/** Drizzle's expo entry without query.cjs, which needs the real expo-sqlite and React (useLiveQuery). */
const drizzleExpo = once(() => {
  const dir = path.dirname(repoRequire.resolve("drizzle-orm/expo-sqlite"));
  return { ...require(path.join(dir, "session.cjs")), ...require(path.join(dir, "driver.cjs")) };
});

const EXTENSIONS = (platform) => [
  `.${platform}.ts`,
  `.${platform}.tsx`,
  ".native.ts",
  ".native.tsx",
  ".ts",
  ".tsx",
  ".js",
  ".json",
];
const isFile = (file) => fs.statSync(file, { throwIfNoEntry: false })?.isFile() ?? false;

function findFile(base, platform) {
  if (isFile(base)) return base;
  for (const ext of EXTENSIONS(platform)) if (isFile(base + ext)) return base + ext;
  for (const ext of EXTENSIONS(platform)) {
    const index = path.join(base, `index${ext}`);
    if (isFile(index)) return index;
  }
  return null;
}

/** The `@/…` names a src file answers to, so a stub applies however a module imports it ("./native", "@/vault/native"). */
function aliases(file) {
  if (!file.startsWith(src + path.sep)) return [];
  const bare = path
    .relative(src, file)
    .split(path.sep)
    .join("/")
    .replace(/\.(ts|tsx|js|json)$/, "");
  const names = [bare, bare.replace(/\.(ios|android|native)$/, "")];
  for (const name of [...names]) if (name.endsWith("/index")) names.push(name.slice(0, -6));
  return [...new Set(names)].map((n) => `@/${n}`);
}

class Scope {
  constructor(world, stubs) {
    this.world = world;
    this.stubs = stubs;
    this.modules = new Map();
    this.made = new Map();
  }

  stub(name) {
    if (!this.made.has(name)) {
      const value = this.stubs[name];
      this.made.set(name, typeof value === "function" ? value(this.world) : value);
    }
    return this.made.get(name);
  }

  require(specifier, from) {
    if (Object.hasOwn(this.stubs, specifier)) return this.stub(specifier);
    const base = specifier.startsWith("@/assets/")
      ? path.join(root, "assets", specifier.slice(9))
      : specifier.startsWith("@/")
        ? path.join(src, specifier.slice(2))
        : specifier.startsWith(".")
          ? path.resolve(path.dirname(from), specifier)
          : null;
    if (base) {
      if (base.replace(/\.js$/, "") === MIGRATIONS) return migrations();
      const file = findFile(base, this.world.platform);
      if (file) {
        const alias = aliases(file).find((a) => Object.hasOwn(this.stubs, a));
        return alias ? this.stub(alias) : this.load(file);
      }
    } else if (PACKAGES.some((p) => specifier === p || specifier.startsWith(`${p}/`))) {
      return specifier === "drizzle-orm/expo-sqlite"
        ? drizzleExpo()
        : createRequire(from)(specifier);
    }
    throw new Error(
      `vault harness: no stub for '${specifier}' imported from '${rel(from)}' — add it to tests/vault-fixture.cjs stubs`
    );
  }

  load(file) {
    const cached = this.modules.get(file);
    if (cached) return cached.exports;
    const module = { id: file, filename: file, exports: {}, loaded: false };
    this.modules.set(file, module);
    try {
      if (file.endsWith(".json")) module.exports = JSON.parse(fs.readFileSync(file, "utf8"));
      else
        compile(file).call(
          module.exports,
          (specifier) => this.require(specifier, file),
          module,
          module.exports,
          file,
          path.dirname(file),
          this.world.dev
        );
    } catch (error) {
      this.modules.delete(file);
      throw error;
    }
    module.loaded = true;
    return module.exports;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// expo-sqlite over node:sqlite

const DEVICE_INTEGER = 2 ** 63;

/** A JS value as expo-sqlite binds it: whole numbers as INTEGER, booleans as 0/1, undefined as NULL. */
function bindValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1n : 0n;
  if (typeof value === "number")
    return Number.isInteger(value) && Math.abs(value) < DEVICE_INTEGER ? BigInt(value) : value;
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError(`expo-sqlite cannot bind ${typeof value} values (got ${String(value)})`);
}

/** expo-sqlite's normalizeParams: variadic values, one array, one named object, or one value. */
function bindParams(params) {
  let bind = params.length > 1 ? params : params[0];
  if (bind == null) bind = [];
  if (typeof bind !== "object" || bind instanceof ArrayBuffer || ArrayBuffer.isView(bind))
    bind = [bind];
  if (Array.isArray(bind)) return { list: bind.map(bindValue) };
  return { named: Object.fromEntries(Object.entries(bind).map(([k, v]) => [k, bindValue(v)])) };
}

/** INTEGERs come back as JS numbers, lossy beyond 2^53 exactly like the device (node:sqlite would throw instead). */
const readValue = (value) => (typeof value === "bigint" ? Number(value) : value);

const CURSOR =
  "The SQLite cursor has been shifted and is unable to retrieve rows without being reset. Invoke `resetSync()` first.";

/** What executeSync()/executeAsync() return: an iterator of rows plus changes, lastInsertRowId and the getters. */
class ExecuteResult {
  #columns;
  #rows;
  #raw;
  #at = 0;
  #stepped = false;

  constructor(columns, rows, raw, run) {
    this.#columns = columns;
    this.#rows = rows;
    this.#raw = raw;
    this.lastInsertRowId = run.lastInsertRowId;
    this.changes = run.changes;
  }

  #row(values) {
    return this.#raw ? values : Object.fromEntries(this.#columns.map((c, i) => [c, values[i]]));
  }

  next() {
    this.#stepped = true;
    return this.#at < this.#rows.length
      ? { value: this.#row(this.#rows[this.#at++]), done: false }
      : { value: undefined, done: true };
  }

  [Symbol.iterator]() {
    return this;
  }

  async *[Symbol.asyncIterator]() {
    for (let step = this.next(); !step.done; step = this.next()) yield step.value;
  }

  getFirstSync() {
    if (this.#stepped) throw new Error(CURSOR);
    this.#stepped = true;
    return this.#rows.length ? this.#row(this.#rows[0]) : null;
  }

  getAllSync() {
    if (this.#stepped) throw new Error(CURSOR);
    this.#stepped = true;
    return this.#rows.map((values) => this.#row(values));
  }

  resetSync() {
    this.#at = 0;
    this.#stepped = false;
  }

  async getFirstAsync() {
    return this.getFirstSync();
  }

  async getAllAsync() {
    return this.getAllSync();
  }

  async resetAsync() {
    this.resetSync();
  }
}

/** One node:sqlite connection (expo's NativeDatabase), shared by every JS handle opened on it. */
class Connection {
  constructor(file) {
    const { DatabaseSync } = require("node:sqlite");
    // The device defaults: expo-sqlite compiles SQLite without SQLITE_DEFAULT_FOREIGN_KEYS or SQLITE_DQS=0.
    this.sqlite = new DatabaseSync(file, {
      enableForeignKeyConstraints: false,
      enableDoubleQuotedStringLiterals: true,
    });
    this.refs = 1;
    this.info = this.sqlite.prepare("SELECT changes() AS c, last_insert_rowid() AS r");
    this.info.setReadBigInts(true);
  }

  run() {
    const { c, r } = this.info.get();
    return { changes: Number(c), lastInsertRowId: Number(r) };
  }
}

class SQLiteStatement {
  #database;
  #source;
  #statement;
  #columns;
  #finalized = false;

  constructor(database, source) {
    this.#database = database;
    this.#source = source;
    this.#statement = database.connection().sqlite.prepare(source);
    this.#statement.setReadBigInts(true);
    this.#statement.setReturnArrays(true);
    this.#columns = this.#statement.columns().map((c) => c.name);
  }

  #execute(params, raw) {
    if (this.#finalized) throw new Error("Access to closed resource: the statement is finalized");
    const connection = this.#database.connection();
    this.#database.before(this.#source);
    const { list, named } = bindParams(params);
    const args = named ? [named] : list;
    if (!this.#columns.length) {
      const r = this.#statement.run(...args);
      const run = { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
      return new ExecuteResult(this.#columns, [], raw, run);
    }
    const rows = this.#statement.all(...args).map((row) => row.map(readValue));
    return new ExecuteResult(this.#columns, rows, raw, connection.run());
  }

  executeSync(...params) {
    return this.#execute(params, false);
  }

  executeForRawResultSync(...params) {
    return this.#execute(params, true);
  }

  async executeAsync(...params) {
    return this.#execute(params, false);
  }

  async executeForRawResultAsync(...params) {
    return this.#execute(params, true);
  }

  getColumnNamesSync() {
    return [...this.#columns];
  }

  async getColumnNamesAsync() {
    return this.getColumnNamesSync();
  }

  finalizeSync() {
    this.#finalized = true;
  }

  async finalizeAsync() {
    this.finalizeSync();
  }
}

/** expo-sqlite's SQLiteDatabase surface over a Connection. */
class SQLiteDatabase {
  #sqlite;
  #connection;
  #closed = false;

  constructor(sqlite, databasePath, options, connection) {
    this.#sqlite = sqlite;
    this.#connection = connection;
    this.databasePath = databasePath;
    this.options = options;
  }

  connection() {
    if (this.#closed) throw new Error(`Access to closed resource: ${this.databasePath}`);
    return this.#connection;
  }

  before(source) {
    this.#sqlite.before(this, source);
  }

  get closed() {
    return this.#closed;
  }

  execSync(source) {
    const connection = this.connection();
    this.before(source);
    connection.sqlite.exec(source);
  }

  async execAsync(source) {
    this.execSync(source);
  }

  prepareSync(source) {
    return new SQLiteStatement(this, source);
  }

  async prepareAsync(source) {
    return this.prepareSync(source);
  }

  #shorthand(source, params, read) {
    const statement = this.prepareSync(source);
    try {
      return read(statement.executeSync(...params));
    } finally {
      statement.finalizeSync();
    }
  }

  runSync(source, ...params) {
    return this.#shorthand(source, params, (r) => r);
  }

  getFirstSync(source, ...params) {
    return this.#shorthand(source, params, (r) => r.getFirstSync());
  }

  getAllSync(source, ...params) {
    return this.#shorthand(source, params, (r) => r.getAllSync());
  }

  *getEachSync(source, ...params) {
    yield* this.getAllSync(source, ...params);
  }

  async runAsync(source, ...params) {
    return this.runSync(source, ...params);
  }

  async getFirstAsync(source, ...params) {
    return this.getFirstSync(source, ...params);
  }

  async getAllAsync(source, ...params) {
    return this.getAllSync(source, ...params);
  }

  async *getEachAsync(source, ...params) {
    yield* this.getAllSync(source, ...params);
  }

  withTransactionSync(task) {
    try {
      this.execSync("BEGIN");
      task();
      this.execSync("COMMIT");
    } catch (error) {
      this.execSync("ROLLBACK");
      throw error;
    }
  }

  async withTransactionAsync(task) {
    try {
      this.execSync("BEGIN");
      await task();
      this.execSync("COMMIT");
    } catch (error) {
      this.execSync("ROLLBACK");
      throw error;
    }
  }

  /** As on the device: the task runs on a new connection of its own. */
  async withExclusiveTransactionAsync(task) {
    const txn = this.#sqlite.openPath(this.databasePath, {
      ...this.options,
      useNewConnection: true,
    });
    let failure;
    try {
      txn.execSync("BEGIN");
      await task(txn);
      txn.execSync("COMMIT");
    } catch (error) {
      txn.execSync("ROLLBACK");
      failure = error;
    } finally {
      txn.closeSync();
    }
    if (failure) throw failure;
  }

  isInTransactionSync() {
    return this.connection().sqlite.isTransaction;
  }

  async isInTransactionAsync() {
    return this.isInTransactionSync();
  }

  closeSync() {
    const connection = this.connection();
    this.#closed = true;
    this.#sqlite.release(this, connection);
  }

  async closeAsync() {
    this.closeSync();
  }
}

/** The `expo-sqlite` module of one world: databases default to <Documents>/SQLite, as on iOS. */
function sqliteModule(world) {
  const shared = new Map();
  const handles = new Set();
  let inHook = false;
  const local = (file) => (file.startsWith("file:") ? fileURLToPath(file) : file);
  const api = {
    get defaultDatabaseDirectory() {
      return world.paths.database;
    },
    openPath(databasePath, options = {}) {
      const file = local(databasePath);
      if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
      const key = `${file}\0${JSON.stringify(options)}`;
      const share = options.useNewConnection !== true && file !== ":memory:";
      let connection = share ? shared.get(key) : undefined;
      if (connection) connection.refs++;
      else {
        connection = new Connection(file);
        connection.key = share ? key : null;
        if (share) shared.set(key, connection);
      }
      const db = new SQLiteDatabase(api, databasePath, options, connection);
      handles.add(db);
      return db;
    },
    release(db, connection) {
      handles.delete(db);
      if (--connection.refs > 0) return;
      if (connection.key) shared.delete(connection.key);
      connection.sqlite.close();
    },
    /** World hooks that run before a BEGIN on any connection (G20 writes from a second connection there). */
    before(db, source) {
      if (inHook || !world.hooks.beforeBegin.size || !/^\s*BEGIN\b/i.test(source)) return;
      inHook = true;
      try {
        for (const hook of [...world.hooks.beforeBegin]) hook(db, source);
      } finally {
        inHook = false;
      }
    },
    handles,
  };
  const databasePath = (name, directory) =>
    name === ":memory:"
      ? name
      : `${(directory ?? world.paths.database).replace(/\/*$/, "")}/${name.replace(/^\/+/, "")}`;
  function deleteDatabase(target) {
    const file = local(target);
    if ([...handles].some((db) => local(db.databasePath) === file))
      throw new Error(`Unable to delete '${file}': the database is open`);
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      fs.rmSync(file + suffix, { force: true });
  }
  const reactOnly = (name) => () => {
    throw new Error(`vault harness: ${name} renders React; it cannot run in Node`);
  };
  return {
    api,
    module: {
      get defaultDatabaseDirectory() {
        return world.paths.database;
      },
      openDatabaseSync: (name, options, directory) =>
        api.openPath(databasePath(name, directory), options ?? {}),
      openDatabaseAsync: async (name, options, directory) =>
        api.openPath(databasePath(name, directory), options ?? {}),
      deleteDatabaseSync: (name, directory) => deleteDatabase(databasePath(name, directory)),
      deleteDatabaseAsync: async (name, directory) => deleteDatabase(databasePath(name, directory)),
      /** No change events in Node; a test that needs them drives the listener itself. */
      addDatabaseChangeListener: () => ({ remove() {} }),
      SQLiteProvider: reactOnly("SQLiteProvider"),
      useSQLiteContext: reactOnly("useSQLiteContext"),
      SQLiteDatabase,
      SQLiteStatement,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// expo-file-system over node:fs

const pathUtilities = once(() => {
  const pkg = path.dirname(repoRequire.resolve("expo-file-system/package.json"));
  const scope = new Scope({ platform: "ios", dev: true }, {});
  return scope.load(path.join(pkg, "src", "pathUtilities", "index.ts")).PathUtilities;
});

const FileMode = { ReadWrite: "rw", ReadOnly: "r", WriteOnly: "w", Append: "wa", Truncate: "wt" };
const EncodingType = { UTF8: "utf8", Base64: "base64" };
const MIME = {
  csv: "text/csv",
  db: "application/vnd.sqlite3",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  png: "image/png",
  txt: "text/plain",
  zip: "application/zip",
};

function fileSystemModule(world) {
  const { Buffer } = require("node:buffer");
  const PathUtilities = pathUtilities();
  const local = (uri) => {
    if (!uri.startsWith("file:"))
      throw new Error(`vault harness: only file:// URIs exist in Node (got ${uri})`);
    return fileURLToPath(uri);
  };
  const stat = (file) => fs.statSync(file, { throwIfNoEntry: false });
  const exists = (file) => !!stat(file);
  const bytes = (data) => new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

  /** Where a copy or move lands: into a destination directory, onto a destination file (expo's rule). */
  function target(source, destination, options) {
    const into = destination instanceof Directory;
    let to;
    if (into)
      to =
        source instanceof File || exists(local(destination.uri))
          ? path.join(local(destination.uri), source.name)
          : local(destination.uri);
    else if (source instanceof Directory)
      throw new Error("Unable to copy or move a directory onto a file");
    else to = local(destination.uri);
    if (exists(to)) {
      if (!options?.overwrite) throw new Error(`Destination '${to}' already exists`);
      fs.rmSync(to, { recursive: true, force: true });
    }
    return to;
  }

  class FileHandle {
    #fd;
    #mode;
    #offset = 0;

    constructor(file, mode) {
      this.#mode = mode;
      this.#fd = fs.openSync(file, mode === "r" ? "r" : "r+");
      if (mode === "wa") this.#offset = fs.fstatSync(this.#fd).size;
      if (mode === "wt") fs.ftruncateSync(this.#fd, 0);
    }

    readBytes(length) {
      if (this.#mode !== "r" && this.#mode !== "rw")
        throw new Error("Unable to read from the handle: opened write-only");
      const buffer = new Uint8Array(length);
      const read = fs.readSync(this.#fd, buffer, 0, length, this.#offset);
      this.#offset += read;
      return read === length ? buffer : buffer.slice(0, read);
    }

    writeBytes(data) {
      if (this.#mode === "r") throw new Error("Unable to write to the handle: opened read-only");
      this.#offset += fs.writeSync(this.#fd, data, 0, data.byteLength, this.#offset);
    }

    get offset() {
      return this.#fd === null ? null : this.#offset;
    }

    set offset(value) {
      if (value != null) this.#offset = value;
    }

    get size() {
      return this.#fd === null ? null : fs.fstatSync(this.#fd).size;
    }

    close() {
      if (this.#fd !== null) fs.closeSync(this.#fd);
      this.#fd = null;
    }
  }

  class File {
    constructor(...uris) {
      this.uri = PathUtilities.join(...uris);
      this.validatePath();
    }

    validatePath() {
      if (!this.uri.startsWith("file:") || this.uri.endsWith("/"))
        throw new Error(
          `Invalid file path '${this.uri}': a file needs a file:// URI without a trailing slash`
        );
    }

    get name() {
      return PathUtilities.basename(this.uri);
    }

    get extension() {
      return PathUtilities.extname(this.uri);
    }

    get parentDirectory() {
      return new Directory(PathUtilities.dirname(this.uri));
    }

    get exists() {
      return stat(local(this.uri))?.isFile() ?? false;
    }

    get size() {
      const s = stat(local(this.uri));
      if (!s?.isFile()) throw new Error(`File '${this.uri}' does not exist`);
      return s.size;
    }

    get md5() {
      return this.exists
        ? createHash("md5")
            .update(fs.readFileSync(local(this.uri)))
            .digest("hex")
        : null;
    }

    get modificationTime() {
      const s = stat(local(this.uri));
      return s ? Math.trunc(s.mtimeMs) : null;
    }

    get lastModified() {
      return this.modificationTime;
    }

    get creationTime() {
      const s = stat(local(this.uri));
      return s ? Math.trunc(s.birthtimeMs) : null;
    }

    get type() {
      return MIME[this.extension.slice(1).toLowerCase()] ?? "application/octet-stream";
    }

    get contentUri() {
      return this.uri;
    }

    info(options) {
      const s = stat(local(this.uri));
      if (!s?.isFile()) return { exists: false, uri: this.uri };
      return {
        exists: true,
        uri: this.uri,
        size: s.size,
        modificationTime: Math.trunc(s.mtimeMs),
        creationTime: Math.trunc(s.birthtimeMs),
        ...(options?.md5 ? { md5: this.md5 } : {}),
      };
    }

    create(options) {
      const file = local(this.uri);
      if (exists(file) && !options?.overwrite) throw new Error(`File '${this.uri}' already exists`);
      if (options?.intermediates) fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.rmSync(file, { force: true });
      fs.writeFileSync(file, new Uint8Array(0));
    }

    write(content, options) {
      const data =
        typeof content === "string"
          ? options?.encoding === "base64"
            ? Buffer.from(content, "base64")
            : content
          : content;
      if (options?.append) fs.appendFileSync(local(this.uri), data);
      else fs.writeFileSync(local(this.uri), data);
    }

    textSync() {
      return fs.readFileSync(local(this.uri), "utf8");
    }

    async text() {
      return this.textSync();
    }

    bytesSync() {
      return bytes(fs.readFileSync(local(this.uri)));
    }

    async bytes() {
      return this.bytesSync();
    }

    base64Sync() {
      return fs.readFileSync(local(this.uri)).toString("base64");
    }

    async base64() {
      return this.base64Sync();
    }

    async arrayBuffer() {
      return this.bytesSync().slice().buffer;
    }

    async json() {
      return JSON.parse(this.textSync());
    }

    delete() {
      const file = local(this.uri);
      if (!exists(file)) throw new Error(`Unable to delete '${this.uri}': path does not exist`);
      fs.rmSync(file);
    }

    copySync(destination, options) {
      fs.copyFileSync(local(this.uri), target(this, destination, options));
    }

    async copy(destination, options) {
      this.copySync(destination, options);
    }

    moveSync(destination, options) {
      const to = target(this, destination, options);
      fs.renameSync(local(this.uri), to);
      this.uri = pathToFileURL(to).href;
    }

    async move(destination, options) {
      this.moveSync(destination, options);
    }

    rename(newName) {
      const to = path.join(path.dirname(local(this.uri)), newName);
      fs.renameSync(local(this.uri), to);
      this.uri = pathToFileURL(to).href;
    }

    open(mode = FileMode.ReadWrite) {
      return new FileHandle(local(this.uri), mode);
    }

    static async pickFileAsync() {
      const picked = world.picked.file;
      return picked
        ? { result: new File(pathToFileURL(picked).href), canceled: false }
        : { result: null, canceled: true };
    }
  }

  class Directory {
    constructor(...uris) {
      const uri = PathUtilities.join(...uris);
      this.uri = uri.endsWith("/") ? uri : `${uri}/`;
      this.validatePath();
    }

    validatePath() {
      if (!this.uri.startsWith("file:"))
        throw new Error(`Invalid directory path '${this.uri}': a directory needs a file:// URI`);
    }

    get name() {
      return PathUtilities.basename(this.uri);
    }

    get parentDirectory() {
      return new Directory(PathUtilities.join(this.uri, ".."));
    }

    get exists() {
      return stat(local(this.uri))?.isDirectory() ?? false;
    }

    get size() {
      const walk = (dir) =>
        fs
          .readdirSync(dir, { withFileTypes: true })
          .reduce(
            (sum, e) =>
              sum +
              (e.isDirectory()
                ? walk(path.join(dir, e.name))
                : fs.statSync(path.join(dir, e.name)).size),
            0
          );
      if (!this.exists) throw new Error(`Directory '${this.uri}' does not exist`);
      return walk(local(this.uri));
    }

    info() {
      if (!this.exists) return { exists: false, uri: this.uri };
      const s = fs.statSync(local(this.uri));
      return {
        exists: true,
        uri: this.uri,
        size: this.size,
        files: fs.readdirSync(local(this.uri)).sort(),
        modificationTime: Math.trunc(s.mtimeMs),
        creationTime: Math.trunc(s.birthtimeMs),
      };
    }

    create(options) {
      const dir = local(this.uri);
      if (exists(dir)) {
        if (options?.idempotent) return;
        if (!options?.overwrite) throw new Error(`Directory '${this.uri}' already exists`);
        fs.rmSync(dir, { recursive: true, force: true });
      }
      fs.mkdirSync(dir, { recursive: !!options?.intermediates });
    }

    delete() {
      const dir = local(this.uri);
      if (!exists(dir)) throw new Error(`Unable to delete '${this.uri}': path does not exist`);
      fs.rmSync(dir, { recursive: true, force: true });
    }

    listAsRecords() {
      return fs
        .readdirSync(local(this.uri), { withFileTypes: true })
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((e) => ({
          isDirectory: e.isDirectory(),
          uri:
            pathToFileURL(path.join(local(this.uri), e.name)).href + (e.isDirectory() ? "/" : ""),
        }));
    }

    list() {
      return this.listAsRecords().map(({ isDirectory, uri }) =>
        isDirectory ? new Directory(uri) : new File(uri)
      );
    }

    createFile(name) {
      const file = new File(this, name);
      file.create();
      return file;
    }

    createDirectory(name) {
      const dir = new Directory(this, name);
      dir.create();
      return dir;
    }

    copySync(destination, options) {
      fs.cpSync(local(this.uri), target(this, destination, options), { recursive: true });
    }

    async copy(destination, options) {
      this.copySync(destination, options);
    }

    moveSync(destination, options) {
      const to = target(this, destination, options);
      fs.renameSync(local(this.uri), to);
      this.uri = `${pathToFileURL(to).href}/`;
    }

    async move(destination, options) {
      this.moveSync(destination, options);
    }

    rename(newName) {
      const to = path.join(path.dirname(local(this.uri)), newName);
      fs.renameSync(local(this.uri), to);
      this.uri = `${pathToFileURL(to).href}/`;
    }

    static async pickDirectoryAsync() {
      const dir = world.picked.directory ?? path.join(world.dir, "Picked");
      fs.mkdirSync(dir, { recursive: true });
      return new Directory(pathToFileURL(dir).href);
    }
  }

  class Paths extends PathUtilities {
    static get document() {
      return new Directory(pathToFileURL(world.paths.document).href);
    }

    static get cache() {
      return new Directory(pathToFileURL(world.paths.cache).href);
    }

    static get bundle() {
      return new Directory(pathToFileURL(world.paths.bundle).href);
    }

    static get appleSharedContainers() {
      return {};
    }

    static get availableDiskSpace() {
      return world.disk.available;
    }

    static get totalDiskSpace() {
      return world.disk.total;
    }

    static info(...uris) {
      const s = stat(local(uris.join("/")));
      return { exists: !!s, isDirectory: s ? s.isDirectory() : null };
    }
  }

  return { File, Directory, Paths, FileMode, EncodingType };
}

// ---------------------------------------------------------------------------------------------------------------
// The VectorVault native module (src/vault/native.ts reads it through `expo`)

function nativeModule(world) {
  const listeners = new Map();
  const local = (uri) => (uri.startsWith("file:") ? fileURLToPath(uri) : uri);
  return {
    async hashFile(uri) {
      const hash = createHash("sha256");
      const fd = fs.openSync(local(uri), "r");
      const chunk = new Uint8Array(1024 * 1024);
      try {
        for (let read; (read = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0;)
          hash.update(chunk.subarray(0, read));
      } finally {
        fs.closeSync(fd);
      }
      return hash.digest("hex");
    },
    hashText: (text) => createHash("sha256").update(text, "utf8").digest("hex"),
    randomUUID: () => randomUUID(),
    deviceInfo: async () => ({ ...world.device }),
    config: () => ({ ...world.config }),
    networkInfo: async () => ({ ...world.network }),
    setExcludedFromBackup(uri, excluded) {
      world.excluded.set(uri, excluded);
    },
    googleConfigured: () =>
      world.platform === "ios" ? world.config.googleIos : world.config.googleAndroid,
    googleGetToken: async () => null,
    async googleConnect() {
      throw new Error("googleCancelled");
    },
    async googleClearToken() {},
    async googleDisconnect() {},
    addListener(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(listener);
      return { remove: () => listeners.get(event)?.delete(listener) };
    },
    /** Test-only: deliver a native event to the listeners. */
    emit(event, payload) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(payload);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// React Native's AbortController/AbortSignal (abort-controller@3.0.0) with Expo's statics (§0.2.13)

const deviceAbort = once(() => {
  const rn = path.dirname(repoRequire.resolve("react-native/package.json"));
  const { AbortController, AbortSignal } = require(
    createRequire(path.join(rn, "package.json")).resolve("abort-controller/dist/abort-controller")
  );
  const expo = path.dirname(repoRequire.resolve("expo/package.json"));
  const patch = new Scope({ platform: "ios", dev: true }, {}).load(
    path.join(expo, "src", "winter", "AbortSignal.ts")
  );
  patch.installAbortSignalPatch(AbortSignal);
  return { AbortController, AbortSignal };
});

let abortUsers = 0;
let nodeAbort = null;

function installDeviceAbort() {
  const device = deviceAbort();
  if (abortUsers++ === 0) {
    nodeAbort = {
      AbortController: globalThis.AbortController,
      AbortSignal: globalThis.AbortSignal,
    };
    globalThis.AbortController = device.AbortController;
    globalThis.AbortSignal = device.AbortSignal;
  }
}

function restoreNodeAbort() {
  if (--abortUsers === 0) {
    globalThis.AbortController = nodeAbort.AbortController;
    globalThis.AbortSignal = nodeAbort.AbortSignal;
    nodeAbort = null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Built-in stubs: Expo and React Native modules the vault (or a descriptor's lazy imports) reach

function builtins(world) {
  const sqlite = once(() => sqliteModule(world));
  world.sqlite = () => sqlite().api;
  const fileSystem = once(() => fileSystemModule(world));
  const native = once(() => nativeModule(world));
  world.nativeModule = native;
  const expo = () => ({
    requireOptionalNativeModule: (name) => (name === "VectorVault" ? native() : null),
    requireNativeModule(name) {
      if (name === "VectorVault") return native();
      throw new Error(`Cannot find native module '${name}' (vault harness)`);
    },
  });
  const appState = world.appStateListeners;
  const router = world.record("expo-router", {
    push() {},
    replace() {},
    navigate() {},
    back() {},
    dismiss() {},
    dismissAll() {},
    dismissTo() {},
    setParams() {},
    canGoBack: () => false,
  });
  const tasks = world.tasks;
  return {
    "expo-sqlite": () => sqlite().module,
    "expo-file-system": () => fileSystem(),
    expo,
    "expo-modules-core": expo,
    "react-native": () => ({
      Platform: {
        get OS() {
          return world.platform;
        },
        get Version() {
          return world.device.osVersion;
        },
        select: (spec) => spec[world.platform] ?? spec.native ?? spec.default,
      },
      AppState: {
        get currentState() {
          return world.appState;
        },
        addEventListener(type, listener) {
          const entry = { type, listener };
          appState.add(entry);
          return { remove: () => appState.delete(entry) };
        },
      },
      BackHandler: world.record("react-native.BackHandler", {
        addEventListener: () => ({ remove() {} }),
        exitApp() {},
      }),
      Alert: world.record("react-native.Alert", { alert() {} }),
    }),
    "expo-constants": () => ({
      expoConfig: { name: "vault-harness", slug: "vault-harness", version: "1.0.0", extra: {} },
      appOwnership: null,
      executionEnvironment: "bare",
    }),
    "expo-localization": () => ({
      getLocales: () => [{ ...world.locale }],
      getCalendars: () => [
        { calendar: "gregory", timeZone: world.timeZone, uses24hourClock: true, firstWeekday: 2 },
      ],
      useLocales: () => [{ ...world.locale }],
    }),
    "expo-sharing": () =>
      world.record("expo-sharing", {
        isAvailableAsync: async () => true,
        shareAsync: async () => {},
      }),
    "expo-router": () => ({ router, useRouter: () => router, useLocalSearchParams: () => ({}) }),
    "expo-task-manager": () =>
      world.record("expo-task-manager", {
        defineTask: (name, task) => void tasks.defined.set(name, task),
        isTaskDefined: (name) => tasks.defined.has(name),
        isTaskRegisteredAsync: async (name) => tasks.registered.has(name),
        getRegisteredTasksAsync: async () =>
          [...tasks.registered].map(([taskName, options]) => ({ taskName, options })),
        unregisterTaskAsync: async (name) => void tasks.registered.delete(name),
        unregisterAllTasksAsync: async () => tasks.registered.clear(),
      }),
    "expo-background-task": () => ({
      BackgroundTaskStatus: { Restricted: 1, Available: 2 },
      BackgroundTaskResult: { Success: 1, Failed: 2 },
      ...world.record("expo-background-task", {
        getStatusAsync: async () => 2,
        registerTaskAsync: async (name, options) => void tasks.registered.set(name, options ?? {}),
        unregisterTaskAsync: async (name) => void tasks.registered.delete(name),
        triggerTaskWorkerForTestingAsync: async () => {
          for (const name of tasks.registered.keys()) await world.runTask(name);
          return true;
        },
      }),
    }),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Worlds: one temporary app sandbox per test

let worlds = 0;
const REPO_PATH = /^(\.{1,2}\/|\/|(src|tests|drizzle|modules)\/)/;

class World {
  #scope;
  #live = null;
  #closed = false;

  constructor(options) {
    this.id = ++worlds;
    this.platform = options.platform ?? "ios";
    this.dev = options.dev ?? true;
    this.dir = fs.mkdtempSync(path.join(options.tmp ?? os.tmpdir(), "vault-world-"));
    this.keep = !!options.keep;
    const document = path.join(this.dir, "Documents");
    this.paths = {
      document,
      cache: path.join(this.dir, "Caches"),
      bundle: path.join(this.dir, "Bundle"),
      database: path.join(document, "SQLite"),
    };
    for (const dir of Object.values(this.paths)) fs.mkdirSync(dir, { recursive: true });
    const fingerprint = createHash("sha256").update(`${this.dir}:${this.platform}`).digest("hex");
    /** deviceInfo() of the native module; tests change members (fingerprint: null, kind: "tablet", …). */
    this.device = {
      platform: this.platform,
      kind: "phone",
      model: this.platform === "ios" ? "iPhone" : "Pixel 9",
      osVersion: this.platform === "ios" ? "26.1" : "16",
      appVersion: "1.0.0",
      appBuild: "1",
      fingerprint: fingerprint.slice(0, 32),
      ...options.device,
    };
    /** config() of the native module: the build flags. */
    this.config = {
      icloud: false,
      googleIos: false,
      googleAndroid: false,
      selftest: false,
      ...options.config,
    };
    this.network = { connected: true, expensive: false, ...options.network };
    this.disk = { available: 64 * 2 ** 30, total: 128 * 2 ** 30, ...options.disk };
    this.locale = {
      languageCode: "en",
      languageTag: "en-US",
      regionCode: "US",
      measurementSystem: "metric",
      textDirection: "ltr",
      ...options.locale,
    };
    this.timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.appState = "active";
    this.appStateListeners = new Set();
    /** Files and folders the pickers return (absolute paths); null: the picker is cancelled. */
    this.picked = { file: null, directory: null, ...options.picked };
    /** setExcludedFromBackup(uri, excluded) calls, by uri. */
    this.excluded = new Map();
    /** Every call to a recorded stub: { module, name, args }. */
    this.calls = [];
    this.tasks = { defined: new Map(), registered: new Map() };
    this.hooks = { beforeBegin: new Set() };
    installDeviceAbort();
    let stubs;
    try {
      stubs = { ...builtins(this), ...fixture().stubs, ...options.stubs };
    } catch (error) {
      restoreNodeAbort();
      throw error;
    }
    this.#scope = new Scope(this, stubs);
  }

  /** A module of this world: `@/…`, a stubbed or allowed package, or a repo-relative file ("src/…", "./…"). */
  require(specifier) {
    if (!REPO_PATH.test(specifier))
      return this.#scope.require(specifier, path.join(src, "index.ts"));
    const file = findFile(path.resolve(root, specifier), this.platform);
    if (!file) throw new Error(`vault harness: no file '${specifier}' in ${root}`);
    return this.#scope.load(file);
  }

  /** A repo file loaded with extra stubs in a scope of its own (its imports are loaded afresh there). */
  load(file, stubs = {}) {
    return new Scope(this, { ...this.#scope.stubs, ...stubs }).load(path.resolve(root, file));
  }

  /** The app's descriptor through src/vault/app.ts, as the engine sees it. */
  get vaultApp() {
    return this.require("@/vault/app").vaultApp;
  }

  /** Functions that record each call in `calls` before running: `w.record("@/lib/health", { … })`. */
  record(module, functions) {
    return Object.fromEntries(
      Object.entries(functions).map(([name, fn]) => [
        name,
        (...args) => {
          this.calls.push({ module, name, args });
          return fn(...args);
        },
      ])
    );
  }

  /** The calls recorded for one module (and optionally one function). */
  called(module, name) {
    return this.calls.filter((c) => c.module === module && (name === undefined || c.name === name));
  }

  /** An expo-sqlite connection of this world (directory: <Documents>/SQLite unless given). */
  open(name, options = {}, directory) {
    return this.require("expo-sqlite").openDatabaseSync(name, options, directory);
  }

  /** Runs Drizzle's real migrator on `db` up to `level` (default: the current journal length). */
  async migrate(db, level = journal().entries.length) {
    const { migrate } = repoRequire("drizzle-orm/expo-sqlite/migrator");
    await migrate(drizzleExpo().drizzle(db), migrations(level));
    return db;
  }

  /**
   * The app's own connection, migrated as the app's root layout does before the vault starts: body/lift/macro the
   * real `expoDb` of src/db/index.ts; water a connection with the change listener and the real
   * `initializeDatabase` (at an older level: migrations only). Opened once per world.
   */
  async live({ level = journal().entries.length } = {}) {
    if (this.#live) return this.#live;
    if (findFile(path.join(src, "db", "index"), this.platform)) {
      const { expoDb } = this.require("@/db");
      this.#live = await this.migrate(expoDb, level);
    } else {
      const db = this.open(this.vaultApp.database.name, { enableChangeListener: true });
      if (level === journal().entries.length)
        await this.require("@/db/provider").initializeDatabase(db);
      else await this.migrate(db, level);
      this.#live = db;
    }
    return this.#live;
  }

  /** tests/vault-fixture.cjs `seed` on `db` at `level`, with this world's document folder for media files. */
  seed(db, { level = journal().entries.length, now = new Date() } = {}) {
    fixture().seed(db, { level, now, documentDirectory: this.paths.document });
    return db;
  }

  /** tests/vault-fixture.cjs `fresh`: what the app writes by itself before the user records anything. */
  fresh(db) {
    fixture().fresh?.(db, { documentDirectory: this.paths.document });
    return db;
  }

  /** An absolute path under the document folder (Paths.document). */
  file(...segments) {
    return path.join(this.paths.document, ...segments);
  }

  /** A file:// URI under the document folder, as `new File(Paths.document, …).uri` has it. */
  uri(...segments) {
    return pathToFileURL(this.file(...segments)).href;
  }

  /** Runs `hook(db, sql)` before every BEGIN on any connection of this world; returns the remover. */
  onBeforeBegin(hook) {
    this.hooks.beforeBegin.add(hook);
    return () => this.hooks.beforeBegin.delete(hook);
  }

  /** Moves the fake AppState and tells its listeners. */
  setAppState(state) {
    this.appState = state;
    for (const { type, listener } of [...this.appStateListeners])
      if (type === "change") listener(state);
  }

  /** Runs a task defined with expo-task-manager (as the background worker would). */
  async runTask(name) {
    const task = this.tasks.defined.get(name);
    if (!task) throw new Error(`vault harness: no task '${name}' is defined`);
    return task({ data: null, error: null, executionInfo: { taskName: name } });
  }

  /** The VectorVault native fake (mutable: tests add M2 members or replace functions). */
  get native() {
    return this.nativeModule();
  }

  /** Open expo-sqlite handles of this world. */
  connections() {
    return this.sqlite ? [...this.sqlite().handles] : [];
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    try {
      for (const db of this.connections()) if (!db.closed) db.closeSync();
    } finally {
      restoreNodeAbort();
      if (!this.keep) fs.rmSync(this.dir, { recursive: true, force: true });
    }
  }
}

/** A new world (temporary Documents/Caches/SQLite folders, fresh module scope, device-shaped AbortSignal). */
async function world(options = {}) {
  if (skip) throw new Error(`vault harness: ${skip}`);
  return new World(options);
}

module.exports = {
  root,
  skip,
  PACKAGES,
  journal,
  migrations,
  fixture,
  world,
  get level() {
    return journal().entries.length;
  },
  /** React Native's classes, for building device-shaped signals outside a world. */
  get AbortController() {
    return deviceAbort().AbortController;
  },
  get AbortSignal() {
    return deviceAbort().AbortSignal;
  },
};
