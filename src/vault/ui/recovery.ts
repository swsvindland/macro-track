// The Settings row "Restore data from before {date}" (docs/vault.md, "Recovery sets and the crash journal"; spec
// §3.9, §11.3): which recovery set it offers, and opening that set in the import screen, which reads it through
// runOpen like any file — a v1 pre-restore copy included, with its password prompt when it is encrypted.
import { LEGACY_RECOVERY, recoveryFile, recoveryMedia } from "../engine/recovery";
import { setPendingIncoming } from "../incoming";
import type { RecoveryInfo, VaultStatus } from "../types";

import { goVault } from "./nav";
import { refreshVaultStatus } from "./use-vault";

/**
 * The recovery set Settings offers. M1: the newest complete set (or lift's and macro's v1 copy) whenever one exists.
 * From M2 (T2.6) the Settings row shows for 7 days after `now`, and the backup screen's card for as long as it exists.
 */
export function visibleRecovery(
  status: Pick<VaultStatus, "latestRecovery">,
  now: number
): RecoveryInfo | null {
  return status.latestRecovery;
}

/** When a recovery set was made (ISO), read from its id `<yyyyMMdd>T<HHmmss>Z-…`; null for any other id. */
export function recoveryCreatedAt(id: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/.exec(id);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s)).toISOString();
}

/** A recovery set being looked up: a second tap meanwhile opens nothing more. */
let opening = false;

/**
 * Hands the set's archive to the import screen (origin "recovery", with the set's photos as its media) and opens
 * it. A set that is gone meanwhile is not opened; Settings then re-reads what it offers. Never throws.
 */
export async function openRecoveryFlow(id: string): Promise<boolean> {
  if (opening) return false;
  opening = true;
  try {
    const file = await recoveryFile(id);
    if (file) {
      setPendingIncoming({
        uri: file.uri,
        origin: "recovery",
        media: id === LEGACY_RECOVERY ? undefined : recoveryMedia(id),
        recoveryId: id,
      });
      goVault("import");
      return true;
    }
  } catch (e) {
    console.warn("[vault]", "openRecoveryFlow", e);
  } finally {
    opening = false;
  }
  void refreshVaultStatus();
  return false;
}
