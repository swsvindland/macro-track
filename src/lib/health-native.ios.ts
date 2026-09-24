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
  if (!hk.isHealthDataAvailable()) throw new Error("healthUnavailable");
  return {
    bodyWriteKinds: ["waist", "bodyFat"],
    async authorize(interactive = true) {
      if (interactive) await hk.requestAuthorization({ toRead: readTypes, toShare: types });
      if (
        types.some(
          (type) => hk.authorizationStatusFor(type) !== hk.AuthorizationStatus.sharingAuthorized
        )
      )
        throw new Error("syncFailed");
    },
    async read() {
      const records = [];
      for (const kind of ["weight", "height"] as const) {
        const samples = await hk.queryQuantitySamples(identifier(kind), {
          unit: kind === "weight" ? "kg" : "cm",
          limit: 0,
          ascending: true,
        });
        records.push(
          ...samples.map((sample) => ({
            id: sample.uuid,
            kind,
            value: sample.quantity,
            measuredAt: sample.startDate.toISOString(),
            clientId:
              typeof sample.metadata.HKSyncIdentifier === "string"
                ? sample.metadata.HKSyncIdentifier
                : undefined,
          }))
        );
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
