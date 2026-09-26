import { useState } from "react";
import { View } from "react-native";
import { useCalendars } from "expo-localization";
import { Calendar, DatePicker, TimePicker } from "heroui-native-pro";
import { parseDate } from "@internationalized/date";
import { SystemButton, SystemText as Text } from "@/components/system";
import { useEditorPortalHost } from "@/components/ui";
import {
  clockMinutes,
  clockPlus,
  currentFoodTime,
  formatClock,
  validFoodTime,
} from "@/lib/food-time";
import { dayLabel, localDay } from "@/lib/metrics";
import { useStore } from "@/lib/store";

// One tap for the usual corrections: eaten just now or a little while ago.
const chips = [
  ["Now", 0, "Now"],
  ["−15 m", 15, "15 minutes ago"],
  ["−30 m", 30, "30 minutes ago"],
  ["−1 h", 60, "1 hour ago"],
] as const;

/**
 * When a food was eaten. Given a day, the date sits beside the time on one row: the day rarely
 * changes, so it doesn't earn a field of its own.
 */
export function TimeField({
  value,
  onChange,
  allowEmpty = false,
  day,
  onDayChange,
}: {
  value: string;
  onChange: (time: string) => void;
  allowEmpty?: boolean;
  day?: string;
  onDayChange?: (day: string) => void;
}) {
  const { language } = useStore();
  const [calendar] = useCalendars();
  const locale = language === "zh" ? "zh-CN" : language;
  const hostName = useEditorPortalHost();
  const [picking, setPicking] = useState(false);
  // The picker holds "HH:mm:ss"; the diary keeps "HH:mm". Anything else shows as unset.
  const time = validFoodTime(value) ? value : null;
  // The chips keep the day, so one that would reach back past midnight is off, not 00:00.
  const now = clockMinutes(currentFoodTime());
  return (
    <View className="gap-2">
      <View className="flex-row gap-2">
        {day !== undefined && onDayChange && (
          <DatePicker
            className="flex-1"
            value={{ value: day, label: dayLabel(day, locale) }}
            onValueChange={(option) => option && onDayChange(option.value)}
            isOpen={picking}
            onOpenChange={setPicking}
            locale={locale}
            formatDate={(picked) => dayLabel(picked.toString(), locale)}
          >
            <DatePicker.Select presentation="dialog">
              <DatePicker.Trigger accessibilityLabel="Date" className="border-field-border">
                <DatePicker.Value />
                <DatePicker.TriggerIndicator />
              </DatePicker.Trigger>
              <DatePicker.Portal hostName={hostName} disableFullWindowOverlay>
                <DatePicker.Overlay />
                <DatePicker.Content presentation="dialog">
                  <DatePicker.Calendar
                    accessibilityLabel="Date"
                    minValue={parseDate("1900-01-01")}
                    maxValue={parseDate(localDay())}
                  >
                    <Calendar.Header>
                      <Calendar.Heading />
                      <Calendar.NavButton slot="previous" />
                      <Calendar.NavButton slot="next" />
                    </Calendar.Header>
                    <Calendar.Grid>
                      <Calendar.GridHeader>
                        {(weekday) => <Calendar.HeaderCell day={weekday} />}
                      </Calendar.GridHeader>
                      <Calendar.GridBody>
                        {(date) => <Calendar.Cell date={date} />}
                      </Calendar.GridBody>
                    </Calendar.Grid>
                  </DatePicker.Calendar>
                </DatePicker.Content>
              </DatePicker.Portal>
            </DatePicker.Select>
          </DatePicker>
        )}
        <TimePicker
          className="flex-1"
          value={time ? { value: `${time}:00`, label: formatClock(time, locale) } : undefined}
          onValueChange={(option) => option && onChange(option.value.slice(0, 5))}
          hourFormat={calendar?.uses24hourClock ? 24 : 12}
          locale={locale}
          formatTime={(picked) => formatClock(picked.toString().slice(0, 5), locale)}
        >
          <TimePicker.Select presentation="dialog">
            <TimePicker.Trigger accessibilityLabel="Time" className="border-field-border">
              <TimePicker.Value placeholder="Choose a time" />
              <TimePicker.TriggerIndicator />
            </TimePicker.Trigger>
            <TimePicker.Portal hostName={hostName} disableFullWindowOverlay>
              <TimePicker.Overlay />
              <TimePicker.Content presentation="dialog">
                <TimePicker.Wheel />
              </TimePicker.Content>
            </TimePicker.Portal>
          </TimePicker.Select>
        </TimePicker>
      </View>
      <View className="flex-row flex-wrap gap-2">
        {chips.map(([label, minutes, spoken]) => (
          <SystemButton
            key={label}
            variant="secondary"
            className="min-h-9 px-3 py-1.5"
            hitSlop={{ top: 4, bottom: 4 }}
            accessibilityLabel={spoken}
            isDisabled={minutes > now}
            onPress={() => onChange(clockPlus(currentFoodTime(), -minutes))}
          >
            {label}
          </SystemButton>
        ))}
        {allowEmpty && (
          <SystemButton
            variant="ghost"
            className="min-h-9 px-3 py-1.5"
            hitSlop={{ top: 4, bottom: 4 }}
            onPress={() => onChange("")}
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
