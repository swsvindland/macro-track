import { useState } from "react";
import { View } from "react-native";
import { InputGroup } from "heroui-native";
// Subpaths, not the heroui-native-pro barrel: the barrel also evaluates Pro's charts. These are the same modules
// the barrel re-exports, so nothing changes on iOS and Android; the web build uses dates.web.tsx instead.
import { Calendar } from "heroui-native-pro/calendar";
import { DateField } from "heroui-native-pro/date-field";
import { TimePicker } from "heroui-native-pro/time-picker";
import { Time, parseDate, parseTime } from "@internationalized/date";
import { useCalendars } from "expo-localization";
import { twMerge } from "tailwind-merge";
import { FieldLabel, dayToDate, fieldEdge, fieldInput, inputEdge, localToday } from "./field-parts";
import { isMonoSafe } from "./format";
import { Icon } from "./icon";
import { KitScope, useEditorPortalHost, useKit, useKitFormat } from "./provider";

// DateInput and TimeInput on iOS and Android (Metro picks dates.web.tsx for the web build). Re-exported by form.tsx.

/**
 * A Field-look trigger with the date as a readout; the Pro calendar opens as a dialog in the Editor's
 * PortalHost, so it shows above the sheet. Selected day = signal fill + signal ink; today = 1pt tint outline.
 */
export function DateInput({
  label,
  value,
  onChange,
  min = "1900-01-01",
  max,
  disabled = false,
  accessibilityLabel,
}: {
  label: string;
  /** YYYY-MM-DD */
  value: string;
  onChange: (value: string) => void;
  min?: string;
  /** Default: today (every current call site records past days). */
  max?: string;
  disabled?: boolean;
  /** What a screen reader calls the field when the visible label needs context ("Start, Monday"). */
  accessibilityLabel?: string;
}) {
  const kit = useKit();
  const format = useKitFormat();
  const host = useEditorPortalHost();
  const [open, setOpen] = useState(false);
  const shown = value ? format.date(dayToDate(value)) : "";
  const name = accessibilityLabel ?? label;
  return (
    <DateField
      value={{ value, label: shown }}
      onValueChange={(option) => onChange(option?.value ?? "")}
      isDisabled={disabled}
      isRequired
      isOpen={open}
      onOpenChange={setOpen}
      locale={format.tag}
      className="gap-2"
    >
      <FieldLabel label={label} />
      <DateField.InputGroup>
        <InputGroup.Input
          accessibilityLabel={name}
          value={shown}
          placeholder={label}
          isDisabled={disabled}
          editable={false}
          onPressIn={() => !disabled && setOpen(true)}
          className={twMerge(fieldInput, inputEdge, isMonoSafe(shown) && "font-mono tabular-nums")}
          style={{ fontSize: 16 }}
        />
        <DateField.Suffix>
          <DateField.Select presentation="dialog">
            <DateField.Trigger accessibilityLabel={name} hitSlop={8}>
              <Icon name="date" tone="muted" />
            </DateField.Trigger>
            <DateField.Portal hostName={host} disableFullWindowOverlay>
              <KitScope value={kit}>
                <DateField.Overlay />
                <DateField.Content presentation="dialog">
                  <DateField.Calendar
                    accessibilityLabel={name}
                    minValue={parseDate(min)}
                    maxValue={parseDate(max ?? localToday())}
                  >
                    <Calendar.Header>
                      <Calendar.Heading />
                      <Calendar.NavButton slot="previous" />
                      <Calendar.NavButton slot="next" />
                    </Calendar.Header>
                    <Calendar.Grid>
                      <Calendar.GridHeader>
                        {(day) => <Calendar.HeaderCell day={day} />}
                      </Calendar.GridHeader>
                      <Calendar.GridBody>
                        {(date) => (
                          <Calendar.Cell date={date}>
                            {(cell) => (
                              <Calendar.CellBody
                                cellRenderProps={cell}
                                isAnimatedStyleActive={false}
                                // Today is a tint outline, not HeroUI's accent-soft wash; selected is the icon look.
                                className="data-[today=true]:border data-[today=true]:border-tint data-[today=true]:bg-transparent data-[selected=true]:border-accent data-[selected=true]:bg-accent data-[selected=true]:shadow-none"
                              >
                                <Calendar.CellLabel
                                  cellRenderProps={cell}
                                  className="data-[today=true]:text-foreground data-[selected=true]:text-accent-foreground"
                                >
                                  {cell.formattedDate}
                                </Calendar.CellLabel>
                                {cell.isSelected ? (
                                  // The non-colour cue §2.4 requires with a cyan fill (1.81:1 on white): a check in
                                  // the 40pt cell's top end corner, clear of the 14pt day number.
                                  <View
                                    className="absolute end-0.5 top-0.5"
                                    importantForAccessibility="no-hide-descendants"
                                    accessibilityElementsHidden
                                  >
                                    <Icon name="check" size={12} tone="onSignal" />
                                  </View>
                                ) : null}
                              </Calendar.CellBody>
                            )}
                          </Calendar.Cell>
                        )}
                      </Calendar.GridBody>
                    </Calendar.Grid>
                  </DateField.Calendar>
                </DateField.Content>
              </KitScope>
            </DateField.Portal>
          </DateField.Select>
        </DateField.Suffix>
      </DateField.InputGroup>
    </DateField>
  );
}

