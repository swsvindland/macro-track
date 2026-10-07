// Change source for the M3 change counters (docs/vault.md, "What the vault keeps in the database"): a write made
// inside asChangeSource("health", …) counts as a backup change (`gen`) but not as a user change (`seq`), so two
// devices importing the same scale reading never look diverged. A leaf with no imports: apps call it from
// src/lib/health.ts without loading any other vault code.

/**
 * Runs `work` with `_vault_clock.source` set, through `exec` (the app's SQL runner inside its own synchronous
 * transaction, so a crash can never leave `source` set). No-op before M3 and in tests: without the clock table the
 * two updates fail and are ignored.
 */
export function asChangeSource<T>(
  source: "health" | "auto",
  exec: (sql: string) => void,
  work: () => T
): T {
  const set = (value: string) => {
    try {
      exec(`UPDATE "_vault_clock" SET "source" = ${value} WHERE "id" = 1`);
    } catch {
      // no clock table yet
    }
  };
  set(`'${source}'`);
  try {
    return work();
  } finally {
    set("NULL");
  }
}
