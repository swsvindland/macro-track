import { View } from "react-native";
import { Field } from "@/components/ui";
import { SystemButton, SystemText as Text } from "@/components/system";
import { currentFoodTime } from "@/lib/food-time";
export function TimeField({
  value,
  onChange,
  allowEmpty = false,
}: {
  value: string;
  onChange: (time: string) => void;
  allowEmpty?: boolean;
}) {
  return (
    <View className="gap-2">
      <Field label="Time (24-hour, HH:mm)" value={value} onChange={onChange} placeholder="14:30" />
      <View className="flex-row gap-2">
        <SystemButton variant="ghost" onPress={() => onChange(currentFoodTime())}>
          Now
        </SystemButton>
        {allowEmpty && (
          <SystemButton variant="ghost" onPress={() => onChange("")}>
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
