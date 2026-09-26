import { useEffect, useState, type ReactNode } from "react";
import { Keyboard, Platform, Pressable, ScrollView, View } from "react-native";
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
  formatCount,
  parseAmount,
  typeAmount,
  unitStep,
  type Nutrients,
  type PortionUnit,
  type Targets,
} from "@/lib/nutrition";
import { useStore } from "@/lib/store";

/** The amount field: text in one of the food's units. `fresh` text is replaced by the next key. */
export type AmountDraft = { unit: string; text: string; fresh: boolean };

const keys = [
  ["1", "2", "3", "/"],
  ["4", "5", "6", " "],
  ["7", "8", "9", "⌫"],
];
const keyNames: Record<string, string> = {
  "/": "Fraction",
  " ": "Space",
  "⌫": "Delete",
  ".": "Decimal point",
};

function Key({ value, onPress }: { value: string; onPress: () => void }) {
  return (
    <SystemButton
      variant="secondary"
      className="h-12 min-h-12 flex-1 rounded-xl px-0 py-0"
      accessibilityLabel={keyNames[value] ?? value}
      onPress={onPress}
    >
      {value === "⌫" ? (
        <SystemIcon name="backspace-outline" size={22} />
      ) : (
        <Text className="text-xl tabular-nums">{value === " " ? "␣" : value}</Text>
      )}
    </SystemButton>
  );
}

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
 * Amount entry without the system keyboard: the field, ± steppers, the food's units and a
 * keypad whose last row carries the screen's actions. Typing a number and then a unit keeps
 * the number; a prefilled or stepped amount converts to the new unit instead.
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
  // While the system keyboard types another field (an entry's time), only the actions stay, so
  // the keypad doesn't stack on the keyboard over that field.
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    const ios = Platform.OS === "ios";
    const shown = Keyboard.addListener(ios ? "keyboardWillShow" : "keyboardDidShow", () =>
      setTyping(true)
    );
    const hidden = Keyboard.addListener(ios ? "keyboardWillHide" : "keyboardDidHide", () =>
      setTyping(false)
    );
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);
  const unit = units.find((row) => row.key === value.unit) ?? units[0];
  const count = parseAmount(value.text);
  const step = unitStep(unit);
  const set = (next: number, target = unit) =>
    onChange({ unit: target.key, text: formatCount(next, target), fresh: true });
  const more = () => set(count > 0 ? count + step : step);
  const less = () => count - step > 0 && set(count - step);
  const type = (key: string) =>
    onChange({ ...value, text: typeAmount(value.text, key, value.fresh), fresh: false });
  const stepLabel = `${formatCount(step, unit)} ${unit.label}`;
  const choose = (next: PortionUnit) => {
    if (next.key === unit.key) return;
    if (!value.fresh && count > 0)
      return onChange({ unit: next.key, text: value.text, fresh: true });
    const converted = convertCount(units, unit.key, count, next.key);
    set(converted > 0 ? converted : unitStep(next) === 10 ? 100 : 1, next);
  };
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
  const buttons = actions.map((action, i) => (
    <SystemButton
      key={action.label}
      variant={i === actions.length - 1 ? "primary" : "secondary"}
      className={twMerge(
        "h-12 min-h-12 flex-1 rounded-xl px-2 py-0",
        actions.length === 1 && "flex-[2]"
      )}
      labelClassName="font-semibold"
      fit
      onPress={action.onPress}
    >
      {action.label}
    </SystemButton>
  ));
  if (typing) return <View className="flex-row gap-1.5">{buttons}</View>;
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
          accessibilityRole="adjustable"
          accessibilityLabel="Amount"
          accessibilityValue={{ text: `${value.text || "0"} ${unit.label}` }}
          accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
          onAccessibilityAction={(event) =>
            event.nativeEvent.actionName === "increment" ? more() : less()
          }
          className="h-12 flex-1 flex-row items-center rounded-2xl border-2 border-accent bg-surface px-3"
          onPress={() => onChange({ ...value, fresh: true })}
        >
          <Text
            className={twMerge(
              "rounded-md px-0.5 font-mono text-xl tabular-nums",
              value.fresh && !!value.text && "bg-accent-soft text-accent-soft-foreground",
              !value.text && "text-muted"
            )}
          >
            {value.text || "0"}
          </Text>
          {!value.fresh && <View className="h-6 w-0.5 rounded-full bg-accent" />}
          <View className="flex-1" />
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
      <View className="gap-1.5">
        {keys.map((row) => (
          <View key={row.join("")} className="flex-row gap-1.5">
            {row.map((key) => (
              <Key key={key} value={key} onPress={() => type(key)} />
            ))}
          </View>
        ))}
        <View className="flex-row gap-1.5">
          {[".", "0"].map((key) => (
            <Key key={key} value={key} onPress={() => type(key)} />
          ))}
          {buttons}
        </View>
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
