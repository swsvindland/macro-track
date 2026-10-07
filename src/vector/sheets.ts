/**
 * iOS sheets still sliding away (editor.tsx). UIKit ignores a present while another sheet is dismissing, and RN's
 * modal then stays mounted but invisible, so an Editor that opens meanwhile waits for these: its Modal's
 * onDismiss settles one early, and the slide time settles one that unmounted (its onDismiss never comes).
 * Pure module-level state, so tests load it without React Native.
 */
export const SLIDE_MS = 600;

const leaving = new Map<string, { timer: ReturnType<typeof setTimeout>; done?: () => void }>();
const waiting = new Set<() => void>();

/** The sheet `id` is off screen: runs its `done` once and, when it was the last, every waiting open. */
export function settle(id: string) {
  const sheet = leaving.get(id);
  if (!sheet) return;
  clearTimeout(sheet.timer);
  leaving.delete(id);
  sheet.done?.();
  if (leaving.size) return;
  // A copy: each `go` is deleted from the set while it is iterated.
  for (const go of Array.from(waiting)) {
    waiting.delete(go);
    go();
  }
}

/** The sheet `id` started sliding away; `done` runs when it settles (onDismiss or `ms`, whichever comes first). */
export function leave(id: string, done?: () => void, ms: number = SLIDE_MS) {
  settle(id);
  leaving.set(id, { timer: setTimeout(() => settle(id), ms), done });
}

/** Runs `go` once no sheet is leaving (at once when none is); returns the cancel while it waits. */
export function afterLeaving(go: () => void): (() => void) | undefined {
  if (!leaving.size) {
    go();
    return undefined;
  }
  waiting.add(go);
  return () => {
    waiting.delete(go);
  };
}
