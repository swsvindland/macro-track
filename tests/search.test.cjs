const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const ts = require("typescript");

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
const nutrition = load("src/lib/nutrition.ts");
const rank = load("src/lib/food-rank.ts");

const manifest = JSON.parse(readFileSync("assets/food/manifest.json", "utf8"));
const assets = { 1: "assets/food/usda.db", 2: "assets/food/off.db" };
const clone = (from, to) => copyFileSync(from, to, constants.COPYFILE_FICLONE);
let reads = 0;
/**
 * A phone in a temporary folder: its Documents and cache folders for expo-file-system, and real
 * SQLite for expo-sqlite, which takes plain paths. Each launch loads the production catalog
 * module afresh; `copy` stands in for the native asset copy, and `free` for the free space.
 */
function phone() {
  const root = mkdtempSync(path.join(tmpdir(), "macro-track-catalog-"));
  const local = (uri) => decodeURIComponent(uri.replace(/^file:\/\//, ""));
  class Directory {
    constructor(parent, name) {
      this.uri = `${parent.uri}/${name}`;
    }
    get exists() {
      return existsSync(local(this.uri));
    }
    create({ intermediates = false, idempotent = false } = {}) {
      if (!(idempotent && this.exists)) mkdirSync(local(this.uri), { recursive: intermediates });
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
    get size() {
      return this.exists ? statSync(local(this.uri)).size : 0;
    }
    delete() {
      rmSync(local(this.uri));
    }
    moveSync(destination, { overwrite = false } = {}) {
      if (!overwrite && destination.exists) throw new Error("Destination already exists");
      renameSync(local(this.uri), local(destination.uri));
      this.uri = destination.uri;
    }
  }
  const home = { uri: `file://${root}` };
  const document = new Directory(home, "Documents");
  const cache = new Directory(home, "Caches");
  const folders = {
    catalogs: path.join(root, "Caches", "catalogs"),
    legacy: path.join(root, "Documents", "SQLite"),
  };
  Object.values(folders).forEach((folder) => mkdirSync(folder, { recursive: true }));
  const files = (folder) => readdirSync(folder).sort();
  const imports = [];
  const launch = ({ copy = clone, android = false, free = Infinity } = {}) =>
    load("src/lib/food-catalog.ts", {
      "expo-file-system": { Directory, File, Paths: { document, cache, availableDiskSpace: free } },
      "react-native": { Platform: { OS: android ? "android" : "ios" } },
      "expo-sqlite": {
        importDatabaseFromAssetAsync: async (name, { assetId, forceOverwrite }, directory) => {
          const target = path.join(directory, name);
          if (existsSync(target) && !forceOverwrite) return;
          imports.push(name);
          mkdirSync(directory, { recursive: true });
          await copy(assets[assetId], target);
        },
        // Like the native module, opening a missing file creates an empty database.
        openDatabaseAsync: async (name, options, directory) => {
          const database = new DatabaseSync(path.join(directory, name));
          return {
            getAllAsync: async (sql, ...params) => {
              reads++;
              return database.prepare(sql).all(...params);
            },
            getFirstAsync: async (sql, ...params) => database.prepare(sql).get(...params),
            execAsync: async (sql) => database.exec(sql),
            closeAsync: async () => database.close(),
          };
        },
      },
      "../../assets/food/manifest.json": manifest,
      "../../assets/food/usda.db": 1,
      "../../assets/food/off.db": 2,
      "./nutrition": nutrition,
      "./food-rank": rank,
    });
  return { root, folders, files, imports, launch };
}
const device = phone();
after(() => rmSync(device.root, { recursive: true, force: true }));
const catalog = device.launch();
const installed = [`${manifest.off.version}.db`, `${manifest.usda.version}.db`];
const top = async (query, known) =>
  (await catalog.searchFoods(query, known)).slice(0, 3).map((food) => food.name);

test("search expressions keep the food words as stemmed prefixes", () => {
  for (const [query, expression] of [
    ["eggs", '"egg"*'],
    ["cherry", '"cherr"*'],
    ["blueberries", '"blueberr"*'],
    ["mcdonalds", '"mcdonald"*'],
    ["McDonald's", '"mcdonald"*'],
    ["Wendy's", '"wend"*'],
    ["cookies", '"cookie"*'],
    ["cup of coffee", '"coffee"*'],
    ["2 eggs", '"egg"*'],
    ["200 g chicken breast", '"chicken"* AND "breast"*'],
    ["200g chicken breast", '"chicken"* AND "breast"*'],
    ["1.5 cups rice", '"rice"*'],
    ["1/2 cup oats", '"oat"*'],
    ["8 fl oz milk", '"milk"*'],
    ["slice of pizza", '"pizza"*'],
    ["large egg", '"egg"*'],
    ["2 large eggs", '"egg"*'],
    ["2 cups", '"cup"*'],
    ["12", ""],
    // Numbers written into a name stay, and match only themselves.
    ["2% milk", '"2" AND "milk"*'],
    ["3.25% milk", '"3" AND "25" AND "milk"*'],
    ["93/7 ground beef", '"93" AND "7" AND "ground"* AND "beef"*'],
    ["7-up", '"7" AND "up"*'],
    ["7up", '"7up"*'],
    // Count and unit words stay when they name the food.
    ["cup", '"cup"*'],
    ["cup noodles", '"cup"* AND "noodle"*'],
    ["k cup", '"k"* AND "cup"*'],
    ["peanut butter cups", '"peanut"* AND "butter"* AND "cup"*'],
    ["mini wheats", '"mini"* AND "wheat"*'],
    ["or", '"or"*'],
    ["crème brûlée", '"creme"* AND "brulee"*'],
    // The model's looser wordings don't take over a typed word.
    ["fries", '"fries"*'],
    ["pop", '"pop"*'],
    ["ketchup", '("ketchup"* OR "catsup"*)'],
    ['" OR - NEAR ( *', '"near"*'],
    ["", ""],
  ])
    assert.equal(rank.searchExpression(query), expression, query);
});

test("typed searches match the person's own foods by word, not by substring", () => {
  const named = (name, brand = "") => ({ name, brand });
  assert.ok(rank.matchesQuery("eggs", named("Egg, whole, cooked, hard-boiled")));
  assert.ok(rank.matchesQuery("chicken breast", named("Chicken, broilers or fryers, breast")));
  assert.ok(rank.matchesQuery("chic", named("Chicken thigh")), "a half-typed word counts");
  assert.ok(rank.matchesQuery("or", named("Orange juice")), "a short word may be a prefix");
  assert.ok(rank.matchesQuery("cup of coffee", named("Coffee, brewed")));
  assert.ok(rank.matchesQuery("tyson", named("Chicken breast", "Tyson")));
  assert.ok(rank.matchesQuery("oat", named("Oat breakfast")));
  assert.ok(!rank.matchesQuery("oat", named("Goat cheese")));
  assert.ok(!rank.matchesQuery("rice", named("Licorice")));
  assert.ok(!rank.matchesQuery("chicken breast", named("Chicken thigh")));
  assert.ok(!rank.matchesQuery("", named("Anything")));
  // A number in the search is the variety asked for.
  assert.ok(rank.matchesQuery("2% milk", named("Milk, reduced fat, fluid, 2% milkfat")));
  assert.ok(!rank.matchesQuery("2% milk", named("Milk, whole, 3.25% milkfat")));
  assert.ok(!rank.matchesQuery("2% milk", named("Whole milk")));
  assert.ok(rank.matchesQuery("93/7 beef", named("Ground beef 93/7")));
  assert.ok(!rank.matchesQuery("93/7 beef", named("Ground beef 80/20")));
});

test("everyday searches put a plain staple in the top three", async () => {
  const basket = [
    ["egg", /^Egg, whole, /],
    ["eggs", /^Egg, whole, /],
    ["2 eggs", /^Egg, whole, /],
    ["rice", /^Rice, white, long-grain, .*cooked/],
    ["white rice", /^Rice, white, long-grain, .*cooked/],
    ["brown rice", /^Rice, brown, .*cooked/],
    ["chicken", /^Chicken, broilers or fryers, .*cooked, roasted/],
    ["chicken breast", /^Chicken, broilers or fryers, breast, .*cooked, roasted/],
    ["200g chicken breast", /^Chicken, broilers or fryers, breast, .*cooked/],
    ["apple", /^Apples, raw/],
    ["apples", /^Apples, raw/],
    ["banana", /^Bananas, raw/],
    ["blueberry", /^Blueberries, raw$/],
    ["strawberries", /^Strawberries, raw$/],
    ["cherry", /^Cherries, sweet, raw/],
    ["avocado", /^Avocados, raw/],
    ["broccoli", /^Broccoli, (raw|cooked)/],
    ["coffee", /^Beverages, coffee, brewed/],
    ["cup of coffee", /^Beverages, coffee, brewed/],
    ["potato", /^Potatoes, (baked|boiled)/],
    ["sweet potato", /^Sweet potato, cooked, (baked|boiled)/],
    ["salmon", /^Fish, salmon, .*cooked/],
    ["tuna", /^Fish, tuna, /],
    ["ground beef", /^Beef, ground, /],
    ["milk", /^Milk, whole, /],
    ["whole milk", /^Milk, whole, /],
    ["greek yogurt", /^Yogurt, Greek, plain/],
    ["cheese", /^Cheese, cheddar/],
    ["cream cheese", /^Cheese, cream$/],
    ["cottage cheese", /^Cheese, cottage, /],
    ["oatmeal", /^Cereals, oats, .*cooked/],
    ["pasta", /^Pasta, cooked/],
    ["peanut butter", /^Peanut butter, (smooth|chunk)/],
    ["almonds", /^Nuts, almonds/],
    ["black beans", /^Beans, black, mature seeds, cooked/],
    ["orange juice", /^Orange juice, raw/],
    ["slice of pizza", /^Pizza, cheese topping/],
    ["mcdonalds", /^McDONALD'S, /],
    ["big mac", /^McDONALD'S, BIG MAC$/],
    ["wendys", /^WENDY'S, /],
    // Fat levels and other numbers written into a name.
    ["2% milk", /^Milk, reduced fat, fluid, 2% milkfat/],
    ["1% milk", /^Milk, lowfat, fluid, 1% milkfat/],
    ["85% lean ground beef", /^Beef, ground, 85% lean/],
    ["93/7 ground beef", /^Beef, ground, 93% lean meat \/ ?7% fat/],
    ["80/20 ground beef", /^Beef, ground, 80% lean meat \/ ?20% fat/],
    ["0% greek yogurt", /\b0%/],
    ["2% cottage cheese", /^Cheese, cottage, lowfat, 2% milkfat/],
    ["12 grain bread", /^12 grain bread/i],
    ["7-up", /^7 up$/i],
    // Count and unit words that name the food.
    ["cup noodles", /cup noodle/i],
    ["glass noodles", /glass noodle/i],
    ["k cup", /k-cup/i],
    ["peanut butter cups", /peanut butter cup/i],
    ["mini wheats", /mini.wheats/i],
    ["strip steak", /strip steak/i],
    ["potato wedges", /potato wedges/i],
    ["fries", /fries/i],
    ["pop tarts", /pop.?tart/i],
    ["burger", /burger/i],
  ];
  const misses = [];
  for (const [query, expected] of basket) {
    const names = await top(query);
    if (!names.some((name) => expected.test(name))) misses.push(`${query}: ${names.join(" | ")}`);
  }
  assert.deepEqual(misses, []);
  // The first row for a plain food is the everyday one, not a dish that contains it.
  assert.match((await top("eggs"))[0], /^Egg, whole, cooked/);
  assert.match((await top("rice"))[0], /^Rice, white, long-grain, .*cooked/);
  assert.match((await top("mcdonalds big mac"))[0], /^McDONALD'S, BIG MAC$/);
  // The top row is the one typed: its fat level, the named product, not a looser wording.
  for (const [query, expected] of [
    ["2% milk", /^Milk, reduced fat, fluid, 2% milkfat/],
    ["milk 2%", /^Milk, reduced fat, fluid, 2% milkfat/],
    ["93% lean ground beef", /^Beef, ground, 93% lean/],
    ["90/10 ground beef", /^Beef, ground, 90% lean meat \/ ?10% fat/],
    ["cup noodles", /cup noodle/i],
    ["peanut butter cups", /peanut butter cups/i],
    ["fries", /fries/i],
    ["pop tarts", /pop.?tarts/i],
    ["burger", /burger/i],
    ["pop", /^Snacks, popcorn/],
  ])
    assert.match((await top(query))[0], expected, query);
  // A count before a food only ranks a name that has it: "2 eggs" are still plain eggs.
  assert.match((await top("2 eggs"))[0], /^Egg, whole, cooked/);
});

test("branded foods stay reachable, and a named brand is not marked down", async () => {
  const oreo = (await catalog.searchFoods("oreo"))[0];
  assert.equal(oreo.source, "off");
  assert.match(oreo.brand, /oreo/i);
  const cola = (await catalog.searchFoods("coca cola"))[0];
  assert.match(`${cola.name} ${cola.brand}`, /coca.cola/i);
  // A brand only resembling the search ("Pizzah") does not outrank plain pizza.
  assert.equal((await catalog.searchFoods("pizza"))[0].source, "usda");
  // Plain searches keep generic foods ahead of packaged ones.
  for (const query of ["chicken breast", "greek yogurt", "peanut butter"])
    assert.equal((await catalog.searchFoods(query))[0].source, "usda", query);
});

test("the person's own foods lead a search, more so the more often they are eaten", async () => {
  const pool = await catalog.searchFoods("eggs");
  const boiled = pool.find((food) => food.name === "Egg, whole, cooked, hard-boiled");
  const scrambled = pool.find((food) => food.name === "Egg, whole, cooked, scrambled");
  assert.ok(boiled && scrambled);
  assert.notEqual(pool[0].id, boiled.id);
  assert.equal((await catalog.searchFoods("eggs", new Set([boiled.id])))[0].id, boiled.id);
  const known = new Map([
    [boiled.id, 1],
    [scrambled.id, 20],
  ]);
  assert.deepEqual(
    (await catalog.searchFoods("eggs", known)).slice(0, 2).map((food) => food.id),
    [scrambled.id, boiled.id]
  );
  // A known food still has to match the search.
  const other = await catalog.searchFoods("banana", new Set([boiled.id]));
  assert.ok(!other.some((food) => food.id === boiled.id));
});

test("search waits for a second letter and falls back to the food's own name", async () => {
  reads = 0;
  assert.deepEqual(await catalog.searchFoods("c"), []);
  assert.deepEqual(await catalog.searchFoods("a"), []);
  assert.deepEqual(await catalog.searchFoods("   "), []);
  assert.equal(reads, 0, "a single letter never reaches the catalog");
  // A half-typed last word is searched once it has two letters; until then, the rest is.
  assert.match((await top("chicken b"))[0], /^Chicken, /);
  assert.match((await top("chicken br"))[0], /^Chicken, broilers or fryers, breast/);
  // Words the catalog doesn't know fall back to the last word, which names the food.
  assert.match((await top("zesty homestyle banana"))[0], /^Bananas, raw/);
  assert.deepEqual(await catalog.searchFoods("qqqzzz"), []);
});

test("a keystroke search with reranking stays within its budget", async () => {
  await catalog.searchFoods("warm");
  for (const query of ["ch", "co", "ba", "sa", "po", "chicken", "cheese", "2% milk", "2 eggs"]) {
    let best = Infinity;
    for (let run = 0; run < 3; run++) {
      const start = performance.now();
      await catalog.searchFoods(query);
      best = Math.min(best, performance.now() - start);
    }
    assert.ok(best < 60, `${query} took ${best.toFixed(1)} ms`);
  }
});

// The first megabyte of a catalog: what a copy leaves when the disk fills or the app is closed.
const cut = (from, to) => writeFileSync(to, readFileSync(from).subarray(0, 1 << 20));
const pending = (source) => `${source.version}.pending.db`;
function warnings(t) {
  const warn = console.warn;
  const seen = [];
  console.warn = (...args) => seen.push(args);
  t.after(() => (console.warn = warn));
  return seen;
}

test("catalogs install into the cache folder once, and later launches copy nothing", async () => {
  await catalog.openCatalogs();
  assert.deepEqual(device.files(device.folders.catalogs), installed);
  assert.deepEqual(device.imports.sort(), [pending(manifest.off), pending(manifest.usda)]);
  const relaunched = device.launch();
  assert.deepEqual(
    (await relaunched.openCatalogs()).map((opened) => opened.kind),
    ["generic", "branded"]
  );
  assert.equal(device.imports.length, 2);
});

test("a copy cut short is never opened: it is copied again, once", async (t) => {
  const { root, folders, files, imports, launch } = phone();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // The app was closed partway through the first launch's copy of OFF.
  cut(assets[2], path.join(folders.catalogs, pending(manifest.off)));
  // This launch's first copy of USDA fills the disk.
  let full = true;
  const copy = (from, to) => {
    if (from !== assets[1] || !full) return clone(from, to);
    full = false;
    cut(from, to);
    throw new Error("No space left on device");
  };
  const first = launch({ copy });
  assert.equal((await first.openCatalogs()).length, 2);
  assert.deepEqual(files(folders.catalogs), installed);
  assert.deepEqual(imports.sort(), [
    pending(manifest.off),
    pending(manifest.usda),
    pending(manifest.usda),
  ]);
  assert.match((await first.searchFoods("apples"))[0].name, /^Apples, raw/);

  // An installed copy that is no longer a database, at the right size, is replaced too.
  writeFileSync(path.join(folders.catalogs, installed[1]), new Uint8Array(manifest.usda.bytes));
  const second = launch();
  assert.equal((await second.openCatalogs()).length, 2);
  assert.equal(imports.filter((name) => name === pending(manifest.usda)).length, 3);
  assert.deepEqual(files(folders.catalogs), installed);
  assert.match((await second.searchFoods("apples"))[0].name, /^Apples, raw/);
});

/** Rejects if `promise` takes longer than `ms`, such as a search held up by a copy. */
async function within(ms, promise) {
  let timer;
  const late = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Still waiting after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

test("a catalog that can't install leaves the other searching and is retried behind it", async (t) => {
  const { root, folders, files, imports, launch } = phone();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const warned = warnings(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  // OFF's copy fills the disk until there is room, and waits for `copying` to finish.
  let room = false;
  let copying = Promise.resolve();
  const copy = async (from, to) => {
    if (from !== assets[2]) return clone(from, to);
    await copying;
    if (room) return clone(from, to);
    cut(from, to);
    throw new Error("No space left on device");
  };
  const copies = () => imports.filter((name) => name === pending(manifest.off)).length;
  const catalog = launch({ copy });
  assert.deepEqual(
    (await catalog.openCatalogs()).map((opened) => opened.kind),
    ["generic"]
  );
  assert.equal(copies(), 2, "the launch copies it again, once");
  assert.deepEqual(files(folders.catalogs), installed.slice(1), "the cut copy doesn't keep space");
  const off = new DatabaseSync(assets[2], { readOnly: true });
  const { barcode } = off.prepare("SELECT barcode FROM foods WHERE barcode <> '' LIMIT 1").get();
  off.close();
  // Keystrokes, a fallback search and a barcode scan within the minute copy nothing more.
  for (const query of ["ap", "app", "appl", "apple", "apples", "zzqx pizza"])
    await catalog.searchFoods(query);
  assert.match((await catalog.searchFoods("apples"))[0].name, /^Apples, raw/);
  // A barcode missing from the catalogs that opened isn't reported as unknown.
  await assert.rejects(catalog.lookupBarcode(barcode), /couldn't open/);
  assert.equal(copies(), 2);
  assert.ok(warned.length && warned.every(([message]) => message.includes(manifest.off.version)));

  // A minute on, a search starts the retry and returns without waiting for it.
  now += 60_000;
  let finish;
  copying = new Promise((resolve) => (finish = resolve));
  assert.match((await within(1000, catalog.searchFoods("apples")))[0].name, /^Apples, raw/);
  await within(1000, catalog.searchFoods("banana"));
  assert.equal(copies(), 3);
  finish();
  // A barcode scan does wait for it, since "not found" needs every catalog.
  await assert.rejects(catalog.lookupBarcode(barcode), /couldn't open/);
  assert.equal(copies(), 4);
  await catalog.searchFoods("apples");
  assert.equal(copies(), 4);

  now += 60_000;
  room = true;
  assert.equal((await catalog.lookupBarcode(barcode)).source, "off");
  assert.equal(copies(), 5);
  assert.deepEqual(files(folders.catalogs), installed);
  assert.match((await catalog.searchFoods("oreo"))[0].brand, /oreo/i);
});

test("on Android, a catalog that won't fit with room to spare isn't copied", async (t) => {
  const { root, folders, files, imports, launch } = phone();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  warnings(t);
  // Enough for USDA and the space kept free, not for OFF.
  const catalog = launch({ android: true, free: 100 * 1024 * 1024 });
  assert.deepEqual(
    (await catalog.openCatalogs()).map((opened) => opened.kind),
    ["generic"]
  );
  assert.deepEqual(imports, [pending(manifest.usda)]);
  assert.deepEqual(files(folders.catalogs), installed.slice(1));
});

test("with no catalog open, search fails and leaves nothing behind", async (t) => {
  const { root, folders, files, launch } = phone();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  warnings(t);
  const diary = ["macro_track.db", "macro_track.db-shm", "macro_track.db-wal"];
  for (const name of ["usda-v0-aaaaaaaaaaaa-bbbbbbbb.db", ...diary])
    writeFileSync(path.join(folders.legacy, name), "");
  const catalog = launch({
    copy: (from, to) => {
      cut(from, to);
      throw new Error("No space left on device");
    },
  });
  await assert.rejects(catalog.openCatalogs(), /couldn't open/);
  await assert.rejects(catalog.searchFoods("apples"), /couldn't open/);
  assert.deepEqual(files(folders.catalogs), []);
  assert.deepEqual(files(folders.legacy), diary, "old copies go even so");
});

test("an update moves in the catalogs earlier builds installed, needing no room", async (t) => {
  const { root, folders, files, imports, launch } = phone();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Earlier builds kept catalogs beside the diary, and had no cache folder for them.
  rmSync(folders.catalogs, { recursive: true });
  const diary = ["macro_track.db", "macro_track.db-shm", "macro_track.db-wal"];
  clone(assets[1], path.join(folders.legacy, installed[1]));
  clone(assets[2], path.join(folders.legacy, installed[0]));
  for (const name of [`${installed[0]}-journal`, "usda-v0-aaaaaaaaaaaa-bbbbbbbb.db", ...diary])
    writeFileSync(path.join(folders.legacy, name), "");

  const catalog = launch({
    android: true,
    free: 0,
    copy: () => {
      throw new Error("No space left on device");
    },
  });
  assert.equal((await catalog.openCatalogs()).length, 2);
  assert.deepEqual(imports, []);
  assert.deepEqual(files(folders.catalogs), installed);
  assert.deepEqual(files(folders.legacy), diary);
  assert.match((await catalog.searchFoods("oreo"))[0].brand, /oreo/i);
});

test("old versions and copies cut short are deleted before anything installs", async (t) => {
  const { root, folders, files, imports, launch } = phone();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const [oldUsda, oldOff] = ["usda-v0-aaaaaaaaaaaa-bbbbbbbb", "off-v0-cccccccccccc-bbbbbbbb"];
  const old = [`${oldUsda}.db`, `${oldOff}.db`, `${oldOff}.db-journal`, `${oldOff}.pending.db`];
  for (const name of [...old, "notes.txt"]) writeFileSync(path.join(folders.catalogs, name), "");
  // The current USDA catalog is already installed, so it stays and isn't copied again.
  clone(assets[1], path.join(folders.catalogs, installed[1]));
  // An earlier build's OFF, moved in, turns out to be cut short, so it is copied afresh.
  const diary = ["macro_track.db", "macro_track.db-shm", "macro_track.db-wal"];
  for (const name of [installed[0], installed[1], `${oldUsda}.db`, ...diary])
    writeFileSync(path.join(folders.legacy, name), "");

  let seen;
  const catalog = launch({
    copy: (from, to) => {
      seen ??= files(folders.catalogs);
      return clone(from, to);
    },
  });
  assert.equal((await catalog.openCatalogs()).length, 2);
  assert.deepEqual(seen, ["notes.txt", installed[1]]);
  assert.deepEqual(imports, [pending(manifest.off)]);
  assert.deepEqual(files(folders.catalogs), [...installed, "notes.txt"].sort());
  assert.deepEqual(files(folders.legacy), diary);
  assert.match((await catalog.searchFoods("oreo"))[0].brand, /oreo/i);
});
