import { useState, type ChangeEvent, type CSSProperties } from "react";
import { View } from "react-native";
import { useCSSVariable } from "uniwind";
import { FieldLabel, clockOf, dayInRange, localToday, onMinuteGrid } from "./field-parts";
import { useKit } from "./provider";
import { fonts, radius } from "./tokens";

// DateInput and TimeInput on react-native-web (Metro picks this file for the web build; dates.tsx elsewhere, with
// the same props). HeroUI Pro's Calendar and time wheel import Pro's chart helpers, whose Skia font lookup throws at
// load on web unless CanvasKit is loaded first, so the web build never imports them: it uses the browser's own date
// and time inputs, drawn with the Field look. The browser supplies the picker, its keyboard support, the locale's
// order and (for time) the 12/24-hour setting.
//
// While the input has focus it shows what the person is typing (a draft), and the app hears only whole values the
// native picker could also produce: a day within min and max, a time on the minute grid. On blur it shows the
// app's value again, so a partial or out-of-range entry falls back to the last value, as clearing does.

/**
 * The Field look on a DOM input: 44 min, 1pt field edge, radius 4, the value in Plex Mono, a 2pt tint focus ring.
 * Colours are read like every kit colour on web (Uniwind resolves them for the active or scoped theme), because a
 * DOM element outside react-native-web only sees the root theme's CSS variables.
 */
function useWebField(disabled: boolean): {
  style: CSSProperties;
  focused: boolean;
  onFocus: () => void;
  onBlur: () => void;
} {
  const { scheme } = useKit();
  const [focused, setFocused] = useState(false);
  const [field, edge, ink, focus] = useCSSVariable([
    "--color-field",
    "--color-field-border",
    "--color-foreground",
    "--color-focus",
  ]).map((v) => (v === undefined ? undefined : String(v)));
  return {
    style: {
      boxSizing: "border-box",
      width: "100%",
      minHeight: 44,
      paddingInline: 12,
      borderRadius: radius.control,
      borderWidth: 1,
      borderStyle: "solid",
      borderColor: edge,
      backgroundColor: field,
      color: ink,
      fontFamily: fonts.mono,
      fontSize: 16,
      fontVariantNumeric: "tabular-nums",
      outline: focused ? `2px solid ${focus ?? "currentColor"}` : "none",
      outlineOffset: 0,
      opacity: disabled ? 0.4 : 1,
      // The browser's picker follows the kit's scheme.
      colorScheme: scheme,
    },
    focused,
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
  };
}

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
  const look = useWebField(disabled);
  const [draft, setDraft] = useState(value);
  const last = max ?? localToday();
  return (
    <View className="gap-2">
      <FieldLabel label={label} />
      <input
        type="date"
        aria-label={accessibilityLabel ?? label}
        value={look.focused ? draft : value}
        min={min}
        max={last}
        required
        disabled={disabled}
        // Required, as on native: clearing the field (or leaving a partial or out-of-range date) keeps the last
        // date. Only a whole day within min…max reaches the app, as with native's calendar.
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          const next = e.target.value;
          setDraft(next);
          if (dayInRange(next, min, last)) onChange(next);
        }}
        onFocus={() => {
          setDraft(value);
          look.onFocus();
        }}
        onBlur={look.onBlur}
        style={look.style}
      />
    </View>
  );
}

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
  /** Minute step (water reminders use 5). */
  minuteInterval?: number;
  /** What a screen reader calls the field when the visible label needs context ("Wake up, Monday"). */
  accessibilityLabel?: string;
}) {
  const look = useWebField(disabled);
  const shown = clockOf(value);
  const [draft, setDraft] = useState(shown);
  return (
    <View className="gap-2">
      <FieldLabel label={label} />
      <input
        type="time"
        aria-label={accessibilityLabel ?? label}
        value={look.focused ? draft : shown}
        step={(minuteInterval ?? 1) * 60}
        required
        disabled={disabled}
        // A typed minute off the grid (07:33 with minuteInterval 5) snaps to the nearest slot (07:35), which the
        // field shows once it loses focus; a partial time keeps the last value.
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          setDraft(e.target.value);
          const time = onMinuteGrid(e.target.value, minuteInterval);
          if (!time) return;
          const next = new Date(value);
          next.setHours(time.hours, time.minutes, 0, 0);
          if (next.getTime() !== value.getTime()) onChange(next);
        }}
        onFocus={() => {
          setDraft(shown);
          look.onFocus();
        }}
        onBlur={look.onBlur}
        style={look.style}
      />
    </View>
  );
}
