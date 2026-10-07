import Constants from "expo-constants";
import { eq, gte } from "drizzle-orm";
import { db, foodEntries, healthLinks, measurements, preferences, weightEntries } from "@/db";
import { getHealthAdapter } from "./health-native";
import type { HealthAdapter, HealthKind, HealthRecord } from "./health-types";
import { validDay, dayOf, localDay } from "./metrics";

/** Bumped when sync asks for new data types, so Settings can offer to ask again. */
export const HEALTH_PERMISSIONS = "3";
// Untimed entries are written at a representative time for their meal.
const mealTimes = { Breakfast: "08:00", Lunch: "12:00", Dinner: "18:00", Snacks: "15:00" };

let running = false;
let maintenance = false;
let foodPending = false;
const pref = (key: string) =>
  db.select().from(preferences).where(eq(preferences.key, key)).get()?.value;
const setPref = (key: string, value: string) => {
  db.insert(preferences)
    .values({ key, value })
    .onConflictDoUpdate({ target: preferences.key, set: { value } })
    .run();
};
export async function withHealthPaused<T>(work: () => Promise<T>): Promise<T> {
  if (running || maintenance)
    throw new Error("Wait for health sync to finish, then try restoring again.");
  maintenance = true;
  try {
    return await work();
  } finally {
    maintenance = false;
  }
}

/**
 * For the vault's restores: waits up to `timeoutMs` for a running sync to finish, then holds
 * syncs off while `work` runs. The hold starts in the tick that sees sync idle, so none can
 * start in between; past the wait it throws and nothing runs.
 */
