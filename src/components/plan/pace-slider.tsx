import { View } from "react-native";
import { Slider, useSlider } from "heroui-native";
import { SystemText as Text } from "@/components/system";
import { formatPace } from "@/lib/metrics";
import { PACES } from "@/lib/program";
import { useStore } from "@/lib/store";

/** The recommended band, under the track where the thumb sits for each of its ends. */
function Band({ from, to }: { from: number; to: number }) {
  const { minValue, maxValue, trackSize, thumbSize } = useSlider();
  const span = trackSize - thumbSize;
  const at = (value: number) => thumbSize / 2 + ((value - minValue) / (maxValue - minValue)) * span;
  return (
    <View className="h-1.5">
      {span > 0 && (
        <View
          className="absolute h-1.5 rounded-full bg-success"
          style={{ left: at(from), width: at(to) - at(from) }}
        />
      )}
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
  const { number, units } = useStore();
  const { min, max, step, best } = PACES[mode];
  const amount = (pace: number) => {
    const hundredths = Math.round(pace * 100);
    return number(pace, hundredths % 100 === 0 ? 0 : hundredths % 10 === 0 ? 1 : 2);
  };
  const percent = (pace: number) => `${amount(pace)}%`;
  // Steps of 0.05 drift in floating point, so each pace lands on its step exactly.
  const set = (pace: number) =>
    onChange(Number(Math.min(max, Math.max(min, Math.round(pace / step) * step)).toFixed(2)));
  const kg =
    Number.isFinite(weightKg) && weightKg > 0
      ? ((weightKg * value) / 100) * (mode === "lose" ? -1 : 1)
      : null;
  const shown = `${percent(value)} of body weight${kg === null ? "" : ` · ${formatPace(kg, units, number)}`}`;
  const range = `${amount(best[0])}–${percent(best[1])}`;
  return (
    <Slider
      value={value}
      onChange={(next) => set(Array.isArray(next) ? next[0] : next)}
      minValue={min}
      maxValue={max}
      step={step}
      className="gap-2"
    >
      <View className="flex-row flex-wrap items-baseline justify-between gap-x-2">
        <Text className="font-semibold">Weekly pace</Text>
        <Text className="text-muted tabular-nums">{shown}</Text>
      </View>
      <Slider.Track>
        <Slider.Fill />
        <Slider.Thumb
          accessibilityLabel="Weekly pace"
          accessibilityHint={`Recommended ${range} of body weight a week`}
          accessibilityValue={{
            min: 0,
            max: 100,
            now: Math.round(((value - min) / (max - min)) * 100),
            text: shown,
          }}
          accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
          onAccessibilityAction={(event) =>
            set(value + (event.nativeEvent.actionName === "increment" ? step : -step))
          }
        />
      </Slider.Track>
      <Band from={best[0]} to={best[1]} />
      <View className="flex-row items-center justify-between gap-2">
        <Text className="text-xs text-muted tabular-nums">{percent(min)}</Text>
        <Text className="shrink text-center text-xs text-success">Recommended {range}</Text>
        <Text className="text-xs text-muted tabular-nums">{percent(max)}</Text>
      </View>
      {value > best[1] && (
        <Text className="text-sm text-muted">
          {mode === "lose"
            ? "Faster than 1% a week suits a short mini-cut of 2–4 weeks."
            : "Faster than 0.25% a week adds more fat alongside the muscle."}
        </Text>
      )}
    </Slider>
  );
}
