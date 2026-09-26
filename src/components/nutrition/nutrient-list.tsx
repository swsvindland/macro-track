import { View } from "react-native";
import { twMerge } from "tailwind-merge";
import { SystemLabel, SystemText as Text } from "@/components/system";
import { Editor } from "@/components/ui";
import {
  knownTotals,
  nutrientGroups,
  nutrientInfo,
  unitLabel,
  type Detail,
  type Nutrients,
} from "@/lib/nutrition";
import { useStore } from "@/lib/store";

/** Fewer decimals as amounts grow: 0.4 mg of copper, 12 mg of iron, 1,840 mg of sodium. */
const digits = (value: number) => (value >= 10 || value === 0 ? 0 : value >= 1 ? 1 : 2);

function DailyBar({ share, limit }: { share: number; limit: boolean }) {
  return (
    <View className="h-1 overflow-hidden rounded-full bg-border">
      <View
        className={twMerge(
          "h-1 rounded-full",
          limit && share > 1 ? "bg-warning" : share >= 1 ? "bg-accent" : "bg-muted"
        )}
        style={{ width: `${Math.min(share, 1) * 100}%` }}
      />
    </View>
  );
}

function Row({
  nutrient,
  amount,
  note,
  bar = false,
}: {
  nutrient: Detail;
  amount: number | null;
  note?: string;
  bar?: boolean;
}) {
  const { number } = useStore();
  const info = nutrientInfo[nutrient];
  const share = amount !== null && info.daily ? amount / info.daily : null;
  const text = amount === null ? "—" : `${number(amount, digits(amount))} ${unitLabel(info.unit)}`;
  return (
    <View
      accessible
      accessibilityLabel={`${info.label}: ${amount === null ? "unknown" : text}${
        share === null ? "" : `, ${Math.round(share * 100)}% of the Daily Value`
      }${note ? `, ${note}` : ""}`}
      className="gap-1 border-b border-separator py-1.5"
    >
      <View className="flex-row items-baseline gap-2">
        <Text className={twMerge("flex-1 text-sm", info.indent ? "pl-3 text-muted" : "")}>
          {info.label}
        </Text>
        <Text className="text-sm tabular-nums">{text}</Text>
        <Text className="w-11 text-right text-xs text-muted tabular-nums">
          {share === null ? "" : `${Math.round(share * 100)}%`}
        </Text>
      </View>
      {bar && share !== null && <DailyBar share={share} limit={!!info.limit} />}
      {!!note && <Text className="text-xs text-muted">{note}</Text>}
    </View>
  );
}

/**
 * The nutrients a food's record lists, for the amount chosen, with each Daily Value share.
 * Fiber and sodium always show, as "—" when unknown; other nutrients only when listed.
 */
export function FoodNutrients({ nutrients }: { nutrients: Nutrients | null }) {
  const listed = (key: Detail) => key === "fiber" || key === "sodium" || nutrients?.[key] != null;
  return (
    <View className="gap-3">
      {nutrientGroups.map(({ group, keys }) => {
        const shown = keys.filter(listed);
        if (!shown.length) return null;
        return (
          <View key={group}>
            <SystemLabel accessibilityRole="header">{group}</SystemLabel>
            {shown.map((key) => (
              <Row key={key} nutrient={key} amount={nutrients?.[key] ?? null} />
            ))}
          </View>
        );
      })}
      <Text className="text-xs text-muted">% Daily Value for adults, per the FDA.</Text>
    </View>
  );
}

/**
 * A day's nutrients, each summed over the foods whose records list it. Most records list only
 * some nutrients, so a total that leaves foods out says how many it covers.
 */
export function DayNutrients({
  items,
  title,
  open,
  close,
}: {
  items: Nutrients[];
  title: string;
  open: boolean;
  close: () => void;
}) {
  const totals = knownTotals(items);
  return (
    <Editor title={title} open={open} close={close} compact>
      <Text className="text-sm text-muted">
        Totals count the foods whose records list each nutrient. Packaged foods often list only what
        their label must.
      </Text>
      {nutrientGroups.map(({ group, keys }) => (
        <View key={group}>
          <SystemLabel accessibilityRole="header">{group}</SystemLabel>
          {keys.map((key) => {
            const { amount, known } = totals[key];
            return (
              <Row
                key={key}
                nutrient={key}
                amount={known ? amount : null}
                bar
                note={
                  known && known < items.length
                    ? `From ${known} of ${items.length} foods`
                    : undefined
                }
              />
            );
          })}
        </View>
      ))}
      <Text className="text-xs text-muted">
        % Daily Value for adults, per the FDA. Sodium, saturated fat, added sugars and cholesterol
        are limits; the rest are amounts to reach.
      </Text>
    </Editor>
  );
}
