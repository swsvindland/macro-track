import { createContext, useContext, useEffect } from "react";

/** What a link can open on Home: macrotrack://log, scan, photo or weigh-in. */
export type AppAction = "log" | "scan" | "photo" | "weigh-in";
const actions: readonly string[] = ["log", "scan", "photo", "weigh-in"];

/** The action a link asks for, or null. Accepts trailing slashes, a query and dev-build URLs. */
export function parseAppAction(url: string | null | undefined): AppAction | null {
  let link = url?.trim() ?? "";
  // A dev build wraps the link: exp+macro-track://expo-development-client/?url=…
  if (/^[^:/?#]+:\/\/expo-development-client\b/i.test(link)) {
    const inner = /[?&]url=([^&#]*)/.exec(link)?.[1];
    try {
      return inner ? parseAppAction(decodeURIComponent(inner)) : null;
    } catch {
      return null;
    }
  }
  const dashes = link.indexOf("/--/");
  // Expo Go and Metro URLs put the path after /--/; web links keep it after the host.
  if (dashes >= 0) link = link.slice(dashes + 3);
  else if (/^https?:\/\//i.test(link)) link = link.replace(/^https?:\/\/[^/?#]*/i, "");
  else link = link.replace(/^[a-z][\w+.-]*:(\/\/)?/i, "");
  const path = link
    .split(/[?#]/)[0]
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
  return actions.includes(path) ? (path as AppAction) : null;
}

let pending: AppAction | null = null;
// Mounted Home screens, newest last, and the close callbacks of open sheets outside Home.
let homes: (() => void)[] = [];
const sheets = new Set<() => void>();

/**
 * Leaves an action for Home; a newer link replaces one not yet taken. Open sheets elsewhere
 * close, since iOS shows one sheet at a time, and only the newest Home is told, so a stale
 * copy can never take it.
 */
export function requestAppAction(action: AppAction) {
  pending = action;
  [...sheets].forEach((close) => close());
  homes.at(-1)?.();
}

export const pendingAppAction = () => pending;

/** Hands the waiting action over once. */
export function takeAppAction() {
  const action = pending;
  pending = null;
  return action;
}

/** For Home: called when a link arrives while it is the newest mounted Home. */
export function subscribeAppActions(listener: () => void) {
  homes = [...homes, listener];
  return () => {
    homes = homes.filter((home) => home !== listener);
  };
}

/** True inside Home, which closes its own sheets for a link, skipping a Cancel that may ask. */
export const HomeSheets = createContext(false);

/** Closes an open sheet outside Home when a link arrives. Used by the shared Editor. */
export function useCloseForAppAction(open: boolean, close: () => void) {
  const home = useContext(HomeSheets);
  useEffect(() => {
    if (!open || home) return;
    const closer = () => close();
    sheets.add(closer);
    return () => {
      sheets.delete(closer);
    };
  }, [open, home, close]);
}
