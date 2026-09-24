import Constants from "expo-constants";
import { Platform } from "react-native";
import * as TaskManager from "expo-task-manager";
import * as BackgroundTask from "expo-background-task";
import { eq } from "drizzle-orm";
import { db, preferences } from "@/db";
import { syncHealth } from "./health";

const TASK = "body-track-daily-health-sync";
const DAY = 24 * 60 * 60 * 1000;
const get = (key: string) =>
  db.select().from(preferences).where(eq(preferences.key, key)).get()?.value;
const set = (key: string, value: string) => {
  db.insert(preferences)
    .values({ key, value })
    .onConflictDoUpdate({ target: preferences.key, set: { value } })
    .run();
};

export function healthSyncDue(lastSync?: string, now = Date.now()) {
  const last = Date.parse(lastSync ?? "");
  return !Number.isFinite(last) || now < last || now - last >= DAY;
}

export async function syncHealthIfDue() {
  if (get("healthSyncEnabled") !== "true" || !healthSyncDue(get("lastSync"))) return true;
  try {
    // Automatic work must never open a permission prompt.
    await syncHealth(undefined, false);
    set("healthSyncError", "");
    return true;
  } catch (error) {
    if (error instanceof Error && error.message === "syncing") return true;
    set("healthSyncError", "syncFailed");
    return false;
  }
}

TaskManager.defineTask(TASK, async () => {
  try {
    return (await syncHealthIfDue())
      ? BackgroundTask.BackgroundTaskResult.Success
      : BackgroundTask.BackgroundTaskResult.Failed;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export async function configureHealthSchedule() {
  if (Platform.OS === "web" || Constants.appOwnership === "expo") return;
  if (get("healthSyncEnabled") === "true") {
    if ((await BackgroundTask.getStatusAsync()) === BackgroundTask.BackgroundTaskStatus.Available) {
      await BackgroundTask.registerTaskAsync(TASK, { minimumInterval: 24 * 60 });
    }
  } else if (await TaskManager.isTaskRegisteredAsync(TASK)) {
    await BackgroundTask.unregisterTaskAsync(TASK);
  }
}

export async function enableHealthSync() {
  await syncHealth();
  set("healthSyncEnabled", "true");
  set("healthSyncError", "");
  try {
    await configureHealthSchedule();
  } catch (error) {
    set("healthSyncEnabled", "false");
    throw error;
  }
}

export async function disableHealthSync() {
  // Persist first so a pending task also observes the opt-out.
  set("healthSyncEnabled", "false");
  set("healthSyncError", "");
  await configureHealthSchedule();
}