/** Replaces water's time-picker.tsx: the Pro wheel in a dialog, the device 12/24-hour setting, kit time format. */
export function TimeInput({
  label,
  value,
  onChange,
  disabled = false,
  minuteInterval,
  accessibilityLabel,
}: {
  label: string;
  value: Date;
  onChange: (value: Date) => void;
  disabled?: boolean;
  /** Minute wheel step (water reminders use 5). */
  minuteInterval?: number;
  /** What a screen reader calls the trigger when the visible label needs context ("Wake up, Monday"). */
  accessibilityLabel?: string;
}) {
  const kit = useKit();
  const format = useKitFormat();
  const host = useEditorPortalHost();
  const uses24h = useCalendars()[0]?.uses24hourClock;
  const toDate = (t: Time) => {
    const d = new Date(value);
    d.setHours(t.hour, t.minute, 0, 0);
    return d;
  };
  const shown = format.time(value);
  const name = accessibilityLabel ?? label;
  return (
    <TimePicker
      value={{ value: new Time(value.getHours(), value.getMinutes()).toString(), label: shown }}
      onValueChange={(option) => option && onChange(toDate(parseTime(option.value)))}
      isDisabled={disabled}
      hourFormat={uses24h ? 24 : 12}
      minuteInterval={minuteInterval}
      locale={format.tag}
      formatTime={(t) => format.time(toDate(t))}
      className="gap-2"
    >
      <FieldLabel label={label} />
      <TimePicker.Select presentation="dialog">
        <TimePicker.Trigger
          // The label names the trigger, so the time inside it is read as its value.
          accessibilityLabel={name}
          accessibilityValue={{ text: shown }}
          accessibilityState={{ disabled }}
          className={twMerge("min-h-11 rounded-control bg-field px-3 py-2", fieldEdge)}
        >
          <TimePicker.Value
            className={twMerge("text-foreground", isMonoSafe(shown) && "font-mono tabular-nums")}
          />
          <Icon name="time" tone="muted" />
        </TimePicker.Trigger>
        <TimePicker.Portal hostName={host} disableFullWindowOverlay>
          <KitScope value={kit}>
            <TimePicker.Overlay />
            <TimePicker.Content presentation="dialog">
              <TimePicker.Wheel />
            </TimePicker.Content>
          </KitScope>
        </TimePicker.Portal>
      </TimePicker.Select>
    </TimePicker>
  );
}