export async function pauseWhenIdle<T>(work: () => Promise<T>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (running || maintenance) {
    if (Date.now() >= deadline) throw new Error("syncing");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  maintenance = true;
  try {
    return await work();
  } finally {
    maintenance = false;
  }
}

/** `healthInstallations`: a JSON list of installation ids; anything unreadable counts as empty. */
function installations(value: string | undefined): string[] {
  try {
    const list: unknown = JSON.parse(value ?? "[]");
    return Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}
/** A reading's value and time as Health stores them, rounded so both platforms agree. */
const reading = (value: number, measuredAt: string) =>
  `${Math.round(value * 100)}:${Math.floor(Date.parse(measuredAt) / 1000)}`;
/** The reading a `<value>:<measuredAt>` fingerprint describes (none for a tombstone). */
function linkedReading(fingerprint: string) {
  const at = fingerprint.indexOf(":");
  return at < 0 ? null : reading(Number(fingerprint.slice(0, at)), fingerprint.slice(at + 1));
}

/**
 * "food" only writes the diary, for running right after a diary change; "all" also exchanges
 * body measurements and reads the profile.
 */
export async function syncHealth(
  adapter?: HealthAdapter,
  interactive = true,
  scope: "all" | "food" = "all"
) {
  if (running || maintenance) {
    // A diary change during a full sync is written as soon as that sync ends.
    if (scope === "food") foodPending = true;
    throw new Error("syncing");
  }
  if (!adapter && Constants.appOwnership === "expo") throw new Error("healthUnavailable");
  running = true;
  try {
    let provider: HealthAdapter;
    try {
      provider = adapter ?? (await getHealthAdapter());
    } catch {
      throw new Error("healthUnavailable");
    }
    const access = await provider.authorize(interactive);
    if (scope === "all" && !access.read.includes("weight")) throw new Error("healthWeightDenied");
    if (interactive) setPref("healthPermissions", HEALTH_PERMISSIONS);
    let installation = pref("installation");
    if (!installation) {
      installation = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setPref("installation", installation);
    }
    const prefix = `macro-track:${installation}:`;
    // Every installation this data was written under (restores and erase keep the list): their
    // samples are this app's own, never imported as outside readings. "*" stands for all.
    const known = new Set(installations(pref("healthInstallations")));
    if (!known.has(installation)) {
      known.add(installation);
      setPref("healthInstallations", JSON.stringify([...known].sort()));
    }
    const ownClient = (clientId?: string) =>
      !!clientId &&
      (known.has("*")
        ? clientId.startsWith("macro-track:")
        : [...known].some((id) => clientId.startsWith(`macro-track:${id}:`)));
    foodPending = false;
    if (scope === "food")
      return { imported: 0, exported: await exportFood(provider, access, prefix) };
    // Denied kinds are skipped, not failed, so optional exports never block weight imports.
    const writable = new Set(access.write);
    const weightEpoch = pref("weightSyncEpoch");
    // Restored local IDs must never overwrite unrelated pre-restore health records.
    const weightPrefix = weightEpoch ? `${prefix}restored-${weightEpoch}:` : prefix;
    let imported = 0;
    let exported = 0;
    const localRecords = () => [
      ...db
        .select()
        .from(weightEntries)
        .all()
        // An ignored reading stays out of Health; one already written is removed like a deletion.
        .filter((w) => !w.excluded)
        .map((w) => ({
          id: w.id,
          kind: "weight" as const,
          value: w.weightKg,
          measuredAt: w.measuredAt,
          version: w.updatedAt?.getTime() ?? w.createdAt?.getTime() ?? 1,
        })),
      ...db
        .select()
        .from(measurements)
        .all()
        .filter((m) => m.kind === "height")
        .map((m) => ({
          id: m.id,
          kind: "height" as const,
          value: m.values.height,
          measuredAt: m.measuredAt,
          version: m.updatedAt,
        })),
      ...db
        .select()
        .from(measurements)
        .all()
        .filter((m) => m.kind === "body")
        .flatMap((m) =>
          (["waist", "bodyFat"] as const).flatMap((kind) => {
            const value = m.values[kind];
            return Number.isFinite(value) && value > 0 && value <= (kind === "bodyFat" ? 74.9 : 300)
              ? [{ id: m.id, kind, value, measuredAt: m.measuredAt, version: m.updatedAt }]
              : [];
          })
        ),
    ];
    const fingerprint = (record: { value: number; measuredAt: string }) =>
      `${record.value}:${record.measuredAt}`;
    const links = db.select().from(healthLinks).all();
    // Export before import. Persist each mapping immediately, so partial failures are safely retried.
    for (const record of localRecords()) {
      if (
        !writable.has(record.kind) ||
        links.some(
          (l) => l.localKind === record.kind && l.localId === record.id && l.origin === "health"
        )
      )
        continue;
      // A record keeps the key it was first written under, also when a restore brought it from
      // another installation, so Health replaces that sample instead of gaining a second one.
      const mine = links.filter(
        (l) =>
          l.origin === "local" &&
          l.localKind === record.kind &&
          l.localId === record.id &&
          l.localId >= 0
      );
      const link = mine.find((l) => l.fingerprint !== "deleted") ?? mine[0];
      const key =
        link?.key ??
        `${record.kind === "weight" ? weightPrefix : prefix}${record.kind}:${record.id}`;
      const hash = fingerprint(record);
      if (link?.fingerprint === hash) continue;
      const remoteId = await provider.write({
        ...record,
        clientId: key,
        version: Math.max(record.version, Date.now()),
      });
      db.insert(healthLinks)
        .values({
          key,
          localKind: record.kind,
          localId: record.id,
          remoteId,
          fingerprint: hash,
          origin: "local",
        })
        .onConflictDoUpdate({ target: healthLinks.key, set: { remoteId, fingerprint: hash } })
        .run();
      exported++;
    }
    const current = localRecords();
    // A row a restore turned into a Health import (local ids start at 1 on every phone) is not
    // the record this app wrote under that link: the import is never exported, so the old sample
    // goes like a deleted record's, instead of staying in Health with nothing behind it.
    const importRows = new Set(
      links.filter((l) => l.origin === "health").map((l) => `${l.localKind}:${l.localId}`)
    );
    for (const link of links.filter((l) => l.origin === "local" && l.fingerprint !== "deleted")) {
      if (link.localKind === "food" || !writable.has(link.localKind as HealthKind)) continue;
      if (
        importRows.has(`${link.localKind}:${link.localId}`) ||
        !current.some((r) => r.kind === link.localKind && r.id === link.localId)
      ) {
        // A restore from the other platform clears the remote id; the key still names the sample.
        await provider.remove(link.localKind as HealthKind, link.remoteId, link.key);
        db.update(healthLinks)
          .set({ fingerprint: "deleted" })
          .where(eq(healthLinks.key, link.key))
          .run();
      }
    }
    exported += await exportFood(provider, access, prefix);
    await readProfile(provider);
    const external = await provider.read(access.read);
    // Readings already imported, by kind, value and time: the same reading under another sample id
    // (Health re-issued it, or a restore came from the other platform) links to the row, or to the
    // deletion, it already has instead of arriving twice.
    const readings = new Map<string, number>();
    const remember = (kind: string, hash: string, localId: number) => {
      const at = linkedReading(hash);
      if (at && !readings.has(`${kind}|${at}`)) readings.set(`${kind}|${at}`, localId);
    };
    for (const l of links)
      if (l.origin === "health") remember(l.localKind, l.fingerprint, l.localId);
    for (const record of external) {
      // Body measurements are export-only; never turn them into height imports.
      if (record.kind !== "weight" && record.kind !== "height") continue;
      if (ownClient(record.clientId) || !validHealthRecord(record)) continue;
      const key = `health:${record.kind}:${record.id}`;
      const link = db.select().from(healthLinks).where(eq(healthLinks.key, key)).get();
      const hash = fingerprint(record);
      if (link?.fingerprint === hash) continue;
      const twin = link
        ? undefined
        : readings.get(`${record.kind}|${reading(record.value, record.measuredAt)}`);
      if (twin !== undefined) {
        db.insert(healthLinks)
          .values({
            key,
            localKind: record.kind,
            localId: twin,
            remoteId: record.id,
            fingerprint: hash,
            origin: "health",
          })
          .onConflictDoNothing()
          .run();
        continue;
      }
      const rowId = db.transaction((tx) => {
        let localId = link?.localId;
        if (record.kind === "weight") {
          if (link)
            tx.update(weightEntries)
              .set({ weightKg: record.value, measuredAt: record.measuredAt, updatedAt: new Date() })
              .where(eq(weightEntries.id, link.localId))
              .run();
          else
            localId = tx
              .insert(weightEntries)
              .values({ weightKg: record.value, measuredAt: record.measuredAt })
              .returning()
              .get().id;
        } else {
          const data = {
            kind: "height" as const,
            measuredAt: record.measuredAt,
            values: { height: record.value },
            updatedAt: Date.now(),
          };
          if (link)
            tx.update(measurements).set(data).where(eq(measurements.id, link.localId)).run();
          else localId = tx.insert(measurements).values(data).returning().get().id;
        }
        tx.insert(healthLinks)
          .values({
            key,
            localKind: record.kind,
            localId: localId!,
            remoteId: record.id,
            fingerprint: hash,
            origin: "health",
          })
          .onConflictDoUpdate({ target: healthLinks.key, set: { fingerprint: hash } })
          .run();
        return localId!;
      });
      if (!link) remember(record.kind, hash, rowId);
      imported++;
    }
    setPref("lastSync", new Date().toISOString());
    return { imported, exported };
  } finally {
    running = false;
    if (foodPending && !maintenance) {
      foodPending = false;
      void syncHealth(adapter, false, "food").catch(() => {});
    }
  }
}

/**
 * Writes diary entries from 30 days before the first food sync onward, rewrites edited or
 * moved ones, and removes deleted ones. Each written entry is linked, so a retry resumes.
 */
async function exportFood(
  provider: HealthAdapter,
  access: { write: readonly string[] },
  prefix: string
) {
  if (!access.write.includes("food") || !provider.writeFood || !provider.removeFood) return 0;
  let since = pref("healthFoodSince");
  if (!since) {
    since = localDay(new Date(Date.now() - 30 * 86400000));
    setPref("healthFoodSince", since);
  }
  const entries = db.select().from(foodEntries).where(gte(foodEntries.day, since)).all();
  // Every food link this app wrote, under any installation: an entry a restore brought keeps its
  // key, and the removal below reaches it too.
  const links = db
    .select()
    .from(healthLinks)
    .where(eq(healthLinks.localKind, "food"))
    .all()
    .filter((link) => link.origin === "local");
  let exported = 0;
  for (const entry of entries) {
    const mine = links.filter((l) => l.localId === entry.id);
    const link = mine.find((l) => l.fingerprint !== "deleted") ?? mine[0];
    const key = link?.key ?? `${prefix}food:${entry.id}`;
    const time = entry.loggedTime ?? mealTimes[entry.meal];
    const food = {
      name: entry.food.name,
      meal: entry.meal,
      eatenAt: new Date(`${entry.day}T${time}:00`).toISOString(),
      nutrients: entry.nutrients,
    };
    const hash = JSON.stringify([food.name, food.meal, food.eatenAt, food.nutrients]);
    if (link?.fingerprint === hash) continue;
    const remoteId = await provider.writeFood({
      ...food,
      clientId: key,
      version: Date.now(),
      replacing: !!link && link.fingerprint !== "deleted",
    });
    db.insert(healthLinks)
      .values({
        key,
        localKind: "food",
        localId: entry.id,
        remoteId,
        fingerprint: hash,
        origin: "local",
      })
      .onConflictDoUpdate({ target: healthLinks.key, set: { remoteId, fingerprint: hash } })
      .run();
    exported++;
  }
  // Moved before the window counts as gone, so Health mirrors exactly what is exported.
  const current = new Set(entries.map((entry) => entry.id));
  for (const link of links) {
    if (link.fingerprint === "deleted" || current.has(link.localId)) continue;
    await provider.removeFood(link.key, link.remoteId);
    db.update(healthLinks)
      .set({ fingerprint: "deleted" })
      .where(eq(healthLinks.key, link.key))
      .run();
  }
  return exported;
}

/** Keeps birth date and sex for prefilling the program; never fails a sync. */
async function readProfile(provider: HealthAdapter) {
  try {
    const profile = await provider.profile?.();
    if (profile?.birthDate && validDay(profile.birthDate))
      setPref("healthBirthDate", profile.birthDate);
    if (profile?.sex) setPref("healthSex", profile.sex);
  } catch {
    /* The profile is only a convenience. */
  }
}
export function validHealthRecord(record: HealthRecord) {
  return (
    Number.isFinite(record.value) &&
    record.value > 0 &&
    record.value <= (record.kind === "weight" ? 500 : 300) &&
    Number.isFinite(Date.parse(record.measuredAt)) &&
    validDay(dayOf(record.measuredAt))
  );
}
