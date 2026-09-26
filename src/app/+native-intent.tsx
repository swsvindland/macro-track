import type { NativeIntent } from "expo-router";
import { parseAppAction, requestAppAction } from "@/lib/app-actions";

/**
 * Every link lands on Today; macrotrack://log, search, scan, photo and weigh-in also open the
 * matching sheet. Nothing else is linkable, so no link can stack a screen over Home.
 */
export const redirectSystemPath: NativeIntent["redirectSystemPath"] = ({ path }) => {
  try {
    const action = parseAppAction(path);
    if (action) requestAppAction(action);
  } catch {
    // An unreadable link still opens Today.
  }
  return "/";
};
