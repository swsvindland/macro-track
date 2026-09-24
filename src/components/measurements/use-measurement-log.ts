import { useState } from "react";
import { Alert } from "react-native";
import { eq } from "drizzle-orm";
import { db, healthLinks, measurements, weightEntries } from "@/db";
import { useStore } from "@/lib/store";
import {
  dayOf,
  formatHeight,
  heightParts,
  parseHeight,
  fromCm,
  fromKg,
  lengthUnit,
  localDay,
  parseNumber,
  sites,
  toCm,
  toKg,
  validDay,
  weightUnit,
} from "@/lib/metrics";

type Kind = "weight" | "height" | "body";
type RecordRow = { id: number; measuredAt: string; values: Record<string, number> };
export function useMeasurementLog(kind: Kind) {
  const { weights, measurements: records, units, t, number, refresh } = useStore();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<RecordRow | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [day, setDay] = useState(localDay());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState(30);
  const rows: RecordRow[] =
    kind === "weight"
      ? weights.map((w) => ({ id: w.id, measuredAt: w.measuredAt, values: { weight: w.weightKg } }))
      : records.filter((m) => m.kind === kind);
  const fields = kind === "body" ? [...sites, "bodyFat"] : [kind];
  const unit = kind === "weight" ? weightUnit(units) : lengthUnit(units);
  const display = (key: string, value: number) =>
    key === "bodyFat" ? value : kind === "weight" ? fromKg(value, units) : fromCm(value, units);
  const imperialHeight = kind === "height" && units !== "metric";
  const format = (key: string, value: number) =>
    key === "height"
      ? formatHeight(value, units, number)
      : `${number(display(key, value))} ${key === "bodyFat" ? "%" : unit}`;
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
    setEditing(row);
    setError("");
    setDay(row ? dayOf(row.measuredAt) : localDay());
    setInputs(
      imperialHeight && row
        ? Object.fromEntries(
            Object.entries(heightParts(row.values.height, 1)).map(([key, value]) => [
              key,
              String(value),
            ])
          )
        : Object.fromEntries(
            Object.entries(row?.values ?? {}).map(([key, value]) => [
              key,
              String(Math.round(display(key, value) * 10) / 10),
            ])
          )
    );
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
          ? inputs.feet?.trim() === String(heightParts(original, 1).feet) &&
            inputs.inches?.trim() === String(heightParts(original, 1).inches)
          : raw === String(Math.round(display(key, original) * 10) / 10));
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
        setError(`${t(key)}: ${t("invalid")} (0–${format(key, max)})`);
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
  function remove() {
    if (!editing) return;
    Alert.alert(t("delete"), t("deleteConfirm"), [
      { text: t("cancel"), style: "cancel" },
      {
        text: t("delete"),
        style: "destructive",
        onPress: () => {
          try {
            if (kind === "weight")
              db.delete(weightEntries).where(eq(weightEntries.id, editing.id)).run();
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
    imperialHeight,
    open,
    editing,
    inputs,
    day,
    error,
    busy,
    imported,
    limit,
    setLimit,
    setOpen,
    setInputs,
    setDay,
    launch,
    save,
    remove,
  };
}

export type MeasurementLogState = ReturnType<typeof useMeasurementLog>;
