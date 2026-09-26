import { SystemText as Text } from "@/components/system";

/** A food's emoji at one small size. Screen readers skip it; the name beside it says the same. */
export function FoodIcon({ icon }: { icon: string }) {
  return (
    <Text
      accessibilityElementsHidden
      importantForAccessibility="no"
      allowFontScaling={false}
      className="w-7 text-center text-xl leading-7"
    >
      {icon}
    </Text>
  );
}
