// Health provenance in the restore swap (docs/vault.md, "Restore"): the SQL that merges the archive's health_links
// with this device's live links, and the installation overrides. The archive's links describe the source device's
// Health store at backup time; the live links describe this device's store now, so their remote ids are always
// valid here. Generated for every descriptor with `health`; descriptors never write merge SQL themselves. A leaf: it
// imports only types and the db.ts helpers, so it never reaches app code.
import type { RestoreContext, VaultHealth, VaultSql } from "../types";

import { literal, q } from "./db";

/** The live-links snapshot the merge reads after the delete step (dropped again by the swap before COMMIT). */
const LIVE = "temp._vault_live_links";
const COLUMNS = '"key", "local_kind", "local_id", "remote_id", "fingerprint", "origin"';

/** Whether the link's local row still exists: `CASE l."local_kind" WHEN 'weight' THEN EXISTS (…) … END`. */
function rowExists(health: VaultHealth): string {
  const kinds = Object.entries(health.rowTables);
  if (!kinds.length) return "0";
  const cases = kinds.map(
    ([kind, table]) =>
      `WHEN ${literal(kind)} THEN EXISTS (SELECT 1 FROM main.${q(table)} r WHERE r."id" = l."local_id")`
  );
  return `CASE l."local_kind" ${cases.join(" ")} ELSE 0 END`;
}

/** The installation a restore leaves (spec §5.2): what installationOverrides writes; null when there is none yet. */
function restoredInstallation(ctx: RestoreContext): string | null {
  return ctx.legacy
    ? ctx.live.installation
    : ctx.sameDevice
      ? (ctx.incoming.installation ?? ctx.live.installation)
      : ctx.freshInstallation;
}

/**
 * The provenance merge (spec §5.4), within the replaced scope: `scope` is the SQL condition limiting a legacy
 * replace (macro: `local_kind = 'weight'`), absent otherwise. `before` snapshots this device's links before the
 * delete step; `after` runs, in this order:
 *   B. keys both sides know: the live remote id and fingerprint win (they describe this store now; a live tombstone
 *      makes the archive's link one, which every export loop rewrites while its row exists);
 *   A. live local links the archive lacks, tombstones included: carried verbatim when no archive link covers that
 *      record, else with local_id = -1 so the next sync removes the sample. Any archive link of that kind and local
 *      id covers it, an import's included: the restored row with that id is then another record (exported under
 *      its own key, or a Health import, which is never exported), so this device's sample of the old record must go.
 *      A live link is never carried when an archive link holds the same remote id (lift's `restored:workout` links
 *      point at the very sample the live link wrote); a tombstone always is: it is this store's only record that
 *      the sample under its key and remote id is gone, and a later restore of a file that still links that sample
 *      needs it (rule B, rule D);
 *   C. true import tombstones (the live row of a Health import was deleted): carried with local_id = -1;
 *   R. a link parked at -1 under the installation the restore keeps whose key names an id of its kind that no link
 *      holds (the key ends in `:<kind>:<id>`): the sync writes a restored record without a link under exactly such a
 *      key (an own record's key is `<prefix>:<installation>:…<kind>:<id>`), and body's and macro's export loops do not
 *      move a link's local id, so a link left at -1 there would remove the sample the write just made, every other
 *      sync. The link takes that id instead (one per id): the sync compares the record with it and replaces its sample
 *      in place; with no record at that id it removes the sample as before (a tombstone just waits);
 *   D. local links still trusted (a fingerprint other than '' and "deleted") whose remote id a local tombstone holds:
 *      that sample is gone from this store, so the fingerprint is cleared and the next sync writes the record again
 *      (lift's `restored:` keys after their workout's sample was deleted, whatever key and local id the tombstone has).
 * Every v2 and legacy situation uses the same rules; the situation-specific parts run on the scratch
 * (prepareScratch) and in the installation overrides below.
 */
