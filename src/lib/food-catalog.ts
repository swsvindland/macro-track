import { Directory, File, Paths } from "expo-file-system";
import { importDatabaseFromAssetAsync, openDatabaseAsync, type SQLiteDatabase } from "expo-sqlite";
import { Platform } from "react-native";
import manifest from "../../assets/food/manifest.json";
import {
  countWords,
  rankSearch,
  readQuery,
  searchForms,
  searchTerm,
  stem,
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
    database ? [{ kind: bundled[i].kind, database }] : []
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

/**
 * A typed search, best match first. Each word is a stemmed prefix; a search that finds nothing
 * falls back to the word that names the food. The person's own foods in `known` rank higher.
 */
export async function searchFoods(query: string, known: Known = new Set()): Promise<Food[]> {
  const { words, counts } = readQuery(query);
  // A single letter matches most of the catalog, so the search waits for a second one.
  const last = words.at(-1) ?? "";
  const searched = last.length < 2 && !/^\d$/.test(last) ? words.slice(0, -1) : words;
  const foods = searched.filter((word) => !/^\d+$/.test(word));
  if (!foods.length) return [];
  const limits = { generic: 150, branded: 60 };
  const expression = searched.map(searchTerm).join(" AND ");
  // USDA names lead with the food ("Chicken, broilers or fryers, breast…"), so those come first.
  const lead = searchForms(foods[0])[0];
  // The words alone rank 12-grain bread too low to reach it for "12 grain bread".
  const phrases = counts.map(([count, next]) => `"${count} ${stem(next)}"*`);
  let pool = (
    await Promise.all([
      phrases.length ? searchCatalogMatch([...phrases, expression].join(" AND ")) : [],
      searchCatalogMatch(expression, limits, lead),
    ])
  ).flat();
  if (!pool.length && searched.length > 1) {
    // "Pizza slice" names pizza.
    const head = foods.findLast((word) => !countWords.test(word)) ?? foods.at(-1)!;
    pool = await searchCatalogMatch(searchTerm(head), limits, searchForms(head)[0]);
  }
  return rankSearch(query, pool, known);
}

/**
 * Runs a prepared FTS5 expression against every catalog, generic foods first. The generic
 * catalog is small, so a deeper limit there reaches plain foods that rank below variations.
 * Names starting with `lead` come before the full-text ranking.
 */
export async function searchCatalogMatch(
  expression: string,
  limits: { generic: number; branded: number } = { generic: 30, branded: 30 },
  lead = ""
): Promise<Food[]> {
  const catalogs = await openCatalogs();
  const results = await Promise.all(
    catalogs.map(({ kind, database }) =>
      database.getAllAsync<{ data: string }>(
        `SELECT foods.data FROM food_search JOIN foods ON foods.rowid = food_search.rowid
     WHERE food_search MATCH ? ORDER BY foods.name LIKE ? DESC, bm25(food_search, 3.0, 1.0)
     LIMIT ?`,
        expression,
        lead ? `${lead}%` : "",
        limits[kind]
      )
    )
  );
  // Each catalog ranks within its own corpus; keep generic foods first for ingredient searches.
  return results.flat().map((row) => JSON.parse(row.data) as Food);
}

export async function lookupBarcode(input: string): Promise<Food | null> {
  const barcode = normalizeBarcode(input);
  if (!barcode) return null;
  const { opened, failed } = await openAll(true);
  for (const { database } of opened) {
    const row = await database.getFirstAsync<{ data: string }>(
      "SELECT data FROM foods WHERE barcode = ? LIMIT 1",
      barcode
    );
    if (row) return JSON.parse(row.data) as Food;
  }
  // Without every catalog, "not found" would be a guess.
  if (failed) throw unavailable();
  return null;
}
