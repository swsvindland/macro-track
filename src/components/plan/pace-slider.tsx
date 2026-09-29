import { View } from "react-native";
import { Heading, Meta, Note, Slider, Text, sliderMetrics, useKitFormat } from "@/vector";
import { formatPace } from "@/lib/metrics";
import { PACES } from "@/lib/program";
import { useStore } from "@/lib/store";

/** The recommended band, under the track where the thumb sits for each of its ends. */
function Band({ from, to, min, max }: { from: number; to: number; min: number; max: number }) {
  // Flex from the start edge, so the band mirrors with the slider.
  return (
    <View
      className="h-1 flex-row"
      // The thumb's centre travels between these insets.
      style={{ marginHorizontal: sliderMetrics.inset }}
      importantForAccessibility="no"
    >
      <View style={{ flex: from - min }} />
      <View className="rounded-mark bg-foreground-secondary" style={{ flex: to - from }} />
      <View style={{ flex: max - to }} />
    </View>
  );
}

/**
 * The weekly pace of a cut or bulk as a share of body weight, with the band that suits most
 * people marked under the track and the pace in the user's weight units for `weightKg`.
 */
export function PaceSlider({
  mode,
  value,
  onChange,
  weightKg,
}: {
  mode: keyof typeof PACES;
  value: number;
  onChange: (pace: number) => void;
  weightKg: number;
}) {
  const { units, t } = useStore();
  const format = useKitFormat();
  const { min, max, step, best } = PACES[mode];
  const percent = (pace: number) => format.percent(pace / 100, 2);
  // Steps of 0.05 drift in floating point, so each pace lands on its step exactly.
  const set = (pace: number) =>
    onChange(Number(Math.min(max, Math.max(min, Math.round(pace / step) * step)).toFixed(2)));
  const kg =
    Number.isFinite(weightKg) && weightKg > 0
      ? ((weightKg * value) / 100) * (mode === "lose" ? -1 : 1)
      : null;
  const share = t("percentOfBodyWeight", { percent: percent(value) });
  const recommended = t("recommendedRange", { range: format.range(best[0], best[1], 2) });
  const pace = kg === null ? "" : formatPace(kg, units, format, t);
  return (
    <View className="gap-2">
      <View className="flex-row flex-wrap items-baseline justify-between gap-x-2">
        <Heading level={4}>{t("weeklyPace")}</Heading>
        <Meta items={[share, pace]} />
      </View>
      <Slider
        value={value}
        onChange={set}
        min={min}
        max={max}
        step={step}
        accessibilityLabel={t("weeklyPace")}
        accessibilityHint={recommended}
        valueText={pace ? t("paceValueText", { share, pace }) : share}
      />
      <Band from={best[0]} to={best[1]} min={min} max={max} />
      <View className="flex-row items-center justify-between gap-2">
        <Text variant="readoutXS" tone="muted">
          {percent(min)}
        </Text>
        <Text variant="caption" tone="secondary" className="shrink text-center">
          {recommended}
        </Text>
        <Text variant="readoutXS" tone="muted">
          {percent(max)}
        </Text>
      </View>
      {value > best[1] && <Note>{t(mode === "lose" ? "fastCutNote" : "fastBulkNote")}</Note>}
    </View>
  );
}
