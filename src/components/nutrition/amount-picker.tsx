import type { ReactNode } from "react";
import { View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { useThemeColor } from "heroui-native";
import {
  Button,
  ChipRow,
  Field,
  IconButton,
  Label,
  Text,
  Value,
  decimalSeparator,
  useKitFormat,
} from "@/vector";
import {
  convertCount,
  editAmount,
  formatCount,
  parseAmount,
  unitStep,
  type Nutrients,
  type PortionUnit,
  type Targets,
} from "@/lib/nutrition";
import { useStore } from "@/lib/store";
import type { Message } from "@/lib/translations";
import { FoodNutrients } from "./nutrient-list";

/** The amount field: text in one of the food's units. `fresh` text is replaced by the next key. */
export type AmountDraft = { unit: string; text: string; fresh: boolean };

/** Stands in for an amount the record does not list: never 0, which would be a claim. */
const unknownMark = "—";

/**
 * Amount entry on the system keyboard, which opens with the sheet: the field, ± steppers, the
 * food's units and the screen's actions above the decimal pad, the same one for every unit. Typing
 * a number and then a unit keeps the number; a prefilled or stepped amount converts to the new
 * unit instead, and stays selected so typing replaces it.
 */
export function AmountPicker({
  units,
  value,
  onChange,
  actions,
  label,
}: {
  units: PortionUnit[];
  value: AmountDraft;
  onChange: (value: AmountDraft) => void;
  /** One or two actions; the last is the primary one. */
  actions: { label: string; onPress: () => void }[];
  /** The field's label, when "Amount in {unit}" doesn't read (a saved meal's "×"). */
  label?: string;
}) {
  const { t } = useStore();
  const format = useKitFormat();
  const unit = units.find((row) => row.key === value.unit) ?? units[0];
  const count = parseAmount(value.text);
  const step = unitStep(unit);
  const set = (next: number, target = unit) =>
    onChange({ unit: target.key, text: formatCount(next, target), fresh: true });
  const more = () => set(count > 0 ? count + step : step);
  const less = () => count - step > 0 && set(count - step);
  const stepLabel = t("amountUnit", { count: formatCount(step, unit), unit: unit.label });
  const choose = (next: PortionUnit) => {
    if (next.key === unit.key) return;
    if (!value.fresh && count > 0)
      return onChange({ unit: next.key, text: value.text, fresh: true });
    const converted = convertCount(units, unit.key, count, next.key);
    set(converted > 0 ? converted : unitStep(next) === 10 ? 100 : 1, next);
  };
  const measures = units.filter((row) => row.kind === "mass" || row.kind === "volume");
  const own = units.filter((row) => row.kind === "count" || row.kind === "energy");
  const byKey = new Map(units.map((row) => [row.key, row]));
  return (
    <View className="gap-2">
      {/* The steppers line up with the field under its label. */}
      <View className="flex-row items-end gap-2">
        <IconButton
          icon="remove"
          variant="secondary"
          accessibilityLabel={t("decreaseBy", { amount: stepLabel })}
          disabled={!(count - step > 0)}
          onPress={less}
        />
        <View className="flex-1">
          <Field
            label={label ?? t("amountIn", { unit: unit.label })}
            numeric
            unit={unit.label}
            autoFocus
            placeholder={format.number(0)}
            // Shown with the locale's decimal ("1,5" in de); the draft keeps "." for parseAmount.
            value={value.text.replace(".", decimalSeparator(format.tag))}
            // A prefilled or stepped amount stays selected so the first key replaces it.
            selection={value.fresh ? { start: 0, end: value.text.length } : undefined}
            selectTextOnFocus
            onChange={(next) =>
              onChange({ ...value, text: editAmount(value.text, next), fresh: false })
            }
          />
        </View>
        <IconButton
          icon="add"
          variant="secondary"
          accessibilityLabel={t("increaseBy", { amount: stepLabel })}
          onPress={more}
        />
      </View>
      {units.length > 1 && (
        <ChipRow
          values={units.map((row) => row.key)}
          groups={[measures, own]
            .filter((group) => group.length)
            .map((group) => group.map((row) => row.key))}
          // The amount always has a unit: tapping the chosen one again keeps it.
          required
          value={unit.key}
          onChange={(key) => {
            const next = byKey.get(key);
            if (next) choose(next);
          }}
          label={(key) => byKey.get(key)?.label ?? key}
          accessibilityLabel={t("unit")}
        />
      )}
      <View className="flex-row gap-2">
        {actions.map((action, i) => (
          <Button
            key={action.label}
            variant={i === actions.length - 1 ? "primary" : "secondary"}
            size="lg"
            className="flex-1"
            fit
            onPress={action.onPress}
          >
            {action.label}
          </Button>
        ))}
      </View>
    </View>
  );
}

/** A progress ring in the text-safe cyan; past 100% it is full and in the warning colour. */
export function Ring({
  value,
  size = 52,
  width = 5,
  children,
}: {
  value: number;
  size?: number;
  width?: number;
  children?: ReactNode;
}) {
  const track = String(useThemeColor("border"));
  // `link` is HeroUI's alias of the kit's --tint.
  const fill = String(useThemeColor(value > 1 ? "warning" : "link"));
  const radius = (size - width) / 2;
  const length = 2 * Math.PI * radius;
  const shown = Math.min(Math.max(value, 0), 1);
  return (
    <View style={{ width: size, height: size }} className="items-center justify-center">
      <Svg
        width={size}
        height={size}
        style={{ position: "absolute", transform: [{ rotate: "-90deg" }] }}
      >
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={track}
          strokeWidth={width}
          fill="none"
        />
        {shown > 0 && (
          <Circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            stroke={fill}
            strokeWidth={width}
            strokeDasharray={`${length * shown} ${length}`}
            fill="none"
          />
        )}
      </Svg>
      {children}
    </View>
  );
}

/** The day's calories with the foods being chosen, against its target. */
export function DayRing({ calories, target }: { calories: number; target: number | null }) {
  const { t } = useStore();
  const format = useKitFormat();
  const eaten = format.number(calories);
  return (
    <View
      accessible
      accessibilityLabel={
        target
          ? t("dayRingOfTarget", { eaten, target: format.number(target) })
          : t("dayRingEaten", { eaten })
      }
      className="flex-row items-center gap-2"
    >
      {!!target && <Ring value={calories / target} size={28} width={4} />}
      <Value
        size="xs"
        value={eaten}
        unit={target ? t("ofTarget", { target: format.number(target) }) : t("kcal")}
      />
    </View>
  );
}

// P · C · F, with each macro's calories per gram for its share of the portion's energy.
const macros = [
  ["protein", "macroProtein", 4],
  ["carbs", "macroCarbs", 4],
  ["fat", "macroFat", 9],
] as const satisfies readonly (readonly [keyof Targets, Message, number])[];
const rings = [["calories", "calories"], ...macros] as const;

/**
 * A portion's calories and macros (each as a share of its calories), what it adds to the day's
 * targets, and the nutrients the food lists. Unknown values read "—", never 0.
 */
export function PortionPreview({
  nutrients,
  targets,
}: {
  nutrients: Nutrients | null;
  targets?: Targets | null;
}) {
  const { t } = useStore();
  const format = useKitFormat();
  const energy = nutrients
    ? macros.reduce((sum, [key, , kcal]) => sum + nutrients[key] * kcal, 0)
    : 0;
  return (
    <View className="gap-4">
      <View className="gap-1">
        <Label>{t("calories")}</Label>
        <Value
          size="xl"
          value={nutrients ? format.number(nutrients.calories) : unknownMark}
          unit={t("kcal")}
        />
      </View>
      <View className="flex-row gap-3">
        {macros.map(([key, label, kcal]) => (
          <View key={key} className="flex-1 gap-1">
            {/* A column header that wraps rather than clips: "Kohlenhydrate" is a long word. */}
            <Text variant="label" tone="muted">
              {t(label)}
            </Text>
            <Value
              size="m"
              value={nutrients ? format.number(nutrients[key], 1) : unknownMark}
              unit={t("grams")}
            />
            <Text variant="readoutXS" tone="muted">
              {nutrients && energy > 0
                ? format.percent((nutrients[key] * kcal) / energy)
                : unknownMark}
            </Text>
          </View>
        ))}
      </View>
      {!!targets && (
        <View className="gap-2">
          <Label accessibilityRole="header">{t("impactOnTargets")}</Label>
          <View className="flex-row justify-between">
            {rings.map(([key, label]) => {
              const share = nutrients && targets[key] > 0 ? nutrients[key] / targets[key] : 0;
              return (
                <View
                  key={key}
                  accessible
                  accessibilityLabel={t("shareOfTarget", {
                    label: t(label),
                    percent: format.percent(share),
                  })}
                  className="flex-1 items-center gap-1"
                >
                  <Ring value={share}>
                    <Text variant="readoutXS">{format.percent(share)}</Text>
                  </Ring>
                  <Text variant="caption" tone="muted">
                    {t(label)}
                  </Text>
                </View>
              );
            })}
          </View>
        </View>
      )}
      <FoodNutrients nutrients={nutrients} />
    </View>
  );
}
