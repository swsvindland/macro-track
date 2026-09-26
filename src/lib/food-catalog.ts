import { Directory, File, Paths } from "expo-file-system";
import { importDatabaseFromAssetAsync, openDatabaseAsync, type SQLiteDatabase } from "expo-sqlite";
import { Platform } from "react-native";
import manifest from "../../assets/food/manifest.json";
import {
  allowedTypos,
  countWords,
  misread,
  rankSearch,
  readQuery,
  searchForms,
  searchTerm,
  stem,
  type Fixes,
  type Known,
} from "./food-rank";
import { normalizeBarcode, type Food } from "./nutrition";

export { manifest as catalogManifest };

type Source = { version: string; bytes: number };
type Bundled = { kind: "generic" | "branded"; source: Source; assetId: number };
const bundled: Bundled[] = [
  { kind: "generic", source: manifest.usda, assetId: require("../../assets/food/usda.db") },
  { kind: "branded", source: manifest.off, assetId: require("../../assets/food/off.db") },
];
// Installed copies are rebuilt from the app bundle whenever they are missing, so they live in the
// cache folder, which iCloud and Android backups leave out.
const catalogFolder = () => new Directory(Paths.cache, "catalogs");
// Earlier builds installed them beside the diary, in the backed-up Documents folder.
const legacyFolder = () => new Directory(Paths.document, "SQLite");
const catalogFile = /^(usda|off)-v.*\.db(-journal|-wal|-shm)?$/;
const localPath = (folder: Directory) => decodeURIComponent(folder.uri.replace(/^file:\/\//, ""));
const unavailable = () =>
  new Error("The food catalog couldn't open. Free up some storage and try again.");
// A catalog that couldn't install is tried again this long after, rather than on every search.
const retryAfter = 60_000;
// Free space an install on Android leaves for the diary.
const reserve = 64 * 1024 * 1024;

/** Deletes the catalog files in `folder` that `stale` names; what can't go now goes next launch. */
function prune(folder: Directory, stale: (name: string) => boolean) {
  try {
    if (!folder.exists) return;
    for (const file of folder.list())
      if (file instanceof File && catalogFile.test(file.name) && stale(file.name)) file.delete();
  } catch (error) {
    console.warn("Could not remove old food catalog files", error);
  }
}

let tidied = false;

/**
 * Once a launch, before any install: moves in the current catalogs earlier builds left in
 * Documents/SQLite, a rename that needs no space, then deletes every other catalog file there and
 * any older version or copy cut short here.
 */
function tidy() {
  if (tidied) return;
  tidied = true;
  const folder = catalogFolder();
  const legacy = legacyFolder();
  const current = bundled.map(({ source }) => `${source.version}.db`);
  try {
    if (legacy.exists) {
      folder.create({ intermediates: true, idempotent: true });
      for (const name of current) {
        const earlier = new File(legacy, name);
        const installed = new File(folder, name);
        if (earlier.exists && !installed.exists) earlier.moveSync(installed);
      }
    }
  } catch (error) {
    console.warn("Could not move the food catalogs", error);
  }
  prune(folder, (name) => !current.includes(name));
  prune(legacy, () => true);
}

/** Opens a catalog file read-only if it is the whole bundled version, and closes it otherwise. */
async function openChecked(folder: Directory, file: File, source: Source) {
  // A copy cut short by a full disk or a closed app is smaller than the bundled one.
  if (file.size !== source.bytes) throw new Error(`${file.name} is incomplete.`);
  const database = await openDatabaseAsync(file.name, undefined, localPath(folder));
  try {
    const metadata = await database.getFirstAsync<{ value: string }>(
      "SELECT value FROM catalog_meta WHERE key = 'version'"
    );
    if (metadata?.value !== source.version)
      throw new Error(`${file.name} is not ${source.version}.`);
    await database.execAsync("PRAGMA query_only = ON");
    return database;
  } catch (error) {
    await database.closeAsync().catch(() => {});
    throw error;
  }
}

/** Copies a bundled catalog in under a pending name and renames it into place once checked. */
async function install(folder: Directory, { source, assetId }: Bundled) {
  const installed = new File(folder, `${source.version}.db`);
  if (!installed.exists) {
    // iOS clones the bundled file; Android writes every byte, so it doesn't start what can't fit.
    if (Platform.OS === "android" && Paths.availableDiskSpace < source.bytes + reserve)
      throw new Error(`No room to install ${source.version}.`);
    const pending = new File(folder, `${source.version}.pending.db`);
    await importDatabaseFromAssetAsync(
      pending.name,
      { assetId, forceOverwrite: true },
      localPath(folder)
    );
    await (await openChecked(folder, pending, source)).closeAsync();
    pending.moveSync(installed, { overwrite: true });
  }
  return openChecked(folder, installed, source);
}

/** Installs and opens a catalog, starting again from the bundle once if that fails. */
async function open(catalog: Bundled) {
  const { version } = catalog.source;
  const folder = catalogFolder();
  for (let attempt = 1; ; attempt++) {
    try {
      return await install(folder, catalog);
    } catch (error) {
      // Whatever was copied is suspect: start again from the bundle, once.
      prune(folder, (name) => name.startsWith(`${version}.`));
      if (attempt === 2) {
        console.warn(`Could not install the ${version} food catalog`, error);
        throw error;
      }
    }
  }
}

type Opening = {
  done: Promise<SQLiteDatabase | undefined>;
  database?: SQLiteDatabase;
  failedAt?: number;
  retry: boolean;
};
const opening = new Map<string, Opening>();

function openCatalog(catalog: Bundled) {
  const { version } = catalog.source;
  const last = opening.get(version);
  if (last && (last.failedAt === undefined || Date.now() - last.failedAt < retryAfter)) return last;
  const next: Opening = {
    retry: Boolean(last),
    done: open(catalog).then(
      (database) => (next.database = database),
      () => {
        next.failedAt = Date.now();
        return undefined;
      }
    ),
  };
  opening.set(version, next);
  return next;
}

/**
 * The catalogs that open. The launch's first install is waited for; a retry runs behind the
 * searches, which use the catalogs already open, unless `complete` asks for all of them or none
 * has opened.
 */
async function openAll(complete = false) {
  tidy();
  const current = bundled.map(openCatalog);
  let databases = await Promise.all(
    current.map(({ retry, database, done }) => (retry ? database : done))
  );
  if (databases.includes(undefined) && (complete || !databases.some(Boolean)))
    databases = await Promise.all(current.map(({ done }) => done));
  const opened = databases.flatMap((database, i) =>
    database ? [{ kind: bundled[i].kind, version: bundled[i].source.version, database }] : []
  );
  return { opened, failed: opened.length < bundled.length };
}

/**
 * The installed catalogs, generic foods first, installing any that are missing. One that can't
 * open is left out, so the rest still search; the call fails only when none opens.
 */
export async function openCatalogs() {
  const { opened } = await openAll();
  if (!opened.length) throw unavailable();
  return opened;
}

type Catalog = Awaited<ReturnType<typeof openCatalogs>>[number];
type Row = { id: string; name: string; brand: string; barcode: string | null; data: string };
type Ranked = Row & { popularity: number };
const columns = "foods.id, foods.name, foods.brand, foods.barcode, foods.data";

/** A catalog row as a food: its columns, plus the basis, nutrients and portions kept as JSON. */
function catalogFood({ kind, version }: Catalog, row: Row): Food {
  const { basis, nutrients, portions } = JSON.parse(row.data) as Pick<
    Food,
    "basis" | "nutrients" | "portions"
  >;
  return {
    id: row.id,
    name: row.name,
    brand: row.brand,
    barcode: row.barcode,
    basis,
    nutrients,
    portions,
    source: kind === "generic" ? "usda" : "off",
    sourceVersion: version,
  };
}

/** What a typed word probably meant, when the catalogs barely know it as typed. */
const spellings = new Map<string, string[]>();
/**
 * A word in fewer foods than `rare` is also searched as a word a typo away in ten times as many.
 * A longer one in fewer than `uncommon` is too, when that word is in 75 times as many: "protien"
 * is on 35 labels. Short words have too many real neighbors: "coke" is not cake.
 */
const rare = 20;
const uncommon = 200;

async function count(catalogs: Catalog[], sql: string, ...params: (string | number)[]) {
  const found = new Map<string, number>();
  for (const { database } of catalogs)
    for (const row of await database.getAllAsync<{ term: string; foods: number }>(sql, ...params))
      found.set(row.term, (found.get(row.term) ?? 0) + row.foods);
  return found;
}

/**
 * What a typed word probably meant when the catalogs barely know it: the far more common catalog
 * words it is a typo or two from ("chiken" is chicken, "chikc" the start of chicken), else the two
 * words it joins ("peanutbutter"). Remembered for the launch, since each keystroke asks again.
 */
async function spell(word: string, catalogs: Catalog[]): Promise<string[]> {
  const remembered = spellings.get(word);
  if (remembered) return remembered;
  const form = stem(word);
  const limit = allowedTypos(word);
  const range = "SELECT term, foods FROM terms WHERE term >= ? AND term < ?";
  let known = uncommon;
  if (limit && !/\d/.test(word))
    known = [...(await count(catalogs, range, form, `${form}\uffff`)).values()].reduce(
      (sum, n) => sum + n,
      0
    );
  const fixes: string[] = [];
  if (known < rare || (known < uncommon && word.length >= 6)) {
    const least = (known < rare ? 10 : 75) * (known + 1);
    // A half-typed word is the start of a catalog word; typos rarely touch both of the first two
    // letters, so words starting with either are read. A whole word may have a typo anywhere.
    const terms = new Map<string, number>();
    for (const start of new Set([word[0], word[1]]))
      for (const [term, foods] of await count(
        catalogs,
        `${range} AND length(term) >= ?`,
        start,
        `${start}\uffff`,
        word.length - limit
      ))
        terms.set(term, foods);
    for (const [term, foods] of await count(
      catalogs,
      "SELECT term, foods FROM terms WHERE length(term) BETWEEN ? AND ? AND foods >= ?",
      word.length - limit,
      word.length + limit,
      Math.ceil(least / 2)
    ))
      terms.set(term, foods);
    const meant = new Map<string, { edits: number; foods: number }>();
    for (const [term, foods] of terms) {
      const found = misread(word, term);
      if (!found || found.edits === 0) continue;
      const key = stem(found.meant);
      const last = meant.get(key);
      if (!last || found.edits < last.edits) meant.set(key, { edits: found.edits, foods });
      else if (found.edits === last.edits) last.foods += foods;
    }
    const common = [...meant].filter(([, { foods }]) => foods >= least);
    const fewest = Math.min(...common.map(([, { edits }]) => edits));
    const likely = common
      .filter(([, { edits }]) => edits === fewest)
      .sort((a, b) => b[1].foods - a[1].foods);
    fixes.push(
      ...likely
        // A second reading only when it is nearly as likely: "brest" is breast or best.
        .filter(([, { foods }], i) => i < 2 && foods >= likely[0][1].foods / 10)
        .map(([key]) => key)
        // "tortil" already searches for tortilla.
        .filter((key, _, all) => !all.some((other) => other !== key && key.startsWith(other)))
    );
    if (!fixes.length && known < rare && word.length >= 6) {
      // Two words typed without the space between them.
      const splits = Array.from({ length: word.length - 5 }, (_, i) => [
        word.slice(0, i + 3),
        word.slice(i + 3),
      ]);
      const parts = [...new Set(splits.flat())];
      const found = await count(
        catalogs,
        `SELECT term, foods FROM terms WHERE term IN (${parts.map(() => "?").join(",")})`,
        ...parts
      );
      const best = splits
        .map(([left, right]) => ({
          left,
          right,
          foods: Math.min(found.get(left) ?? 0, found.get(right) ?? 0),
        }))
        .sort((a, b) => b.foods - a.foods)[0];
      if (best && best.foods >= least) fixes.push(`${best.left} ${stem(best.right)}`);
    }
  }
  if (spellings.size > 500) spellings.clear();
  spellings.set(word, fixes);
  return fixes;
}

/**
 * A typed search, best match first, with the corrections it searched for. Each word is a
 * stemmed prefix, a word the catalogs barely know is also searched as what it probably meant, and
 * a search that finds nothing falls back to the word that names the food. The person's own foods
 * in `known` rank higher, and packaged foods people scan more rank higher among themselves.
 */
export async function searchCatalog(
  query: string,
  known: Known = new Set()
): Promise<{ foods: Food[]; fixes: Fixes }> {
  const { words, counts } = readQuery(query);
  // A single letter matches most of the catalog, so the search waits for a second one.
  const last = words.at(-1) ?? "";
  const searched = last.length < 2 && !/^\d$/.test(last) ? words.slice(0, -1) : words;
  const foods = searched.filter((word) => !/^\d+$/.test(word));
  if (!foods.length) return { foods: [], fixes: {} };
  const catalogs = await openCatalogs();
  const fixes: Record<string, string[]> = {};
  for (const word of new Set(foods)) {
    const meant = await spell(word, catalogs);
    if (meant.length) fixes[word] = meant;
  }
  const limits = { generic: 150, branded: 60 };
  const expression = searched.map((word) => searchTerm(word, fixes)).join(" AND ");
  // USDA names lead with the food ("Chicken, broilers or fryers, breast…"), so those come first.
  const leadOf = (word: string) => fixes[word]?.[0] ?? searchForms(word)[0];
  // The words alone rank 12-grain bread too low to reach it for "12 grain bread".
  const phrases = counts.map(([count, next]) => `"${count} ${stem(next)}"*`);
  let pool = (
    await Promise.all([
      phrases.length ? match(catalogs, [...phrases, expression].join(" AND ")) : [],
      match(catalogs, expression, limits, leadOf(foods[0])),
    ])
  ).flat();
  if (!pool.length && searched.length > 1) {
    // "Pizza slice" names pizza.
    const head = foods.findLast((word) => !countWords.test(word)) ?? foods.at(-1)!;
    pool = await match(catalogs, searchTerm(head, fixes), limits, leadOf(head));
  }
  const popularity = new Map(pool.map(({ food, popularity }) => [food.id, popularity]));
  const ranked = rankSearch(
    query,
    pool.map(({ food }) => food),
    known,
    { fixes, popularity }
  );
  return { foods: ranked, fixes };
}

/** A typed search, best match first; see searchCatalog. */
export async function searchFoods(query: string, known: Known = new Set()): Promise<Food[]> {
  return (await searchCatalog(query, known)).foods;
}

/**
 * Runs a prepared FTS5 expression against every catalog, generic foods first. The generic
 * catalog is small, so a deeper limit there reaches plain foods that rank below variations.
 * Names starting with `lead` come before the full-text ranking, and among packaged foods the
 * ones scanned more often come sooner.
 */
async function match(
  catalogs: Catalog[],
  expression: string,
  limits: { generic: number; branded: number } = { generic: 30, branded: 30 },
  lead = ""
) {
  const results = await Promise.all(
    catalogs.map(async (catalog) =>
      (
        await catalog.database.getAllAsync<Ranked>(
          `SELECT ${columns}, foods.popularity FROM food_search
           JOIN foods ON foods.rowid = food_search.rowid
           WHERE food_search MATCH ?
           ORDER BY foods.name LIKE ? DESC, bm25(food_search, 3.0, 1.0) - 0.5 * foods.popularity
           LIMIT ?`,
          expression,
          lead ? `${lead}%` : "",
          limits[catalog.kind]
        )
      ).map((row) => ({ food: catalogFood(catalog, row), popularity: row.popularity }))
    )
  );
  // Each catalog ranks within its own corpus; keep generic foods first for ingredient searches.
  return results.flat();
}

/** Runs a prepared FTS5 expression against every catalog; see match. */
export async function searchCatalogMatch(
  expression: string,
  limits?: { generic: number; branded: number },
  lead = ""
): Promise<Food[]> {
  return (await match(await openCatalogs(), expression, limits, lead)).map(({ food }) => food);
}

export async function lookupBarcode(input: string): Promise<Food | null> {
  const barcode = normalizeBarcode(input);
  if (!barcode) return null;
  const { opened, failed } = await openAll(true);
  for (const catalog of opened) {
    const row = await catalog.database.getFirstAsync<Row>(
      `SELECT ${columns} FROM foods WHERE barcode = ? LIMIT 1`,
      barcode
    );
    if (row) return catalogFood(catalog, row);
  }
  // Without every catalog, "not found" would be a guess.
  if (failed) throw unavailable();
  return null;
}
