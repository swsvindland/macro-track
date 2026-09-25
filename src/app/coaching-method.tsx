import { useState } from "react";
import { Linking } from "react-native";
import { router } from "expo-router";
import { ErrorText, Screen } from "@/components/ui";
import { SystemButton, SystemPanel, SystemText as Text } from "@/components/system";
const sections = [
  [
    "A program built around your goal",
    "Choose Cut, Bulk or Maintain, your goal weight and pace. Age, height, weight, the selected sex equation and activity provide a provisional starting estimate. Protein and diet preferences determine your macros. Manual targets remain available.",
  ],
  [
    "Normalized weight",
    "Coaching and Progress use the same recent-weighted trend with a seven-day half-life. Same-day readings are averaged. The trend reduces the influence of individual scale fluctuations. It is an estimate, not a measurement of body fat.",
  ],
  [
    "Learning from actual intake",
    "Method 2 examines the previous 21 calendar days. It uses complete contiguous blocks of at least seven days, matching calories and weight changes over those dates. Twelve covered days and six weigh-in days are needed. Small gaps can leave enough usable blocks; missing intake is never assumed to be zero. Explicit fasting counts as zero. Long gaps pause learning without erasing the last estimate.",
  ],
  [
    "Gradual adjustments",
    "Estimated expenditure uses reported calories and changes in normalized weight, with a short-term 7,700 kcal/kg approximation. New evidence is damped toward the previous reviewed estimate. Suggested weekly calorie changes are limited to 150 kcal or 7.5%, whichever is smaller. This is our own approximate method, not MacroFactor’s proprietary model or a clinically validated prediction.",
  ],
  [
    "Macros that follow your preferences",
    "Protein follows normalized body weight and your chosen grams per kg. Remaining calories go to carbs and fat according to your preference, with a 0.6 g/kg fat floor. Changes are based on actual intake, not whether you hit your old targets.",
  ],
  [
    "Maintenance and reaching your goal",
    "Maintenance aims for your selected weight with a 0.7 kg band. Outside that band, a gentle 0.15% weekly correction nudges the plan toward your goal. A cut or bulk that reaches its goal stops requesting further loss or gain. Switch to Maintain to hold that weight.",
  ],
  [
    "Review, then apply",
    "Check-ins follow your chosen weekday. Review the generated plan and accept or keep your current targets. Accepted changes start today and preserve earlier days. Editing a goal keeps food, weight and learned expenditure history.",
  ],
  [
    "Supported scope",
    "Coaching is for adults 18+ who are not pregnant or breastfeeding. Medical nutrition needs and eating disorder care require professional guidance. Targets outside 1,500–5,000 kcal/day, implausible expenditure, rapid changes or sharp weight jumps hold adjustments. These product limits are not individualized safety thresholds.",
  ],
  [
    "Older plans",
    "Plans created before guided program setup keep method 1 until you choose Build my program. Earlier check-ins retain the method that produced them.",
  ],
];
export default function CoachingMethod() {
  const [error, setError] = useState("");
  return (
    <Screen
      title="How check-ins work"
      subtitle="Local coaching · Method 2"
      action={
        <SystemButton variant="ghost" onPress={() => router.back()}>
          Done
        </SystemButton>
      }
    >
      {sections.map(([title, body]) => (
        <SystemPanel key={title}>
          <SystemPanel.Body className="gap-3">
            <Text className="text-lg font-semibold">{title}</Text>
            <Text className="text-muted">{body}</Text>
          </SystemPanel.Body>
        </SystemPanel>
      ))}
      <Text className="font-semibold">Background reading (opens your browser)</Text>
      <SystemButton
        variant="secondary"
        onPress={() => {
          void Linking.openURL(
            "https://www.niddk.nih.gov/research-funding/at-niddk/labs-branches/laboratory-biological-modeling/integrative-physiology-section/research/body-weight-planner"
          ).catch(() => setError("Could not open the source. Try again when connected."));
        }}
      >
        NIDDK: dynamic weight models and limitations
      </SystemButton>
      <ErrorText message={error} />
    </Screen>
  );
}
