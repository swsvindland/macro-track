// Device and library identity (docs/vault.md, "Identity"; spec §9.1, §9.2). The device id names this install of the
// app on this device. It lives in `_vault_state`, inside the database, so it travels with OS backups and device
// transfers, and in the device anchor PendumVault/device.json, which never does (excluded from iOS backup, named in
// no Android backup rule, never deleted by cleanup). A database whose id the anchor does not confirm therefore
// arrived through an iCloud or iTunes restore, Quick Start, an Android Auto Backup reinstall or a device-to-device
// transfer: a clone, which takes a new id so one (device id, seq) pair never names two different states. The library
// id names a dataset lineage: restores join the archive's library, an erase starts a new one.
import { File } from "expo-file-system";

import { vaultApp } from "../app";
import { vaultNative } from "../native";
import type { DeviceInfo, RestoreContext, SqlReader, VaultSql } from "../types";

import { q, tableExists, type SqlHandle } from "./db";
import { anchorFile, ensureDir, vaultDir } from "./paths";
import { installationOverrides, type PreferenceTable } from "./provenance";
import { transactionSync } from "./sid";
import { currentVector, readClock } from "./snapshot";
import {
  deleteStatePrefixSync,
  readState,
  refreshVaultState,
  setStateSync,
  updateState,
} from "./state";

/** PendumVault/device.json */
export type DeviceAnchor = { deviceId: string; createdAt: string };

/** What ensureDevice found. */
export type DeviceCheck = {
  deviceId: string;
  /** created: first start (or a database from before the vault); clone: see above; same: the anchor confirmed it. */
  outcome: "created" | "clone" | "same";
  /** clone: the id the database carried, now `device.supersedes`. */
  supersedes: string | null;
};

/** The anchor, or null when it is missing or unreadable (both mean: this database's id is not confirmed here). */
export function readAnchor(): DeviceAnchor | null {
  const file = anchorFile();
  if (!file.exists) return null;
  try {
    const value: unknown = JSON.parse(file.textSync());
    if (typeof value === "object" && value !== null) {
      const { deviceId, createdAt } = value as Record<string, unknown>;
      if (typeof deviceId === "string" && deviceId && typeof createdAt === "string")
        return { deviceId, createdAt };
    }
  } catch {
    // treated as missing
  }
  return null;
}

/** Writes the anchor atomically: a temporary file moved over the old one. */
function writeAnchor(anchor: DeviceAnchor): void {
  const temp = new File(ensureDir(vaultDir()), "device.json.tmp");
  temp.create({ overwrite: true });
  temp.write(`${JSON.stringify(anchor)}\n`);
  temp.moveSync(anchorFile(), { overwrite: true });
}

/** A new Health installation id, in the apps' own format: `${Date.now()}-${base36 random}`. */
export function freshInstallation(now = new Date()): string {
  return `${now.getTime()}-${Math.random().toString(36).slice(2)}`;
}

/** The key/value table holding the Health installation keys (body, lift, macro: `preferences`), if any. */
function installationTable(): PreferenceTable | null {
  const table = vaultApp.tables.find(
    (t) => t.mode === "keys" && t.keys?.include.includes("installation")
  );
  return table?.keys
    ? { table: table.name, keyColumn: table.keys.keyColumn, valueColumn: table.keys.valueColumn }
    : null;
}

/** This device's `installation` and `healthInstallations` (a JSON array; anything else counts as empty). */
function installations(db: SqlReader, prefs: PreferenceTable): RestoreContext["live"] {
  const read = (key: string) =>
    db.getFirstSync<{ v: string | null }>(
      `SELECT ${q(prefs.valueColumn)} AS v FROM ${q(prefs.table)} WHERE ${q(prefs.keyColumn)} = ?`,
      [key]
    )?.v ?? null;
  let list: unknown = [];
  try {
    list = JSON.parse(read("healthInstallations") ?? "[]");
  } catch {
    // the app wrote something else: no lineage
  }
  return {
    installation: read("installation") || null,
    healthInstallations: Array.isArray(list)
      ? list.filter((id): id is string => typeof id === "string" && id !== "")
      : [],
  };
}

/**
 * Health after a clone (body, lift, macro): the installation is rotated exactly as for a restore made on another
 * device (a fresh installation for records created from now on, the old one into `healthInstallations`), and on
 * Android the other-device provenance SQL of the descriptor (`prepareScratch`, same platform) runs on the live data:
 * Health Connect stays on the old phone, and the cloned links' fingerprints would otherwise keep this phone's store
 * empty. Nothing to rotate before Health was first enabled (no installation yet).
 */
