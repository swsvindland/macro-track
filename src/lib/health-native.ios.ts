import type { MetadataForQuantityIdentifier } from "@kingstinct/react-native-healthkit";
import type { Nutrients } from "./nutrition";
import type { HealthAccess, HealthAdapter, HealthKind } from "./health-types";
export async function getHealthAdapter(): Promise<HealthAdapter> {
  // Lazy import: opening the app in Expo Go must not load an unavailable Nitro module.
  const hk = await import("@kingstinct/react-native-healthkit");
  const identifiers = {
    weight: "HKQuantityTypeIdentifierBodyMass",
    height: "HKQuantityTypeIdentifierHeight",
    waist: "HKQuantityTypeIdentifierWaistCircumference",
    bodyFat: "HKQuantityTypeIdentifierBodyFatPercentage",
  } as const;
  // Each diary entry becomes one sample per known nutrient, all tagged with the food's name.
  const nutrients = [
    ["calories", "HKQuantityTypeIdentifierDietaryEnergyConsumed", "kcal"],
    ["protein", "HKQuantityTypeIdentifierDietaryProtein", "g"],
    ["carbs", "HKQuantityTypeIdentifierDietaryCarbohydrates", "g"],
    ["fat", "HKQuantityTypeIdentifierDietaryFatTotal", "g"],
    ["fiber", "HKQuantityTypeIdentifierDietaryFiber", "g"],
    ["sodium", "HKQuantityTypeIdentifierDietarySodium", "mg"],
    // Health has no added sugar, trans fat, omega-3/-6 or choline types.
    ["sugar", "HKQuantityTypeIdentifierDietarySugar", "g"],
    ["saturatedFat", "HKQuantityTypeIdentifierDietaryFatSaturated", "g"],
    ["monounsaturatedFat", "HKQuantityTypeIdentifierDietaryFatMonounsaturated", "g"],
    ["polyunsaturatedFat", "HKQuantityTypeIdentifierDietaryFatPolyunsaturated", "g"],
    ["cholesterol", "HKQuantityTypeIdentifierDietaryCholesterol", "mg"],
    ["potassium", "HKQuantityTypeIdentifierDietaryPotassium", "mg"],
    ["calcium", "HKQuantityTypeIdentifierDietaryCalcium", "mg"],
    ["iron", "HKQuantityTypeIdentifierDietaryIron", "mg"],
    ["magnesium", "HKQuantityTypeIdentifierDietaryMagnesium", "mg"],
    ["phosphorus", "HKQuantityTypeIdentifierDietaryPhosphorus", "mg"],
    ["zinc", "HKQuantityTypeIdentifierDietaryZinc", "mg"],
    ["copper", "HKQuantityTypeIdentifierDietaryCopper", "mg"],
    ["manganese", "HKQuantityTypeIdentifierDietaryManganese", "mg"],
    ["selenium", "HKQuantityTypeIdentifierDietarySelenium", "mcg"],
    ["vitaminA", "HKQuantityTypeIdentifierDietaryVitaminA", "mcg"],
    ["vitaminC", "HKQuantityTypeIdentifierDietaryVitaminC", "mg"],
    ["vitaminD", "HKQuantityTypeIdentifierDietaryVitaminD", "mcg"],
    ["vitaminE", "HKQuantityTypeIdentifierDietaryVitaminE", "mg"],
    ["vitaminK", "HKQuantityTypeIdentifierDietaryVitaminK", "mcg"],
    ["thiamin", "HKQuantityTypeIdentifierDietaryThiamin", "mg"],
    ["riboflavin", "HKQuantityTypeIdentifierDietaryRiboflavin", "mg"],
    ["niacin", "HKQuantityTypeIdentifierDietaryNiacin", "mg"],
    ["pantothenicAcid", "HKQuantityTypeIdentifierDietaryPantothenicAcid", "mg"],
    ["vitaminB6", "HKQuantityTypeIdentifierDietaryVitaminB6", "mg"],
    ["folate", "HKQuantityTypeIdentifierDietaryFolate", "mcg"],
    ["vitaminB12", "HKQuantityTypeIdentifierDietaryVitaminB12", "mcg"],
    ["caffeine", "HKQuantityTypeIdentifierDietaryCaffeine", "mg"],
  ] as const satisfies readonly (readonly [keyof Nutrients, string, string])[];
  const identifier = (kind: HealthKind) => identifiers[kind];
  const readTypes = [
    identifier("weight"),
    identifier("height"),
    "HKCharacteristicTypeIdentifierDateOfBirth",
    "HKCharacteristicTypeIdentifierBiologicalSex",
  ] as const;
  const shareTypes = [...Object.values(identifiers), ...nutrients.map(([, id]) => id)];
  const kinds = Object.keys(identifiers) as HealthKind[];
  if (!hk.isHealthDataAvailable()) throw new Error("healthUnavailable");
  let anyWrite = true;
  let foodTypes = new Set<string>();
  const shared = (id: (typeof shareTypes)[number]) =>
    hk.authorizationStatusFor(id) === hk.AuthorizationStatus.sharingAuthorized;
  const bySyncId = (value: string) => ({
    metadata: {
      withMetadataKey: "HKSyncIdentifier",
      operatorType: hk.ComparisonPredicateOperator.equalTo,
      value,
    },
  });
  // Deleting is best effort: HealthKit reports an error when nothing matched, e.g. after the
  // person removed the sample in the Health app.
  const removeNutrient = (id: (typeof nutrients)[number][1], syncId: string) =>
    hk.deleteObjects(id, bySyncId(syncId)).catch(() => 0);
  return {
    async authorize(interactive = true) {
      if (interactive) await hk.requestAuthorization({ toRead: readTypes, toShare: shareTypes });
      const write: HealthAccess["write"][number][] = kinds.filter((kind) =>
        shared(identifier(kind))
      );
      foodTypes = new Set(nutrients.filter(([, id]) => shared(id)).map(([, id]) => id));
      if (foodTypes.size) write.push("food");
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
    async writeFood(food) {
      const date = new Date(food.eatenAt);
      let first = "";
      for (const [key, id, unit] of nutrients) {
        if (!foodTypes.has(id)) continue;
        const syncId = `${food.clientId}:${key}`;
        const value = food.nutrients[key];
        if (value == null || !(value > 0)) {
          if (food.replacing) await removeNutrient(id, syncId);
          continue;
        }
        // A newer HKSyncVersion under the same identifier replaces the earlier sample.
        const metadata = {
          HKSyncIdentifier: syncId,
          HKSyncVersion: food.version,
          HKFoodType: food.name,
        } as unknown as MetadataForQuantityIdentifier<typeof id>;
        const result = await hk.saveQuantitySample(id, unit, value, date, date, metadata);
        if (!result) throw new Error("syncFailed");
        first ||= result.uuid;
      }
      return first;
    },
    async removeFood(clientId) {
      for (const [key, id] of nutrients)
        if (foodTypes.has(id)) await removeNutrient(id, `${clientId}:${key}`);
    },
    async profile() {
      // Unanswered or denied characteristics throw or read as not set; either way, skip them.
      const birth = await hk.getDateOfBirthAsync().catch(() => undefined);
      const sex = await hk.getBiologicalSexAsync().catch(() => hk.BiologicalSex.notSet);
      return {
        // The birthday arrives as local midnight; UTC could move it to the day before.
        birthDate: birth
          ? `${birth.getFullYear()}-${String(birth.getMonth() + 1).padStart(2, "0")}-${String(birth.getDate()).padStart(2, "0")}`
          : undefined,
        sex:
          sex === hk.BiologicalSex.male
            ? "male"
            : sex === hk.BiologicalSex.female
              ? "female"
              : undefined,
      };
    },
  };
}
