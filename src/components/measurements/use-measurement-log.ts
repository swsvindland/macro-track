import { useState } from "react";
import { Alert } from "react-native";
import { eq } from "drizzle-orm";
import { useKitFormat, type IntlUnit } from "@/vector";
import { db, healthLinks, measurements, weightEntries } from "@/db";
import { useStore } from "@/lib/store";
import { deleteWeight, setWeightExcluded } from "@/lib/weigh-in";
import {
  dayOf,
  formatHeight,
  heightParts,
  parseHeight,
  fromCm,
  fromKg,
  localDay,
  parseNumber,
  sites,
  toCm,
  toKg,
  validDay,
  type Units,
} from "@/lib/metrics";

type Kind = "weight" | "height" | "body";
/** The unit each kind is logged in, as the locale writes its symbol. */
const logUnits: Record<Units, Record<"weight" | "length", IntlUnit>> = {
  metric: { weight: "kilogram", length: "centimeter" },
  imperial: { weight: "pound", length: "inch" },
  stone: { weight: "stone", length: "inch" },
};
type RecordRow = {
  id: number;
  measuredAt: string;
  values: Record<string, number>;
  /** A weigh-in left out of the trend and check-ins. */
  excluded?: boolean;
};
export function useMeasurementLog(kind: Kind) {
  const { weights, measurements: records, units, t, refresh } = useStore();
  const kit = useKitFormat();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<RecordRow | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [day, setDay] = useState(localDay());
  // What the editor opened with, so a sheet with unsaved changes resists being swiped away.
  const [opened, setOpened] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState(30);
  const rows: RecordRow[] =
    kind === "weight"
      ? weights.map((w) => ({
          id: w.id,
          measuredAt: w.measuredAt,
          values: { weight: w.weightKg },
          excluded: w.excluded,
        }))
      : records.filter((m) => m.kind === kind);
  const fields: ((typeof sites)[number] | "bodyFat" | "weight" | "height")[] =
    kind === "body" ? [...sites, "bodyFat"] : [kind];
  const intlUnit = logUnits[units][kind === "weight" ? "weight" : "length"];
  const unit = kit.unitParts(1, intlUnit).unit;
  const digits = kind === "weight" && units === "stone" ? 2 : 1;
  // Weights keep their decimals ("80.0 kg"), as formatWeight writes them everywhere else.
  const style = { fixed: kind === "weight" };
  const display = (key: string, value: number) =>
    key === "bodyFat" ? value : kind === "weight" ? fromKg(value, units) : fromCm(value, units);
  const imperialHeight = kind === "height" && units !== "metric";
  /** A reading as Value parts: the number and its unit, in the locale's order and spacing. */
  const readout = (key: string, value: number) =>
    key === "bodyFat"
      ? { value: kit.percent(value / 100, 1), unit: "" }
      : imperialHeight
        ? { value: formatHeight(value, units, kit.number), unit: "" }
        : kit.unitParts(display(key, value), intlUnit, digits, style);
  const format = (key: string, value: number) =>
    key === "bodyFat"
      ? kit.percent(value / 100, 1)
      : imperialHeight
        ? formatHeight(value, units, kit.number)
        : kit.unit(display(key, value), intlUnit, digits, style);
  /**
   * What a field opens with, in the locale's decimal and the readout's precision ("80,5" in de,
   * "12.57" in stone); parseNumber reads it back, and save knows it for an untouched field.
   */
  const editable = (key: string, value: number) =>
    kit.editable(display(key, value), key === "bodyFat" ? 1 : digits);
  const heightEditable = (cm: number) =>
    Object.fromEntries(
      Object.entries(heightParts(cm, 1)).map(([key, value]) => [key, kit.editable(value, 1)])
    );
  const imported = editing
    ? db
        .select()
        .from(healthLinks)
        .all()
        .some(
          (link) =>
            link.origin === "health" && link.localKind === kind && link.localId === editing.id
        )
    : false;
  function launch(row: RecordRow | null) {
    const start = row ? dayOf(row.measuredAt) : localDay();
    const seeded =
      imperialHeight && row
        ? heightEditable(row.values.height)
        : Object.fromEntries(
            Object.entries(row?.values ?? {}).map(([key, value]) => [key, editable(key, value)])
          );
    setEditing(row);
    setError("");
    setDay(start);
    setInputs(seeded);
    setOpened(JSON.stringify([start, seeded]));
    setOpen(true);
  }
  function save() {
    if (busy || imported) return;
    if (!validDay(day)) {
      setError(t("invalidDate"));
      return;
    }
    const values: Record<string, number> = {};
    for (const key of fields) {
      const raw = inputs[key]?.trim();
      if (!raw && kind === "body") continue;
      // Preserve canonical precision when a field wasn't changed in the editor.
      const original = editing?.values[key];
      const unchanged =
        original !== undefined &&
        (imperialHeight
          ? inputs.feet?.trim() === heightEditable(original).feet &&
            inputs.inches?.trim() === heightEditable(original).inches
          : raw === editable(key, original));
      const parsed = parseNumber(raw ?? "");
      const value = unchanged
        ? original
        : imperialHeight
          ? parseHeight(inputs.feet ?? "", inputs.inches ?? "")
          : key === "bodyFat"
            ? parsed
            : kind === "weight"
              ? toKg(parsed, units)
              : toCm(parsed, units);
      const max = key === "bodyFat" ? 74.9 : kind === "weight" ? 500 : 300;
      if (!Number.isFinite(value) || value <= 0 || value > max) {
        setError(t("invalidFieldRange", { field: t(key), max: format(key, max) }));
        return;
      }
      values[key] = unchanged ? original : Math.round(value * 10000) / 10000;
    }
    if (!Object.keys(values).length) {
      setError(t("invalid"));
      return;
    }
    setBusy(true);
    try {
      const measuredAt =
        editing && dayOf(editing.measuredAt) === day
          ? editing.measuredAt
          : (day === localDay() ? new Date() : new Date(`${day}T12:00:00`)).toISOString();
      if (kind === "weight") {
        if (editing)
          db.update(weightEntries)
            .set({ weightKg: values.weight, measuredAt, updatedAt: new Date() })
            .where(eq(weightEntries.id, editing.id))
            .run();
        else db.insert(weightEntries).values({ weightKg: values.weight, measuredAt }).run();
      } else {
        const data = { kind, measuredAt, values, updatedAt: new Date().getTime() };
        if (editing) db.update(measurements).set(data).where(eq(measurements.id, editing.id)).run();
        else db.insert(measurements).values(data).run();
      }
      refresh();
      setOpen(false);
    } catch {
      setError(t("error"));
    } finally {
      setBusy(false);
    }
  }
  /** Ignores a weigh-in or counts it again, from history or its editor. */
  function exclude(row: RecordRow, excluded: boolean) {
    try {
      setWeightExcluded(row.id, excluded);
      if (editing?.id === row.id) setEditing({ ...editing, excluded });
      refresh();
      setError("");
    } catch {
      setError(t("error"));
    }
  }
  function remove() {
    if (!editing) return;
    Alert.alert(t("delete"), t("deleteConfirm"), [
      { text: t("cancel"), style: "cancel" },
      {
        text: t("delete"),
        style: "destructive",
        onPress: () => {
          try {
            if (kind === "weight") deleteWeight(editing.id);
            else db.delete(measurements).where(eq(measurements.id, editing.id)).run();
            refresh();
            setOpen(false);
          } catch {
            setError(t("error"));
          }
        },
      },
    ]);
  }
  return {
    rows,
    fields,
    unit,
    display,
    format,
    readout,
    imperialHeight,
    open,
    editing,
    inputs,
    day,
    error,
    busy,
    imported,
    dirty: open && JSON.stringify([day, inputs]) !== opened,
    limit,
    setLimit,
    setOpen,
    setInputs,
    setDay,
    launch,
    save,
    remove,
    exclude: kind === "weight" ? exclude : undefined,
  };
}

export type MeasurementLogState = ReturnType<typeof useMeasurementLog>;
