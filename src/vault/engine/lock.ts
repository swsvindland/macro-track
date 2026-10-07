// The vault's process-wide lock (docs/vault.md, "Operations"): one vault operation at a time. The UI and a headless
// background task share one JS runtime, so an in-memory mutex covers both. A plain mutex that imports no app code;
// restore.ts composes the Health pause around its work. Never nest exclusive() calls: engine functions are lock-free
// and only the entry points in ops.ts and cloud/backup.ts take the lock.
import { VaultError } from "../errors";

export type OpKind =
  "export" | "restore" | "autoBackup" | "inspect" | "handoffCheck" | "recover" | "selftest";

let holder: OpKind | null = null;
const queue: { kind: OpKind; start: () => void }[] = [];
const listeners = new Set<() => void>();

function notify() {
  for (const listener of [...listeners]) listener();
}

/** The operation holding the lock, or null when it is free. */
export function busyWith(): OpKind | null {
  return holder;
}

/** Calls `listener` whenever the lock is taken or freed (UI "running" state); returns the unsubscriber. */
export function subscribeLock(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function release() {
  const next = queue.shift();
  if (next) next.start();
  else {
    holder = null;
    notify();
  }
}

/**
 * Runs `work` while holding the lock. wait=false (scheduled runs): rejects with VaultError("busy") at once when the
 * lock is held. wait=true (UI actions): queues behind the current and earlier waiting operations, in order. The lock
 * is released before the returned promise settles, so the caller can start the next operation right away.
 */
export function exclusive<T>(
  kind: OpKind,
  work: () => Promise<T>,
  options: { wait: boolean }
): Promise<T> {
  if (holder !== null && !options.wait)
    return Promise.reject(new VaultError("busy", { detail: holder }));
  return new Promise<T>((resolve, reject) => {
    const run = async () => {
      try {
        return await work();
      } finally {
        release();
      }
    };
    const start = () => {
      if (holder !== kind) {
        holder = kind;
        notify();
      }
      run().then(resolve, reject);
    };
    if (holder === null) start();
    else queue.push({ kind, start });
  });
}
