// The import screen's state machine (docs/vault.md, "Restore"; spec §8.5, §11.6) as a pure reducer, so
// tests/vault/ui-flow.cjs runs it in Node. The screen (ui/import-screen.tsx) renders the state; the module store in
// ui/use-vault.ts dispatches the events and runs the work they stand for (open, restore), so a running restore and
// its result outlive the screen. Types only from the engine; no React.
//
// start → reading (pick, incoming) → preview (opened) → confirm (restore) → restoring (confirmed) → done (restored)
// or error (failed); an empty library skips the confirmation. A legacy encrypted backup goes from reading to password
// (needPassword): unlock tries a password, wrongPassword stays there with an error, opened goes on to the preview.
// A file handed over while a restore runs is queued (`next`) and offered when the flow ends; at any other time it
// replaces the current flow.
import type { VaultErrorCode, VaultErrorInfo } from "../errors";
import type { Pending } from "../incoming";
import type { Preview, Progress, RestoreReason, RestoreResult, Step } from "../types";

export type ImportOrigin = Pending["origin"];

export type ImportState =
  | { s: "start" }
  | { s: "reading"; origin: ImportOrigin }
  /** A legacy encrypted backup: `error` after a wrong password, `unlocking` while it is tried. */
  | { s: "password"; origin: ImportOrigin; error: boolean; unlocking: boolean }
  /** `healthOn`: this device's Health sync is on now (the confirmation says a restore turns it off). */
  | { s: "preview"; origin: ImportOrigin; preview: Preview; healthOn: boolean }
  | { s: "confirm"; origin: ImportOrigin; preview: Preview; healthOn: boolean }
  | {
      s: "restoring";
      origin: ImportOrigin;
      preview: Preview;
      step: Step;
      /** 0–100 for steps that report done/total, else null. */
      percent: number | null;
      next: Pending | null;
    }
  | {
      s: "done";
      origin: ImportOrigin;
      preview: Preview;
      result: RestoreResult;
      next: Pending | null;
    }
  | {
      s: "error";
      /** null when the flow had no file yet (the picker failed). */
      origin: ImportOrigin | null;
      code: VaultErrorCode;
      /** Fills {size} and {other} (errorText in ui/labels.ts). */
      info: VaultErrorInfo;
      next: Pending | null;
    };

export type ImportEvent =
  | { e: "incoming"; pending: Pending }
  | { e: "pick" }
  | { e: "opened"; preview: Preview; healthOn?: boolean }
  | { e: "needPassword" }
  | { e: "wrongPassword" }
  | { e: "unlock" }
  | { e: "restore" }
  | { e: "cancel" }
  | { e: "confirmed" }
  | { e: "progress"; p: Progress }
  | { e: "restored"; result: RestoreResult }
  | { e: "failed"; code: VaultErrorCode; info?: VaultErrorInfo }
  | { e: "secondIncoming"; pending: Pending }
  | { e: "reset" };

export const initialImport: ImportState = { s: "start" };

/** Whether work is running for the current file: an open, a password being tried, a restore. */
export function importBusy(state: ImportState): boolean {
  return (
    state.s === "reading" || state.s === "restoring" || (state.s === "password" && state.unlocking)
  );
}

const tenth = (percent: number | null) => (percent === null ? -1 : Math.floor(percent / 10));

/** A progress report as a percentage (null for steps without done/total). */
export function progressPercent(p: Progress): number | null {
  if (!p.total || p.total <= 0 || p.done === undefined) return null;
  return Math.max(0, Math.min(100, Math.round((p.done * 100) / p.total)));
}

/** The first step a restore reports: a v1 backup has no data files to check. */
const firstStep = (preview: Preview): Step => (preview.format === "legacy" ? "scratch" : "verify");

function restoring(state: { origin: ImportOrigin; preview: Preview }): ImportState {
  return {
    s: "restoring",
    origin: state.origin,
    preview: state.preview,
    step: firstStep(state.preview),
    percent: null,
    next: null,
  };
}

/** The next state. Events that do not apply to the current state return it unchanged (the same object). */
export function importFlow(state: ImportState, event: ImportEvent): ImportState {
  switch (event.e) {
    case "incoming":
    case "secondIncoming":
      // A restore is never interrupted: the newest file waits until it ends.
      if (state.s === "restoring") return { ...state, next: event.pending };
      return { s: "reading", origin: event.pending.origin };
    case "pick":
      return importBusy(state) ? state : { s: "reading", origin: "file" };
    case "opened":
      if (state.s !== "reading" && state.s !== "password") return state;
      return {
        s: "preview",
        origin: state.origin,
        preview: event.preview,
        healthOn: event.healthOn ?? false,
      };
    case "needPassword":
    case "wrongPassword":
      if (state.s !== "reading" && state.s !== "password") return state;
      return {
        s: "password",
        origin: state.origin,
        error: event.e === "wrongPassword",
        unlocking: false,
      };
    case "unlock":
      if (state.s !== "password" || state.unlocking) return state;
      return { ...state, error: false, unlocking: true };
    case "restore":
      if (state.s !== "preview") return state;
      // Nothing to replace (spec §3.9): no recovery set, so no confirmation either.
      if (state.preview.liveEmpty) return restoring(state);
      return { ...state, s: "confirm" };
    case "cancel":
      return state.s === "confirm" ? { ...state, s: "preview" } : state;
    case "confirmed":
      return state.s === "confirm" ? restoring(state) : state;
    case "progress": {
      if (state.s !== "restoring") return state;
      const percent = progressPercent(event.p);
      // Throttled to step changes and every 10 % (ProcessLine is a polite live region).
      if (event.p.step === state.step && tenth(percent) === tenth(state.percent)) return state;
      return { ...state, step: event.p.step, percent };
    }
    case "restored":
      if (state.s !== "restoring") return state;
      return {
        s: "done",
        origin: state.origin,
        preview: state.preview,
        result: event.result,
        next: state.next,
      };
    case "failed": {
      if (state.s === "start" && event.code === "cancelled") return state;
      // The person stopped it: nothing to report (error_cancelled is never shown).
      if (event.code === "cancelled") return initialImport;
      return {
        s: "error",
        origin: state.s === "start" ? null : state.origin,
        code: event.code,
        info: event.info ?? {},
        next: "next" in state ? state.next : null,
      };
    }
    case "reset":
      return state.s === "start" ? state : initialImport;
  }
}

/** The restore reason of the flow's file (RestoreOptions.reason): a recovery set, or the v1 copy it stands for. */
export function restoreReason(origin: ImportOrigin, preview: Preview): RestoreReason {
  if (origin === "recovery") return preview.format === "legacy" ? "legacyRecovery" : "recovery";
  return origin;
}

/**
 * Records a restore removed or cleared because they pointed at missing data (the `restoredRepairs_*` note): the
 * foreign-key repairs, one per row (`fk:cascade`, `fk:set null`, `fk:set default`). Other repairs and non-fatal
 * validator findings are not counted.
 */
export function repairCount(result: RestoreResult): number {
  return result.repairs.filter((issue) => issue.message.startsWith("fk:")).length;
}

/**
 * A descriptor summary date (DescribeContext.date) as a Date: an ISO timestamp, a day ("YYYY-MM-DD", read at local
 * noon so no time zone moves it to the next or previous day) or epoch ms.
 */
export function summaryDate(value: string | number): Date {
  if (typeof value === "number") return new Date(value);
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 12) : new Date(value);
}
