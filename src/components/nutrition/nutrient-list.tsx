import { View } from "react-native";
import { Label, Meter, Note, Text, Value, useKitFormat } from "@/vector";
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

/** Stands in for an amount the record does not list: never 0, which would be a claim. */
const unknownMark = "—";

/** Fewer decimals as amounts grow: 0.4 mg of copper, 12 mg of iron, 1,840 mg of sodium. */
const digits = (value: number) => (value >= 10 || value === 0 ? 0 : value >= 1 ? 1 : 2);

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
  const { t } = useStore();
  const format = useKitFormat();
  const info = nutrientInfo[nutrient];
  const share = amount !== null && info.daily ? amount / info.daily : null;
  const shown = amount === null ? null : format.number(amount, digits(amount));
  const values = {
    nutrient: info.label,
    amount:
      shown === null ? t("unknown") : t("amountUnit", { count: shown, unit: unitLabel(info.unit) }),
  };
  const spoken =
    share === null
      ? t("nutrientAmount", values)
      : t("nutrientAmountDaily", { ...values, percent: format.percent(share) });
  return (
    <View
      accessible
      accessibilityLabel={note ? t("nutrientWithNote", { nutrient: spoken, note }) : spoken}
      className="gap-1 border-b border-separator py-1.5"
    >
      <View className="flex-row items-baseline gap-2">
        <Text
          variant="small"
          tone={info.indent ? "muted" : "default"}
          className={info.indent ? "flex-1 ps-3" : "flex-1"}
        >
          {info.label}
        </Text>
        {shown === null ? (
          <Text variant="readoutS">{unknownMark}</Text>
        ) : (
          <Value value={shown} unit={unitLabel(info.unit)} />
        )}
        <View className="min-w-11">
          <Text variant="readoutXS" tone="muted" className="text-right">
            {share === null ? "" : format.percent(share)}
          </Text>
        </View>
      </View>
      {/* Limits turn warning past their Daily Value; amounts to reach just fill up. */}
      {bar && share !== null && amount !== null && !!info.daily && (
        <Meter
          size="sm"
          value={amount}
          max={info.daily}
          over={info.limit ? "warning" : "none"}
          accessibilityLabel={info.label}
          valueText={format.percent(share)}
        />
      )}
      {!!note && (
        <Text variant="caption" tone="muted">
          {note}
        </Text>
      )}
    </View>
  );
}

/**
 * The nutrients a food's record lists, for the amount chosen, with each Daily Value share.
 * Fiber and sodium always show, as "—" when unknown; other nutrients only when listed.
 */
export function FoodNutrients({ nutrients }: { nutrients: Nutrients | null }) {
  const { t } = useStore();
  const listed = (key: Detail) => key === "fiber" || key === "sodium" || nutrients?.[key] != null;
  return (
    <View className="gap-3">
      {nutrientGroups.map(({ group, keys }) => {
        const shown = keys.filter(listed);
        if (!shown.length) return null;
        return (
          <View key={group}>
            <Label accessibilityRole="header">{group}</Label>
            {shown.map((key) => (
              <Row key={key} nutrient={key} amount={nutrients?.[key] ?? null} />
            ))}
          </View>
        );
      })}
      <Text variant="caption" tone="muted">
        {t("dailyValueNote")}
      </Text>
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
  const { t } = useStore();
  const format = useKitFormat();
  const totals = knownTotals(items);
  return (
    <Editor title={title} open={open} close={close} compact>
      <Note>{t("dayNutrientsIntro")}</Note>
      {nutrientGroups.map(({ group, keys }) => (
        <View key={group}>
          <Label accessibilityRole="header">{group}</Label>
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
                    ? t("fromFoods", {
                        known: format.number(known),
                        total: format.number(items.length),
                      })
                    : undefined
                }
              />
            );
          })}
        </View>
      ))}
      <Text variant="caption" tone="muted">
        {t("dailyValueLimitsNote")}
      </Text>
    </Editor>
  );
}
