export type HealthKind = "weight" | "height" | "waist" | "bodyFat";
export type HealthRecord = {
  id: string;
  kind: HealthKind;
  value: number;
  measuredAt: string;
  clientId?: string;
};
export type HealthWrite = Omit<HealthRecord, "id"> & { clientId: string; version: number };
// Kinds the user granted. Only reading weight is required; everything else is optional.
export type HealthAccess = {
  read: readonly ("weight" | "height")[];
  write: readonly HealthKind[];
};
export type HealthAdapter = {
  authorize: (interactive?: boolean) => Promise<HealthAccess>;
  read: (kinds: HealthAccess["read"]) => Promise<HealthRecord[]>;
  write: (record: HealthWrite) => Promise<string>;
  remove: (kind: HealthKind, id: string) => Promise<void>;
};