export function provenanceSwap(
  health: VaultHealth,
  ctx: RestoreContext,
  scope?: string
): { before: VaultSql[]; after: VaultSql[] } {
  const where = scope ? ` WHERE (${scope})` : "";
  const inScope = scope ? ` AND (${scope})` : "";
  const before: VaultSql[] = [
    { sql: `DROP TABLE IF EXISTS ${LIVE}` },
    {
      sql:
        `CREATE TEMP TABLE _vault_live_links AS SELECT l."key", l."local_kind", l."local_id", l."remote_id", ` +
        `l."fingerprint", l."origin", ${rowExists(health)} AS "row_exists" FROM main."health_links" l${where}`,
    },
  ];
  const after: VaultSql[] = [
    // B
    {
      sql:
        `UPDATE main."health_links" AS h SET "remote_id" = l."remote_id", "fingerprint" = l."fingerprint" ` +
        `FROM ${LIVE} AS l WHERE l."key" = h."key" AND l."origin" = 'local' AND h."origin" = 'local'`,
    },
    // A
    {
      sql:
        `INSERT OR IGNORE INTO main."health_links" (${COLUMNS}) SELECT l."key", l."local_kind", ` +
        `CASE WHEN EXISTS (SELECT 1 FROM incoming."health_links" i WHERE i."local_kind" = l."local_kind" ` +
        `AND i."local_id" = l."local_id"${inScope}) THEN -1 ELSE l."local_id" END, ` +
        `l."remote_id", l."fingerprint", 'local' FROM ${LIVE} l ` +
        `WHERE l."origin" = 'local' ` +
        `AND NOT EXISTS (SELECT 1 FROM incoming."health_links" i WHERE i."key" = l."key"${inScope}) ` +
        `AND (l."fingerprint" = 'deleted' OR NOT EXISTS (SELECT 1 FROM incoming."health_links" i ` +
        `WHERE i."remote_id" = l."remote_id" AND i."remote_id" <> ''${inScope}))`,
    },
    // C
    {
      sql:
        `INSERT OR IGNORE INTO main."health_links" (${COLUMNS}) SELECT l."key", l."local_kind", -1, ` +
        `l."remote_id", l."fingerprint", 'health' FROM ${LIVE} l WHERE l."origin" = 'health' AND l."row_exists" = 0`,
    },
  ];
  // R: only where the restore keeps a known installation (another device's restore mints a fresh one, which no
  // link carries yet). The trailing digits of the key are the record id it names.
  const installation = restoredInstallation(ctx);
  if (installation) {
    const prefix = `${health.clientPrefix}:${installation}:`;
    const stem = `rtrim(l."key", '0123456789')`;
    after.push({
      sql:
        `UPDATE main."health_links" AS h SET "local_id" = c."n" FROM (SELECT min(k."key") AS "key", k."n" ` +
        `FROM (SELECT l."key", l."local_kind", CAST(substr(l."key", length(${stem}) + 1) AS INTEGER) AS "n" ` +
        `FROM main."health_links" l WHERE l."origin" = 'local' AND l."local_id" = -1${inScope} ` +
        `AND substr(l."key", 1, length(?)) = ? AND ${stem} <> l."key" ` +
        `AND substr(${stem}, -length(l."local_kind") - 2) = ':' || l."local_kind" || ':') k ` +
        `WHERE NOT EXISTS (SELECT 1 FROM main."health_links" o WHERE o."local_kind" = k."local_kind" ` +
        `AND o."local_id" = k."n") GROUP BY k."local_kind", k."n") AS c WHERE h."key" = c."key"`,
      params: [prefix, prefix],
    });
  }
  // D
  after.push({
    sql:
      `UPDATE main."health_links" AS h SET "fingerprint" = '' WHERE h."origin" = 'local'${inScope} ` +
      `AND h."fingerprint" NOT IN ('', 'deleted') AND h."remote_id" <> '' AND EXISTS (SELECT 1 ` +
      `FROM main."health_links" d WHERE d."origin" = 'local' AND d."fingerprint" = 'deleted' ` +
      `AND d."local_kind" = h."local_kind" AND d."remote_id" = h."remote_id")`,
  });
  return { before, after };
}

/** Where the provenance preference keys live (body, lift and macro: the key/value `preferences` table). */
export type PreferenceTable = { table: string; keyColumn: string; valueColumn: string };

const PREFERENCES: PreferenceTable = {
  table: "preferences",
  keyColumn: "key",
  valueColumn: "value",
};

/**
 * The installation rule of spec §5.2, as overrides appended after the descriptor's deviceOverrides:
 *   same device (v2): the archive's installation, or the live one when the archive has none;
 *   another device, another platform or a handoff (v2): ctx.freshInstallation (for records created from now on);
 *   legacy v1: the live installation (v1 files carry none);
 * and `healthInstallations` = the union of the archive's and the live list and installations, de-duplicated and
 * sorted, + "*" where the archive's own-app lineage is unknown: a legacy v1 file, and a v2 archive from another device
 * that names no installation (made before its device first synced with Health: whatever installation that device
 * wrote under afterwards, on a Health store this one may share, is in no list). Absent values are skipped; nothing is
 * written for an empty value.
 */
export function installationOverrides(
  ctx: RestoreContext,
  prefs: PreferenceTable = PREFERENCES
): VaultSql[] {
  const installation = restoredInstallation(ctx);
  const lineage = new Set<string>();
  for (const id of [
    ...ctx.incoming.healthInstallations,
    ctx.incoming.installation,
    ...ctx.live.healthInstallations,
    ctx.live.installation,
  ])
    if (id) lineage.add(id);
  if (ctx.legacy || (!ctx.sameDevice && !ctx.incoming.installation)) lineage.add("*");
  const upsert =
    `INSERT INTO ${q(prefs.table)} (${q(prefs.keyColumn)}, ${q(prefs.valueColumn)}) VALUES (?, ?) ` +
    `ON CONFLICT(${q(prefs.keyColumn)}) DO UPDATE SET ${q(prefs.valueColumn)} = excluded.${q(prefs.valueColumn)}`;
  const out: VaultSql[] = [];
  if (installation) out.push({ sql: upsert, params: ["installation", installation] });
  if (lineage.size)
    out.push({ sql: upsert, params: ["healthInstallations", JSON.stringify([...lineage].sort())] });
  return out;
}
