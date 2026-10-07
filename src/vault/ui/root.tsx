// <VaultRoot /> (docs/vault.md, "Operations"; spec §7.2, §11.2): rendered once by each app's root layout, after the
// database is migrated and inside every provider the app's useVaultRefresh() reads. On mount it starts the vault —
// device facts, then under the lock crash recovery, the device and library ids and the sync ids — and reads the
// status Settings shows. M2 adds the automatic backup's lifecycle here, M3 hosts the handoff sheet.
import { useEffect } from "react";

import { startVault } from "../ops";

import { refreshVaultStatus } from "./use-vault";

export function VaultRoot() {
  useEffect(() => {
    // startVault never throws: a failure is logged and every entry point runs ensureReady again.
    void startVault().then(refreshVaultStatus);
  }, []);
  return null;
}
