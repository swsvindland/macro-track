import type { Meal, Nutrients } from "./nutrition";

export type HealthKind = "weight" | "height" | "waist" | "bodyFat";
export type HealthRecord = {
  id: string;
  kind: HealthKind;
  value: number;
  measuredAt: string;
  clientId?: string;
};
export type HealthWrite = Omit<HealthRecord, "id"> & { clientId: string; version: number };
/** One diary entry, written as dietary samples tagged with the food's name. */
export type HealthFood = {
  clientId: string;
  version: number;
  name: string;
  meal: Meal;
  eatenAt: string;
  nutrients: Nutrients;
  /** Set when an earlier write exists, so nutrients that are now unknown get removed. */
  replacing: boolean;
};
/** What Health knows about the person, for prefilling the program. */
export type HealthProfile = { birthDate?: string; sex?: "male" | "female" };
// Kinds the user granted. Only reading weight is required; everything else is optional.
export type HealthAccess = {
  read: readonly ("weight" | "height")[];
  write: readonly (HealthKind | "food")[];
};
export type HealthAdapter = {
  authorize: (interactive?: boolean) => Promise<HealthAccess>;
  read: (kinds: HealthAccess["read"]) => Promise<HealthRecord[]>;
  write: (record: HealthWrite) => Promise<string>;
  /**
   * Deletes a sample; one already gone counts as deleted. Without an id (a restore from the
   * other platform clears it) the sample written under `clientId` is deleted instead.
   */
  remove: (kind: HealthKind, id: string, clientId?: string) => Promise<void>;
  writeFood?: (food: HealthFood) => Promise<string>;
  removeFood?: (clientId: string, id: string) => Promise<void>;
  profile?: () => Promise<HealthProfile>;
};
