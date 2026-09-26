import { useState } from "react";
import { View } from "react-native";
import { Description, FieldError, Input, Label, TextField } from "heroui-native";
import { SystemButton, SystemText as Text } from "@/components/system";
import { clockPlus, currentFoodTime, formatClock, normalizeFoodTime } from "@/lib/food-time";
import { useStore } from "@/lib/store";

// One tap for the usual corrections: eaten just now or a little while ago.
const chips = [
  ["Now", 0, "Now"],
  ["−15 m", 15, "15 minutes ago"],
  ["−30 m", 30, "30 minutes ago"],
  ["−1 h", 60, "1 hour ago"],
] as const;

export function TimeField({
  value,
  onChange,
  allowEmpty = false,
}: {
  value: string;
  onChange: (time: string) => void;
  allowEmpty?: boolean;
}) {
  const { language } = useStore();
  // What was typed, shown until blur while it still reads as the current value.
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft !== null && (normalizeFoodTime(draft) ?? draft) === value ? draft : value;
  const invalid = draft === null && !!value && !normalizeFoodTime(value);
  const time = normalizeFoodTime(value);
  // The clock as Home shows it, when that differs from what is in the field.
  const clock = time && formatClock(time, language === "zh" ? "zh-CN" : language);
  function set(next: string) {
    setDraft(null);
    onChange(next);
  }
  return (
    <View className="gap-2">
      <TextField isInvalid={invalid}>
        <Label>Time</Label>
        <Input
          accessibilityLabel="Time"
          variant="primary"
          className="font-mono focus:border-focus"
          value={text}
          onChangeText={(input) => {
            setDraft(input);
            onChange(normalizeFoodTime(input) ?? input);
          }}
          onBlur={() => setDraft(null)}
          keyboardType="numbers-and-punctuation"
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="14:30"
        />
        {!!clock && clock !== text && <Description hideOnInvalid>{clock}</Description>}
        <FieldError>Enter a time such as 930, 9:30 or 9:30 pm.</FieldError>
      </TextField>
      <View className="flex-row flex-wrap gap-2">
        {chips.map(([label, minutes, spoken]) => (
          <SystemButton
            key={label}
            variant="secondary"
            className="min-h-9 px-3 py-1.5"
            hitSlop={{ top: 4, bottom: 4 }}
            accessibilityLabel={spoken}
            onPress={() => set(clockPlus(currentFoodTime(), -minutes))}
          >
            {label}
          </SystemButton>
        ))}
        {allowEmpty && (
          <SystemButton
            variant="ghost"
            className="min-h-9 px-3 py-1.5"
            hitSlop={{ top: 4, bottom: 4 }}
            onPress={() => set("")}
          >
            Leave time unset
          </SystemButton>
        )}
      </View>
      {allowEmpty && !value && (
        <Text className="text-sm text-muted">This older entry has no recorded time.</Text>
      )}
    </View>
  );
}
