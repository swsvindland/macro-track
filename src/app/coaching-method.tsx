import { useState } from "react";
import { Linking } from "react-native";
import { router } from "expo-router";
import { ErrorText, Screen } from "@/components/ui";
import { SystemButton, SystemPanel, SystemText as Text } from "@/components/system";
const sections = [
  [
    "Start with your own targets",
    "Set daily calories and macros in Plan. They are your starting baseline, not a measured energy requirement. Choose lose, maintain or gain to enable coaching, or stay in manual mode. Changing your goal starts a fresh 21-day calibration.",
  ],
  [
    "Build a complete picture",
    "Reviews use the 21 calendar days before today. Each day must be marked complete, with at least three weigh-in days in each week. Blank, partial and fasting days pause adjustments. A missed day is never counted as zero food. Multiple weights on one day are averaged.",
  ],
  [
    "How the estimate works",
    "A straight-line trend summarizes your weight over those dates. Estimated daily expenditure is your average logged calories minus daily weight change in kg multiplied by 7,700. This short-term approximation is not a measurement of metabolism or a long-term prediction. Systematic logging errors and water shifts can bias it. Wearable exercise calories are not added again.",
  ],
  [
    "Small changes, reviewed by you",
    "The selected pace is a percentage of your average body weight per week. We suggest a calorie target toward that pace, limiting a weekly change to 100 kcal or 5% of the current target, whichever is smaller. Macros retain your chosen proportions. Nothing changes until you accept. You can keep or manually edit targets instead. Check-ins are seven days apart.",
  ],
  [
    "When we hold steady",
    "We hold changes if weekly weight movement exceeds 1%, daily trend variability exceeds 1%, or consecutive readings differ by over 2% of average weight. Estimates outside 1,200–5,000 kcal/day or current/suggested targets outside 1,500–5,000 also pause coaching. These product limits are not personalized safety thresholds, and cannot detect every water shift or logging error.",
  ],
  [
    "Who coaching is for",
    "For adults 18+ who are not pregnant or breastfeeding. Medical nutrition needs and eating disorder care require professional guidance. This first coaching method has automated tests but has not been clinically validated. It is our own local calculation, not MacroFactor’s algorithm.",
  ],
  [
    "Your history stays yours",
    "Reviews, goals and target changes are saved on your device and included in encrypted backups. Accepted changes start today and preserve earlier dates. Food entries retain their nutrition when catalogs or recipes change.",
  ],
];
export default function CoachingMethod() {
  const [error, setError] = useState("");
  return (
    <Screen
      title="How check-ins work"
      subtitle="Local coaching · Method 1"
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
