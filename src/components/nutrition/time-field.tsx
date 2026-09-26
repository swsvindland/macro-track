import { useState } from "react";
import { View } from "react-native";
import { FieldError, Input, Label, TextField } from "heroui-native";
import { SystemButton, SystemText as Text } from "@/components/system";
import { currentFoodTime, normalizeFoodTime } from "@/lib/food-time";
export function TimeField({
  value,
  onChange,
  allowEmpty = false,
}: {
  value: string;
  onChange: (time: string) => void;
  allowEmpty?: boolean;
}) {
  // What was typed, shown until blur while it still reads as the current value.
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft !== null && (normalizeFoodTime(draft) ?? draft) === value ? draft : value;
  const invalid = draft === null && !!value && !normalizeFoodTime(value);
  function set(time: string) {
    setDraft(null);
    onChange(time);
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
        <FieldError>Enter a time such as 930, 9:30 or 9:30 pm.</FieldError>
      </TextField>
      <View className="flex-row gap-2">
        <SystemButton variant="ghost" onPress={() => set(currentFoodTime())}>
          Now
        </SystemButton>
        {allowEmpty && (
          <SystemButton variant="ghost" onPress={() => set("")}>
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
