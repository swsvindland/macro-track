import { importDatabaseFromAssetAsync, openDatabaseAsync, type SQLiteDatabase } from "expo-sqlite";
import manifest from "../../assets/food/manifest.json";
import { normalizeBarcode, searchExpression, type Food } from "./nutrition";

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

export async function searchCatalog(query: string): Promise<Food[]> {
  const expression = searchExpression(query);
  return expression ? searchCatalogMatch(expression) : [];
}

/**
 * Runs a prepared FTS5 expression against every catalog, generic foods first. The generic
 * catalog is small, so a deeper limit there reaches plain foods that rank below variations.
 */
export async function searchCatalogMatch(
  expression: string,
  limits: { generic: number; branded: number } = { generic: 30, branded: 30 }
): Promise<Food[]> {
  const databases = await openCatalogs();
  const results = await Promise.all(
    databases.map((database, i) =>
      database.getAllAsync<{ data: string; rank: number }>(
        `SELECT foods.data, bm25(food_search, 3.0, 1.0) AS rank FROM food_search
     JOIN foods ON foods.rowid = food_search.rowid WHERE food_search MATCH ? ORDER BY rank LIMIT ?`,
        expression,
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