function cloneHealth(db: SqlReader, info: Pick<DeviceInfo, "platform">, now: Date): VaultSql[] {
  const prefs = installationTable();
  if (!vaultApp.health || !prefs || !tableExists(db, prefs.table)) return [];
  const live = installations(db, prefs);
  if (!live.installation) return [];
  const ctx: RestoreContext = {
    // A clone is another device's whole database arriving here; the descriptor contract has no reason of its own.
    reason: "handoff",
    legacy: false,
    crossPlatform: false,
    sameDevice: false,
    healthWasOn: vaultApp.healthEnabledSql
      ? !!db.getFirstSync<{ v: unknown }>(vaultApp.healthEnabledSql)?.v
      : false,
    platform: info.platform,
    now,
    live,
    incoming: live,
    freshInstallation: freshInstallation(now),
  };
  return [
    ...(info.platform === "android" ? (vaultApp.prepareScratch?.(ctx) ?? []) : []),
    ...installationOverrides(ctx, prefs),
  ];
}

/**
 * Confirms or creates this device's id (spec §9.1), inside the vault lock at every start (ensureReady), before any
 * export: no device id yet → create id, anchor and fingerprint; the anchor missing or naming another id → clone;
 * stored and current fingerprints both known and different → clone; otherwise the same device, and a known current
 * fingerprint is stored (an IDFV that was nil before the first unlock never retires the id). `info` is
 * loadDeviceInfo(). The anchor is written before the database, so an interruption only ever repeats this step.
 */
export function ensureDevice(
  db: SqlHandle,
  info: Pick<DeviceInfo, "platform" | "fingerprint">,
  now = new Date()
): DeviceCheck {
  const id = readState(db, "device.id");
  const fingerprint = info.fingerprint ?? "";
  const anchor = readAnchor();
  if (id) {
    const stored = readState(db, "device.fingerprint") ?? "";
    const confirmed = anchor?.deviceId === id && !(stored && fingerprint && stored !== fingerprint);
    if (confirmed) {
      if (fingerprint && fingerprint !== stored)
        updateState(db, { "device.fingerprint": fingerprint });
      return { deviceId: id, outcome: "same", supersedes: null };
    }
  }

  const deviceId = vaultNative().randomUUID();
  const createdAt = now.toISOString();
  const health = id ? cloneHealth(db, info, now) : [];
  writeAnchor({ deviceId, createdAt });
  transactionSync(db, () => {
    setStateSync(db, "device.id", deviceId);
    setStateSync(db, "device.fingerprint", fingerprint);
    setStateSync(db, "device.createdAt", createdAt);
    if (!id) return;
    // Clone: the state here includes the old device's changes up to its seq; this device counts from there.
    const { seq } = readClock(db);
    setStateSync(db, "lineage.vector", JSON.stringify(currentVector(db, id, seq)));
    setStateSync(db, "lineage.ownBase", String(seq));
    setStateSync(db, "device.supersedes", id);
    // The new id has no remote snapshots yet, so the next automatic run uploads. Connections and toggles stay.
    deleteStatePrefixSync(db, "cloud.");
    for (const s of health) db.runSync(s.sql, s.params ?? []);
  });
  refreshVaultState(db);
  return { deviceId, outcome: id ? "clone" : "created", supersedes: id };
}

/** This database's library id (spec §9.2), created on the first start; restores and erase change it later. */
export function ensureLibrary(db: SqlHandle): string {
  const id = readState(db, "library.id");
  if (id) return id;
  const libraryId = vaultNative().randomUUID();
  updateState(db, { "library.id": libraryId });
  return libraryId;
}

/**
 * Whether the library holds no user records: the descriptor's `emptySql`, or every `role: "data"` table empty. A
 * fresh install, an erased library and a library holding only rows the app writes by itself (water's counters row
 * and drink tombstones, lift's default gym) are empty. The only emptiness test of the vault (recovery-set skip,
 * confirm skip, the auto-backup empty guard, the handoff offer); engine/ready.ts re-exports it.
 */
export function libraryEmpty(db: SqlReader): boolean {
  let sql = vaultApp.emptySql;
  if (!sql) {
    const data = vaultApp.tables.filter((t) => t.role === "data" && tableExists(db, t.name));
    sql = data.length
      ? `SELECT ${data.map((t) => `NOT EXISTS (SELECT 1 FROM ${q(t.name)})`).join(" AND ")} AS v`
      : "SELECT 1 AS v";
  }
  return !!db.getFirstSync<{ v: unknown }>(sql)?.v;
}
