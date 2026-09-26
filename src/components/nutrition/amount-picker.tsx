import { useRef, type ReactNode } from "react";
import { Platform, Pressable, ScrollView, TextInput, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { useThemeColor } from "heroui-native";
import { twMerge } from "tailwind-merge";
import {
  SystemButton,
  SystemIcon,
  SystemIconButton,
  SystemLabel,
  SystemText as Text,
} from "@/components/system";
import {
  convertCount,
  countLike,
  editAmount,
  formatCount,
  parseAmount,
  unitStep,
  type Nutrients,
  type PortionUnit,
  type Targets,
} from "@/lib/nutrition";
import { useStore } from "@/lib/store";

/** The amount field: text in one of the food's units. `fresh` text is replaced by the next key. */
export type AmountDraft = { unit: string; text: string; fresh: boolean };

function UnitChip({
  unit,
  selected,
  onPress,
}: {
  unit: PortionUnit;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <SystemButton
      variant="ghost"
      className={twMerge(
        "gap-1 rounded-full border-2 px-3.5 py-1.5",
        selected ? "border-foreground bg-foreground" : "border-border bg-surface-secondary"
      )}
      accessibilityLabel={unit.label}
      accessibilityState={{ selected }}
      onPress={onPress}
    >
      {selected && <SystemIcon name="checkmark" size={16} color="background" />}
      <Text className={selected ? "font-semibold text-background" : "text-foreground"}>
        {unit.label}
      </Text>
    </SystemButton>
  );
}

/**
 * Amount entry on the system keyboard, which opens with the sheet: the field, ± steppers, the
 * food's units and the screen's actions above the keyboard. Counted units get a keyboard with
 * "/" and space for "1 1/2". Typing a number and then a unit keeps the number; a prefilled or
 * stepped amount converts to the new unit instead, and stays selected so typing replaces it.
 */
export function AmountPicker({
  units,
  value,
  onChange,
  actions,
}: {
  units: PortionUnit[];
  value: AmountDraft;
  onChange: (value: AmountDraft) => void;
  /** One or two actions; the last is the primary one. */
  actions: { label: string; onPress: () => void }[];
}) {
  const input = useRef<TextInput>(null);
  const muted = String(useThemeColor("muted"));
  const unit = units.find((row) => row.key === value.unit) ?? units[0];
  const count = parseAmount(value.text);
  const step = unitStep(unit);
  const set = (next: number, target = unit) =>
    onChange({ unit: target.key, text: formatCount(next, target), fresh: true });
  const more = () => set(count > 0 ? count + step : step);
  const less = () => count - step > 0 && set(count - step);
  const stepLabel = `${formatCount(step, unit)} ${unit.label}`;
  const choose = (next: PortionUnit) => {
    if (next.key === unit.key) return;
    if (!value.fresh && count > 0)
      return onChange({ unit: next.key, text: value.text, fresh: true });
    const converted = convertCount(units, unit.key, count, next.key);
    set(converted > 0 ? converted : unitStep(next) === 10 ? 100 : 1, next);
  };
  const fractions = countLike(unit);
  const measures = units.filter((row) => row.kind === "mass" || row.kind === "volume");
  const own = units.filter((row) => row.kind === "count" || row.kind === "energy");
  const chip = (row: PortionUnit) => (
    <UnitChip
      key={row.key}
      unit={row}
      selected={row.key === unit.key}
      onPress={() => choose(row)}
    />
  );
  return (
    <View className="gap-2">
      <View className="flex-row items-center gap-2">
        <SystemIconButton
          icon="remove"
          variant="secondary"
          accessibilityLabel={`Decrease by ${stepLabel}`}
          isDisabled={!(count - step > 0)}
          onPress={less}
        />
        <Pressable
          accessible={false}
          className="h-12 flex-1 flex-row items-center rounded-2xl border-2 border-accent bg-surface px-3"
          onPress={() => input.current?.focus()}
        >
          <TextInput
            ref={input}
            autoFocus
            accessibilityLabel={`Amount in ${unit.label}`}
            className="h-full flex-1 font-mono text-xl tabular-nums text-foreground"
            placeholder="0"
            placeholderTextColor={muted}
            value={value.text}
            // A prefilled or stepped amount stays selected so the first key replaces it.
            selection={value.fresh ? { start: 0, end: value.text.length } : undefined}
            selectTextOnFocus
            onChangeText={(next) =>
              onChange({ ...value, text: editAmount(value.text, next), fresh: false })
            }
            keyboardType={
              !fractions
                ? "decimal-pad"
                : Platform.OS === "ios"
                  ? "numbers-and-punctuation"
                  : "default"
            }
            returnKeyType="done"
            autoCorrect={false}
            autoComplete="off"
          />
          <Text className="text-muted">{unit.label}</Text>
        </Pressable>
        <SystemIconButton
          icon="add"
          variant="secondary"
          accessibilityLabel={`Increase by ${stepLabel}`}
          onPress={more}
        />
      </View>
      {units.length > 1 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          className="-mx-4"
          contentContainerClassName="items-center gap-2 px-4"
        >
          {measures.map(chip)}
          {!!measures.length && !!own.length && <View className="mx-1 h-6 w-px bg-separator" />}
          {own.map(chip)}
        </ScrollView>
      )}
      <View className="flex-row gap-1.5">
        {actions.map((action, i) => (
          <SystemButton
            key={action.label}
            variant={i === actions.length - 1 ? "primary" : "secondary"}
            className="h-12 min-h-12 flex-1 rounded-xl px-2 py-0"
            labelClassName="font-semibold"
            fit
            onPress={action.onPress}
          >
            {action.label}
          </SystemButton>
        ))}
      </View>
    </View>
  );
}

