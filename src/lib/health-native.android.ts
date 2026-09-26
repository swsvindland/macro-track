import type { HealthAdapter, HealthRecord } from "./health-types";
export async function getHealthAdapter(): Promise<HealthAdapter> {
  const hc = await import("react-native-health-connect");
  if (
    (await hc.getSdkStatus()) !== hc.SdkAvailabilityStatus.SDK_AVAILABLE ||
    !(await hc.initialize())
  )
    throw new Error("healthUnavailable");
  const recordTypes = {
    weight: "Weight",
    height: "Height",
    bodyFat: "BodyFat",
    food: "Nutrition",
  } as const;
  return {
    async authorize(interactive = true) {
      const permissions = ["Weight", "Height"].flatMap((recordType) =>
        ["read", "write"].map((accessType) => ({ recordType, accessType }))
      ) as {
        recordType: "Weight" | "Height" | "BodyFat" | "Nutrition";
        accessType: "read" | "write";
      }[];
      permissions.push(
        { recordType: "BodyFat", accessType: "write" },
        { recordType: "Nutrition", accessType: "write" }
      );
      const granted = interactive
        ? await hc.requestPermission(permissions)
        : await hc.getGrantedPermissions();
      if (interactive) {
        // Older Health Connect versions do not support background access.
        try {
          await hc.requestPermission([
            { accessType: "read", recordType: "BackgroundAccessPermission" },
          ]);
        } catch {
          /* Foreground sync is still available. */
        }
      }
      const allowed = (kind: keyof typeof recordTypes, accessType: "read" | "write") =>
        granted.some(
          (g) =>
            "recordType" in g && g.recordType === recordTypes[kind] && g.accessType === accessType
        );
      return {
        read: (["weight", "height"] as const).filter((kind) => allowed(kind, "read")),
        write: (["weight", "height", "bodyFat", "food"] as const).filter((kind) =>
          allowed(kind, "write")
        ),
      };
    },
    async read(kinds) {
      const records: HealthRecord[] = [];
      // Health Connect normally permits the 30 days before authorization; ask only for that window.
      const startTime = new Date(Date.now() - 29 * 86400000).toISOString();
      const endTime = new Date().toISOString();
      for (const kind of kinds) {
        let pageToken: string | undefined;
        do {
          const options = {
            timeRangeFilter: { operator: "between" as const, startTime, endTime },
            pageSize: 1000,
            pageToken,
          };
          const result =
            kind === "weight"
              ? await hc.readRecords("Weight", options)
              : await hc.readRecords("Height", options);
          for (const record of result.records) {
            if (!record.metadata?.id) continue;
            records.push({
              id: record.metadata.id,
              kind: "weight" in record ? "weight" : "height",
              value: "weight" in record ? record.weight.inKilograms : record.height.inMeters * 100,
              measuredAt: record.time,
              clientId: record.metadata.clientRecordId,
            });
          }
          pageToken = result.pageToken;
        } while (pageToken);
      }
      return records;
    },
    async write(record) {
      if (record.kind === "waist") throw new Error("healthUnavailable");
      const metadata = {
        clientRecordId: record.clientId,
        clientRecordVersion: record.version,
        recordingMethod: hc.RecordingMethod.RECORDING_METHOD_MANUAL_ENTRY,
      };
      const ids = await hc.insertRecords([
        record.kind === "weight"
          ? {
              recordType: "Weight",
              weight: { value: record.value, unit: "kilograms" },
              time: record.measuredAt,
              metadata,
            }
          : record.kind === "bodyFat"
            ? {
                recordType: "BodyFat",
                percentage: record.value,
                time: record.measuredAt,
                metadata,
              }
            : {
                recordType: "Height",
                height: { value: record.value / 100, unit: "meters" },
                time: record.measuredAt,
                metadata,
              },
      ]);
      if (!ids[0]) throw new Error("syncFailed");
      return ids[0];
    },
    async remove(kind, id) {
      if (kind === "waist") throw new Error("healthUnavailable");
      await hc.deleteRecordsByUuids(
        kind === "weight" ? "Weight" : kind === "bodyFat" ? "BodyFat" : "Height",
        [id],
        []
      );
    },
    async writeFood(food) {
      const { calories, protein, carbs, fat, fiber, sodium, ...micros } = food.nutrients;
      const grams = (value: number | null | undefined) =>
        value != null && value > 0 ? { value, unit: "grams" as const } : undefined;
      const mass = (value: number | undefined, unit: "milligrams" | "micrograms") =>
        value != null && value > 0 ? { value, unit } : undefined;
      // Health Connect has no added sugar, omega-3/-6 or choline fields.
      const extra = Object.fromEntries(
        (
          [
            ["sugar", "sugar", "grams"],
            ["saturatedFat", "saturatedFat", "grams"],
            ["transFat", "transFat", "grams"],
            ["monounsaturatedFat", "monounsaturatedFat", "grams"],
            ["polyunsaturatedFat", "polyunsaturatedFat", "grams"],
            ["cholesterol", "cholesterol", "milligrams"],
            ["potassium", "potassium", "milligrams"],
            ["calcium", "calcium", "milligrams"],
            ["iron", "iron", "milligrams"],
            ["magnesium", "magnesium", "milligrams"],
            ["phosphorus", "phosphorus", "milligrams"],
            ["zinc", "zinc", "milligrams"],
            ["copper", "copper", "milligrams"],
            ["manganese", "manganese", "milligrams"],
            ["selenium", "selenium", "micrograms"],
            ["vitaminA", "vitaminA", "micrograms"],
            ["vitaminC", "vitaminC", "milligrams"],
            ["vitaminD", "vitaminD", "micrograms"],
            ["vitaminE", "vitaminE", "milligrams"],
            ["vitaminK", "vitaminK", "micrograms"],
            ["thiamin", "thiamin", "milligrams"],
            ["riboflavin", "riboflavin", "milligrams"],
            ["niacin", "niacin", "milligrams"],
            ["pantothenicAcid", "pantothenicAcid", "milligrams"],
            ["vitaminB6", "vitaminB6", "milligrams"],
            ["folate", "folate", "micrograms"],
            ["vitaminB12", "vitaminB12", "micrograms"],
            ["caffeine", "caffeine", "milligrams"],
          ] as const
        ).flatMap(([key, field, unit]) => {
          const value = unit === "grams" ? grams(micros[key]) : mass(micros[key], unit);
          return value ? [[field, value]] : [];
        })
      );
      const start = new Date(food.eatenAt);
      // Nutrition is an interval record; its end must come after its start.
      const end = new Date(start.getTime() + 60000);
      // Inserting under an existing clientRecordId with a higher version updates that record.
      const ids = await hc.insertRecords([
        {
          recordType: "Nutrition",
          startTime: start.toISOString(),
          endTime: end.toISOString(),
          name: food.name,
          mealType: {
            Breakfast: hc.MealType.BREAKFAST,
            Lunch: hc.MealType.LUNCH,
            Dinner: hc.MealType.DINNER,
            Snacks: hc.MealType.SNACK,
          }[food.meal],
          energy: calories > 0 ? { value: calories, unit: "kilocalories" } : undefined,
          protein: grams(protein),
          totalCarbohydrate: grams(carbs),
          totalFat: grams(fat),
          dietaryFiber: grams(fiber),
          sodium: sodium !== null && sodium > 0 ? { value: sodium, unit: "milligrams" } : undefined,
          ...extra,
          metadata: {
            clientRecordId: food.clientId,
            clientRecordVersion: food.version,
            recordingMethod: hc.RecordingMethod.RECORDING_METHOD_MANUAL_ENTRY,
          },
        },
      ]);
      if (!ids[0]) throw new Error("syncFailed");
      return ids[0];
    },
    async removeFood(clientId) {
      await hc.deleteRecordsByUuids("Nutrition", [], [clientId]);
    },
  };
}
