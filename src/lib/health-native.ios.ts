import type { MetadataForQuantityIdentifier } from "@kingstinct/react-native-healthkit";
import type { HealthAdapter, HealthKind } from "./health-types";
export async function getHealthAdapter(): Promise<HealthAdapter> {
  // Lazy import: opening the app in Expo Go must not load an unavailable Nitro module.
  const hk = await import("@kingstinct/react-native-healthkit");
  const identifiers = {
    weight: "HKQuantityTypeIdentifierBodyMass",
    height: "HKQuantityTypeIdentifierHeight",
    waist: "HKQuantityTypeIdentifierWaistCircumference",
    bodyFat: "HKQuantityTypeIdentifierBodyFatPercentage",
  } as const;
  const identifier = (kind: HealthKind) => identifiers[kind];
  const readTypes = [identifier("weight"), identifier("height")];
  const types = Object.values(identifiers);
  const kinds = Object.keys(identifiers) as HealthKind[];
  if (!hk.isHealthDataAvailable()) throw new Error("healthUnavailable");
  let anyWrite = true;
  return {
    async authorize(interactive = true) {
      if (interactive) await hk.requestAuthorization({ toRead: readTypes, toShare: types });
      const write = kinds.filter(
        (kind) =>
          hk.authorizationStatusFor(identifier(kind)) === hk.AuthorizationStatus.sharingAuthorized
      );
      anyWrite = write.length > 0;
      // HealthKit never reveals read access; read() checks it when no write is granted.
      return { read: ["weight", "height"] as const, write };
    },
    async read(readKinds) {
      const records = [];
      for (const kind of readKinds) {
        const samples = await hk.queryQuantitySamples(identifier(kind), {
          unit: kind === "weight" ? "kg" : "cm",
          limit: 0,
          ascending: true,
        });
        const found = samples.map((sample) => ({
          id: sample.uuid,
          kind,
          value: sample.quantity,
          measuredAt: sample.startDate.toISOString(),
          clientId:
            typeof sample.metadata.HKSyncIdentifier === "string"
              ? sample.metadata.HKSyncIdentifier
              : undefined,
        }));
        // A denied read returns only this app's samples. With every write off too, that means
        // "Don't Allow"; an outside weight proves an import-only grant.
        if (
          kind === "weight" &&
          !anyWrite &&
          found.every((record) => record.clientId?.startsWith("macro-track:"))
        )
          throw new Error("healthWeightDenied");
        records.push(...found);
      }
      return records;
    },
    async write(record) {
      const date = new Date(record.measuredAt);
      // HealthKit 14.1 incorrectly intersects common metadata with Record<string, never>
      // for these identifiers. These are documented HK metadata keys; keep the workaround local.
      const metadata = {
        HKSyncIdentifier: record.clientId,
        HKSyncVersion: record.version,
        HKWasUserEntered: true,
      } as unknown as MetadataForQuantityIdentifier<"HKQuantityTypeIdentifierBodyMass">;
      // HealthKit percent units use fractions (0–1); the app stores percentage points.
      const result = await hk.saveQuantitySample(
        identifier(record.kind),
        record.kind === "weight" ? "kg" : record.kind === "bodyFat" ? "%" : "cm",
        record.kind === "bodyFat" ? record.value / 100 : record.value,
        date,
        date,
        metadata
      );
      if (!result) throw new Error("syncFailed");
      return result.uuid;
    },
    async remove(kind, id) {
      await hk.deleteObjects(identifier(kind), { uuid: id });
    },
  };
}