/** A progress ring; past 100% it is full and amber. */
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
  const fill = String(useThemeColor(value > 1 ? "warning" : "accent-soft-foreground"));
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
            strokeLinecap="round"
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
  const { number } = useStore();
  return (
    <View
      accessible
      accessibilityLabel={
        target
          ? `${number(calories, 0)} of ${number(target, 0)} calories for the day, with these foods`
          : `${number(calories, 0)} calories for the day, with these foods`
      }
      className="flex-row items-center gap-2 rounded-full bg-surface-secondary py-1 pl-1 pr-3"
    >
      {!!target && <Ring value={calories / target} size={28} width={4} />}
      <Text className="text-sm font-medium tabular-nums">
        {target ? `${number(calories, 0)} / ${number(target, 0)}` : `${number(calories, 0)} kcal`}
      </Text>
    </View>
  );
}

const macros = [
  ["protein", "Protein", 4],
  ["fat", "Fat", 9],
  ["carbs", "Carbs", 4],
] as const;
const rings = [["calories", "Calories"], ...macros] as const;

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
  const { number } = useStore();
  const energy = nutrients
    ? macros.reduce((sum, [key, , kcal]) => sum + nutrients[key] * kcal, 0)
    : 0;
  return (
    <View className="gap-4">
      <View className="flex-row items-end gap-2">
        <View className="flex-[1.3]">
          <Text
            className="text-4xl font-semibold tabular-nums"
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.6}
            maxFontSizeMultiplier={1.35}
          >
            {nutrients ? number(nutrients.calories, 0) : "—"}
          </Text>
          <Text className="text-sm text-muted">Calories</Text>
        </View>
        {macros.map(([key, label, kcal]) => (
          <View key={key} className="flex-1 items-center gap-0.5">
            <View className="rounded-full bg-surface-secondary px-2 py-0.5">
              <Text className="text-xs tabular-nums">
                {nutrients && energy > 0
                  ? `${Math.round((nutrients[key] * kcal * 100) / energy)}%`
                  : "—"}
              </Text>
            </View>
            <Text className="text-lg font-semibold tabular-nums">
              {nutrients ? number(nutrients[key], 1) : "—"}
            </Text>
            <Text className="text-sm text-muted">{label}</Text>
          </View>
        ))}
      </View>
      {!!targets && (
        <View className="gap-2">
          <SystemLabel accessibilityRole="header">Impact on targets</SystemLabel>
          <View className="flex-row justify-between">
            {rings.map(([key, label]) => {
              const share = nutrients && targets[key] > 0 ? nutrients[key] / targets[key] : 0;
              return (
                <View
                  key={key}
                  accessible
                  accessibilityLabel={`${label}: ${Math.round(share * 100)}% of the day's target`}
                  className="flex-1 items-center gap-1"
                >
                  <Ring value={share}>
                    <Text className="text-xs tabular-nums">{`${Math.round(share * 100)}%`}</Text>
                  </Ring>
                  <Text className="text-xs text-muted">{label}</Text>
                </View>
              );
            })}
          </View>
        </View>
      )}
      <View>
        {(
          [
            ["Fiber", nutrients?.fiber, "g"],
            ["Sodium", nutrients?.sodium, "mg"],
          ] as const
        ).map(([label, amount, unit]) => (
          <View key={label} className="flex-row justify-between border-b border-separator py-1.5">
            <Text className="text-sm text-muted">{label}</Text>
            <Text className="text-sm tabular-nums">
              {amount == null ? "—" : `${number(amount, unit === "mg" ? 0 : 1)} ${unit}`}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}
