// The erase hook (docs/vault.md, "Erase"; spec §5.7, §9.7). lift's and macro's "Erase all data" deletes every
// preference, Health's lineage list included, so re-enabling Health would import the erased records again as other
// apps' readings. Their data panels therefore call captureBeforeErase() before eraseLocalData() and
// onLocalDataErased(token) after it: the lineage is written back, recovery sets and work files are deleted (never the
// device anchor), the library gets a new id (the old one is remembered in `library.erased`), lineage is reset and
// automatic cloud backup is turned off on this device (cloud copies stay). Neither needs the native module: where it
// is absent (Expo Go, a build from before the vault's prebuild) the app has already erased its data, so nothing here
// may fail; only the new library id waits for the next start with the module (ensureLibrary mints it).
import { Directory } from "expo-file-system";

import { vaultNative, vaultSupported } from "../native";
import type { EraseToken } from "../types";

import { q } from "./db";
import { journalClearSync, readJournal } from "./journal";
import { exclusive } from "./lock";
import { cacheDir, engineEnv, isLiveOp, recoveryRoot, removeDir, workRoot } from "./paths";
import { installationPreferences, provenanceOf } from "./scratch";
import { transactionSync } from "./sid";
import { readClock } from "./snapshot";
import {
  deleteStatePrefixSync,
  deleteStateSync,
  readState,
  refreshVaultState,
  setStateSync,
} from "./state";

/** The Health lineage to keep through an erase: `healthInstallations` ∪ `installation`, read on the live database. */
export async function captureBeforeErase(): Promise<EraseToken> {
  const env = engineEnv();
  const db = await env.acquire();
  try {
    const { installation, healthInstallations } = provenanceOf(db);
    const lineage = new Set(healthInstallations);
    if (installation) lineage.add(installation);
    return { healthInstallations: [...lineage].sort() };
  } finally {
    await env.release(db);
  }
}

/** A JSON array of strings from `_vault_state`; anything else counts as empty. */
function idList(text: string | null): string[] {
  try {
    const value: unknown = JSON.parse(text ?? "[]");
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/**
 * After the app erased its data (spec §9.7). Takes the vault lock: no restore or backup runs meanwhile. Without the
 * native module it still writes the lineage back and resets the vault's state; `library.id` is then removed instead
 * of replaced, and the next ensureReady with the module starts the new library.
 */
export async function onLocalDataErased(token: EraseToken): Promise<void> {
  await exclusive(
    "restore",
    async () => {
      const env = engineEnv();
      const db = await env.acquire();
      try {
        // A restore the erase supersedes: its recovery set and staged files go below.
        const journal = readJournal();
        if (journal && !isLiveOp(journal.op)) journalClearSync();
        removeDir(recoveryRoot());
        const work = workRoot();
        if (work.exists)
          for (const entry of work.list())
            if (!(entry instanceof Directory) || !isLiveOp(entry.name)) entry.delete();
        removeDir(cacheDir());

        const erased = new Set(idList(readState(db, "library.erased")));
        const current = readState(db, "library.id");
        if (current) erased.add(current);
        const prefs = installationPreferences();
        const library = vaultSupported ? vaultNative().randomUUID() : null;
        transactionSync(db, () => {
          deleteStateSync(db, "recovery.latest");
          setStateSync(db, "library.erased", JSON.stringify([...erased]));
          if (library) setStateSync(db, "library.id", library);
          else deleteStateSync(db, "library.id");
          setStateSync(db, "lineage.vector", "{}");
          setStateSync(db, "lineage.ownBase", String(readClock(db).seq));
          deleteStateSync(db, "lineage.adoptedFrom");
          // Automatic backup off on this device; the connections and the cloud copies stay.
          setStateSync(db, "icloud.enabled", "0");
          setStateSync(db, "gdrive.enabled", "0");
          deleteStatePrefixSync(db, "cloud.");
          setStateSync(db, "handoff.ack", "{}");
          deleteStateSync(db, "handoff.candidate");
          // The erased library is offered a restore again (spec §9.6).
          setStateSync(db, "handoff.emptyOffered", "0");
          if (prefs && token.healthInstallations.length) {
            const { table, keyColumn, valueColumn } = prefs;
            db.runSync(
              `INSERT INTO ${q(table)} (${q(keyColumn)}, ${q(valueColumn)}) VALUES (?, ?) ` +
                `ON CONFLICT(${q(keyColumn)}) DO UPDATE SET ${q(valueColumn)} = excluded.${q(valueColumn)}`,
              [
                "healthInstallations",
                JSON.stringify([...new Set(token.healthInstallations)].sort()),
              ]
            );
          }
        });
        refreshVaultState(db);
        // M2: configureVaultTask() unregisters the automatic backup task here (cloud/task.ts).
      } finally {
        await env.release(db);
      }
    },
    { wait: true }
  );
}
