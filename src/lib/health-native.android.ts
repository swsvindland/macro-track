import type { HealthAdapter, HealthRecord } from "./health-types";
export async function getHealthAdapter(): Promise<HealthAdapter> {
  const hc = await import("react-native-health-connect");
  if (
    (await hc.getSdkStatus()) !== hc.SdkAvailabilityStatus.SDK_AVAILABLE ||
    !(await hc.initialize())
  )
    throw new Error("healthUnavailable");
  return {
    bodyWriteKinds: ["bodyFat"],
    async authorize(interactive = true) {
      const permissions = ["Weight", "Height"].flatMap((recordType) =>
        ["read", "write"].map((accessType) => ({ recordType, accessType }))
      ) as { recordType: "Weight" | "Height" | "BodyFat"; accessType: "read" | "write" }[];
      permissions.push({ recordType: "BodyFat", accessType: "write" });
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
      if (
        permissions.some(
          (p) =>
            !granted.some(
              (g) =>
                "recordType" in g && g.recordType === p.recordType && g.accessType === p.accessType
            )
        )
      )
        throw new Error("syncFailed");
    },
    async read() {
      const records: HealthRecord[] = [];
      // Health Connect normally permits the 30 days before authorization; ask only for that window.
      const startTime = new Date(Date.now() - 29 * 86400000).toISOString();
      const endTime = new Date().toISOString();
      for (const type of ["Weight", "Height"] as const) {
        let pageToken: string | undefined;
        do {
          const options = {
            timeRangeFilter: { operator: "between" as const, startTime, endTime },
            pageSize: 1000,
            pageToken,
          };
          const result =
            type === "Weight"
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
  };
}
