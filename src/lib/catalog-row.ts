import type { Food } from "./nutrition";

/** A row of a catalog's foods table. */
export type CatalogRow = {
  id: string | null;
  name: string;
  brand: string;
  barcode: string | number | null;
  data: string;
};

type Packed = [Food["basis"], (number | null)[], [string, number][]?];
type Unpacked = Pick<Food, "basis" | "nutrients" | "portions">;

/**
 * A catalog row as a food. Catalogs from version 3 on list their nutrient keys in catalog_meta
 * (`order`) and keep each row's values in that order, null where unknown; they keep a barcode as
 * its 14-digit number and leave out an id that is "off:" and the barcode's 13-digit form, as
 * nearly every packaged food's is. Earlier catalogs keep an object, the barcode and every id.
 */
export function catalogFood(
  source: "usda" | "off",
  sourceVersion: string,
  order: string[] | null,
  row: CatalogRow
): Food {
  const barcode = row.barcode === null ? null : String(row.barcode).padStart(14, "0");
  let unpacked: Unpacked;
  if (order) {
    const [basis, values, portions = []] = JSON.parse(row.data) as Packed;
    // Fiber and sodium are always there, null when unknown; a micronutrient only when known.
    const nutrients: Record<string, number | null> = { fiber: null, sodium: null };
    order.forEach((key, i) => {
      if (values[i] != null) nutrients[key] = values[i];
    });
    unpacked = {
      basis,
      nutrients: nutrients as Food["nutrients"],
      portions: portions.map(([label, amount]) => ({ label, amount })),
    };
  } else unpacked = JSON.parse(row.data) as Unpacked;
  return {
    id: row.id ?? `off:${barcode!.slice(1)}`,
    name: row.name,
    brand: row.brand,
    barcode,
    ...unpacked,
    source,
    sourceVersion,
  };
}
