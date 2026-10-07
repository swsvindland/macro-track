// Files waiting for the import screen (docs/vault.md, "Operations"; spec §8.4, §11.1): a file picked elsewhere, a
// recovery set from Settings and, from M2, a file opened from another app, a cloud download or a handoff. The import
// screen takes the pending file when it mounts, or when one arrives while it is open. Long file URIs stay here, not
// in route params. A leaf: it imports types only, so an app's +native-intent.tsx (M2), which expo-router evaluates
// early, never pulls in the vault's UI or engine. vaultIntent() arrives with M2.
import type { MediaSource } from "./types";

export type Pending = {
  /** file:// (or Android content://) URI of the archive or v1 backup. */
  uri: string;
  origin: "file" | "cloud" | "recovery" | "handoff";
  /** Where the photos the archive does not embed come from (a recovery set's folder, a cloud provider). */
  media?: MediaSource;
  /** origin "recovery": the recovery set's id, or "legacy" for a v1 pre-restore copy. */
  recoveryId?: string;
};

let pending: Pending | null = null;
const listeners = new Set<() => void>();

/** Hands a file to the import screen (the newest one wins) and tells an open import screen. */
export function setPendingIncoming(p: Pending): void {
  pending = p;
  for (const listener of [...listeners]) listener();
}

/** The waiting file, once: the import screen that takes it owns it. */
export function takePendingIncoming(): Pending | null {
  const p = pending;
  pending = null;
  return p;
}

/** Calls `listener` whenever a file is handed over; returns the unsubscriber. */
export function subscribeIncoming(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
