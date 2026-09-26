import { importDatabaseFromAssetAsync, openDatabaseAsync, type SQLiteDatabase } from "expo-sqlite";
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
let initialization: Promise<SQLiteDatabase[]> | undefined;

export function openCatalogs() {
  if (!initialization) {
    initialization = Promise.all(
      [
        { source: manifest.usda, assetId: require("../../assets/food/usda.db") },
        { source: manifest.off, assetId: require("../../assets/food/off.db") },
      ].map(async ({ source, assetId }) => {
        const filename = `${source.version}.db`;
        await importDatabaseFromAssetAsync(filename, { assetId });
        const database = await openDatabaseAsync(filename);
        const metadata = await database.getFirstAsync<{ value: string }>(
          "SELECT value FROM catalog_meta WHERE key = 'version'"
        );
        if (metadata?.value !== source.version) {
          await database.closeAsync();
          throw new Error(
            "The food catalog could not be opened. Please try again or update the app."
          );
        }
        await database.execAsync("PRAGMA query_only = ON");
        return database;
      })
    ).catch((error) => {
      initialization = undefined;
      throw error;
    });
  }
  return initialization;
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
  const databases = await openCatalogs();
  const results = await Promise.all(
    databases.map((database, i) =>
      database.getAllAsync<{ data: string }>(
        `SELECT foods.data FROM food_search JOIN foods ON foods.rowid = food_search.rowid
     WHERE food_search MATCH ? ORDER BY foods.name LIKE ? DESC, bm25(food_search, 3.0, 1.0)
     LIMIT ?`,
        expression,
        lead ? `${lead}%` : "",
        i === 0 ? limits.generic : limits.branded
      )
    )
  );
  // Each catalog ranks within its own corpus; keep generic foods first for ingredient searches.
  return results.flat().map((row) => JSON.parse(row.data) as Food);
}

export async function lookupBarcode(input: string): Promise<Food | null> {
  const barcode = normalizeBarcode(input);
  if (!barcode) return null;
  for (const database of await openCatalogs()) {
    const row = await database.getFirstAsync<{ data: string }>(
      "SELECT data FROM foods WHERE barcode = ? LIMIT 1",
      barcode
    );
    if (row) return JSON.parse(row.data) as Food;
  }
  return null;
}
