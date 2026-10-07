import { Fragment, type ReactElement, type ReactNode, type Ref } from "react";
import {
  Platform,
  Pressable,
  Text as RNText,
  ScrollView,
  Switch,
  View,
  useWindowDimensions,
  type NativeSyntheticEvent,
  type TextInput,
  type TextInputSelectionChangeEventData,
  type TextStyle,
} from "react-native";
import { InputGroup, Select as HeroSelect, Slider as HeroSlider } from "heroui-native";
import { twMerge } from "tailwind-merge";
import { IconButton } from "./button";
import { FieldLabel, caret, fieldEdge, fieldInput, inputEdge, invalidEdge } from "./field-parts";
import { Icon, type IconSize } from "./icon";
import type { IconName } from "./icons";
import {
  KitScope,
  SignalInkContext,
  useEditorPortalHost,
  useHaptics,
  useKit,
  useKitStrings,
  webA11y,
  webKeys,
} from "./provider";
import { ErrorText } from "./feedback";
import { Text, Value, resolveRole, sansFamily, type RoleName } from "./text";
import { fonts, light } from "./tokens";

const web = Platform.OS === "web";

// The date and time inputs live in dates.tsx (native) and dates.web.tsx (web): HeroUI Pro's pickers cannot load on
// react-native-web, so the platform picks the file. Same props everywhere.
export { DateInput, TimeInput } from "./dates";

const numericWebStyle: TextStyle = {
  fontSize: 16,
  fontFamily: fonts.mono,
  fontVariant: ["tabular-nums"],
};

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
/** Steps like 0.05 drift in floating point, so values are rounded to the step's own precision. */
const decimals = (step: number) => (String(step).split(".")[1] ?? "").length;
const onStep = (n: number, step: number) => Number(n.toFixed(decimals(step)));

export type FieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /**
   * Mono readout text, decimal pad, `unit` suffix inside the field. Callers read the text with
   * `parseDecimal(value, format.tag)` and seed it with `format.editable` (no grouping), so "72,5" round-trips
   * in de and fr and "2000" never reads back as 2 after a backspace.
   */
  numeric?: boolean;
  unit?: string;
  hint?: string;
  error?: string;
  placeholder?: string;
  secure?: boolean;
  /** A few lines of free text, such as a meal description (88 min). */
  multiline?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Select a prefilled amount so typing replaces it instead of appending. */
  selectTextOnFocus?: boolean;
  /** Return runs this instead of starting a new line. */
  onSubmit?: () => void;
  /** Runs when editing ends, however it ends. */
  onDone?: () => void;
  onBlur?: () => void;
  onFocus?: () => void;
  maxLength?: number;
  /**
   * Controlled selection, e.g. keep a prefilled or stepped amount selected so the next key replaces it. Pair
   * with `onSelectionChange` to follow the caret.
   */
  selection?: { start: number; end?: number };
  onSelectionChange?: (selection: { start: number; end: number }) => void;
  /** Shown beside the label, such as the mark of the model that reads the field. */
  accessory?: ReactNode;
  /** The TextInput, for focus() / blur() (e.g. moving to the next field). */
  ref?: Ref<TextInput>;
};

export function Field({
  label,
  value,
  onChange,
  numeric = false,
  unit,
  hint,
  error,
  placeholder,
  secure = false,
  multiline = false,
  disabled = false,
  autoFocus = false,
  selectTextOnFocus = false,
  onSubmit,
  onDone,
  onBlur,
  onFocus,
  maxLength,
  selection,
  onSelectionChange,
  accessory,
  ref,
}: FieldProps) {
  const invalid = !!error;
  return (
    <View className="gap-2">
      <FieldLabel label={label} accessory={accessory} />
      <InputGroup isDisabled={disabled}>
        <InputGroup.Input
          ref={ref}
          accessibilityLabel={label}
          accessibilityHint={error || hint || unit}
          value={value}
          onChangeText={onChange}
          isInvalid={invalid}
          isDisabled={disabled}
          autoFocus={autoFocus}
          selectTextOnFocus={selectTextOnFocus}
          placeholder={placeholder}
          secureTextEntry={secure}
          autoCorrect={!secure && !numeric}
          autoCapitalize={multiline ? "sentences" : "none"}
          keyboardType={numeric ? "decimal-pad" : "default"}
          multiline={multiline}
          textAlignVertical={multiline ? "top" : undefined}
          returnKeyType={onSubmit ? "go" : undefined}
          submitBehavior={onSubmit ? "blurAndSubmit" : undefined}
          onSubmitEditing={onSubmit}
          onEndEditing={onDone}
          onBlur={onBlur}
          onFocus={onFocus}
          maxLength={maxLength}
          selection={selection}
          onSelectionChange={
            onSelectionChange &&
            ((e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) =>
              onSelectionChange(e.nativeEvent.selection))
          }
          selectionColorClassName={caret}
          className={twMerge(
            fieldInput,
            inputEdge,
            numeric && "font-mono tabular-nums",
            multiline && "min-h-22 py-3",
            invalid && invalidEdge
          )}
          // Web: HeroUI's input CSS is unlayered, so it outranks the font-mono utility there; the numeric value is
          // stated inline (the same family and digits native gets from the class).
          style={web && numeric ? numericWebStyle : { fontSize: 16 }}
        />
        {unit ? (
          <InputGroup.Suffix isDecorative>
            <Text variant="small" tone="muted">
              {unit}
            </Text>
          </InputGroup.Suffix>
        ) : null}
      </InputGroup>
      {hint ? (
        <Text variant="caption" tone="muted">
          {hint}
        </Text>
      ) : null}
      {error ? <ErrorText message={error} /> : null}
    </View>
  );
}

/**
 * More than 4 options (language, units, rest time): a Field-look trigger with a trailing `down` glyph and a
 * trigger-width popover of 44pt items with a trailing tint check. Screen readers hear the title, then the
 * current choice as its value.
 */
export function Select<T extends string>({
  title,
  values,
  value,
  onChange,
  label,
  showTitle = false,
  disabled = false,
  accessibilityHint,
}: {
  /** The control's name: its accessibility label and placeholder (and visible label with `showTitle`). */
  title: string;
  values: readonly T[];
  value: T;
  onChange: (value: T) => void;
  label: (value: T) => string;
  /** Draws `title` above the trigger as a Field label, for Selects in a form (not in a settings row). */
  showTitle?: boolean;
  disabled?: boolean;
  accessibilityHint?: string;
}) {
  const kit = useKit();
  const { height } = useWindowDimensions();
  const host = useEditorPortalHost();
  const current = label(value);
  // The web has no value for a button: its name carries the title and the choice ("Units, Metric").
  const name = web ? kit.format.list([title, current], { type: "unit", style: "short" }) : title;
  const select = (
    <HeroSelect
      value={{ value, label: current }}
      isDisabled={disabled}
      onValueChange={(option) => {
        const picked = values.find((v) => v === option?.value);
        if (picked !== undefined) onChange(picked);
      }}
    >
      <HeroSelect.Trigger
        accessibilityLabel={name}
        accessibilityValue={{ text: current }}
        accessibilityHint={accessibilityHint}
        accessibilityState={{ disabled }}
        {...webA11y({ disabled })}
        className={twMerge(
          "min-h-11 rounded-control bg-field px-3 py-2.5",
          fieldEdge,
          disabled && "opacity-disabled"
        )}
      >
        <HeroSelect.Value placeholder={title} />
        <Icon name="down" tone="muted" />
      </HeroSelect.Trigger>
      <HeroSelect.Portal hostName={host} disableFullWindowOverlay={host !== undefined}>
        <KitScope value={kit}>
          <HeroSelect.Overlay />
          <HeroSelect.Content
            presentation="popover"
            width="trigger"
            className="rounded-control border border-border bg-overlay p-1"
            style={{ maxHeight: Math.min(400, height * 0.6) }}
          >
            <ScrollView keyboardShouldPersistTaps="handled">
              {values.map((option) => (
                <HeroSelect.Item key={option} value={option} label={label(option)} className="px-3">
                  {({ isSelected }) => (
                    <>
                      <HeroSelect.ItemLabel className="flex-1" />
                      {isSelected ? <Icon name="check" size={17} tone="tint" /> : null}
                    </>
                  )}
                </HeroSelect.Item>
              ))}
            </ScrollView>
          </HeroSelect.Content>
        </KitScope>
      </HeroSelect.Portal>
    </HeroSelect>
  );
  if (!showTitle) return select;
  return (
    <View className="gap-2">
      <FieldLabel label={title} />
      {select}
    </View>
  );
}

/**
 * A segment or chip label: the role's size for the script, 500 at rest and 600 when selected (Bold Text +100).
 * Mono labels stay Plex Mono 400 (only Regular ships). Kit Text has no weight prop on purpose, so app code
 * cannot pick weights; this is the one place that needs a selected weight.
 */
function CellLabel({
  role,
  selected,
  children,
}: {
  role: RoleName;
  selected: boolean;
  children: string;
}) {
  const kit = useKit();
  const r = resolveRole(role, kit.script);
  const weight = (
    r.mono ? 400 : Math.min((selected ? 600 : 500) + (kit.boldText ? 100 : 0), 700)
  ) as 400 | 500 | 600 | 700;
  const style: TextStyle = {
    fontSize: r.size,
    lineHeight: r.line,
    letterSpacing: (r.tracking ?? 0) * r.size,
    textTransform: r.upper ? "uppercase" : "none",
    fontFamily: r.mono ? fonts.mono : sansFamily(weight, kit),
    fontWeight: String(weight) as TextStyle["fontWeight"],
    textAlign: "center",
  };
  return (
    <RNText
      maxFontSizeMultiplier={r.cap}
      dynamicTypeRamp={r.ramp}
      // shrink: Yoga's default flexShrink is 0, so a label as wide as its cell would push past the dividers
      // (six mono range chips at large text, long de/fr labels) instead of wrapping inside the cell.
      className={twMerge("shrink", selected ? "text-accent-foreground" : "text-foreground")}
      style={style}
    >
      {children}
    </RNText>
  );
}

/** The reserved leading check slot: always laid out, so selecting never shifts a label. */
const CheckSlot = ({ on, size = 12 }: { on: boolean; size?: IconSize }) => (
  <View className={on ? "" : "opacity-0"}>
    <Icon name="check" size={size} tone="onSignal" />
  </View>
);

export type SignalCellProps = {
  /** True: signal fill with `#071017` content. False: `surface`, 1pt `border-strong`, foreground content. */
  selected: boolean;
  /** Without it the cell is a static mark (no press state), still read with its label and selected state. */
  onPress?: () => void;
  disabled?: boolean;
  /** The cell's name for screen readers; its visible content is not read separately. */
  accessibilityLabel: string;
  accessibilityHint?: string;
  /**
   * `button` (default) reports `selected`; `checkbox` (set done, weekday toggles) and `radio` (one of a group the
   * caller wraps in a `radiogroup`) also report `checked`.
   */
  accessibilityRole?: "button" | "checkbox" | "radio";
  /** md: 44pt tall minimum; sm: 36pt + hitSlop 4 (still a 44pt target), for dense rows and grids. */
  size?: "md" | "sm";
  /**
   * A string gets the Choices label (h4, or small at sm; 600 when selected). Any other content is laid out as
   * given, and while selected kit Text, Value and Icon inside it draw signal ink whatever tone they pass; an app
   * mark reads `useSignalInk()`.
   */
  children?: ReactNode;
  /** The 12pt check in a reserved leading slot, opacity 0 when unselected, so selecting never shifts content. */
  check?: boolean;
  /**
   * Layout only (flex, width, height, padding, direction): the fill, edge, radius, ink and minimum height always
   * win. The default minimum width (the height) may be lowered, e.g. `min-w-0 flex-1` for seven weekdays in a row.
   */
  className?: string;
};

/**
 * The one signal-filled cell for app code (design-system §5.5): a selectable cell that is not one of a Choices
 * segment or a ChipRow chip, such as lift's set-done check, plan-grid next session and effort picker, or macro's
 * calorie-shift weekdays. It is the only place the rule "a `#22D3EE` fill always carries `#071017` content" lives,
 * so app code never paints `bg-accent` or its `bg-segment` alias. It fires no haptic: the press means different
 * things (a set done is `commit`, a toggle is `selection`, §7), so `onPress` fires the event.
 */
export function SignalCell({
  selected,
  onPress,
  disabled = false,
  accessibilityLabel,
  accessibilityHint,
  accessibilityRole = "button",
  size = "md",
  children,
  check = false,
  className,
}: SignalCellProps) {
  const sm = size === "sm";
  const checkable = accessibilityRole !== "button";
  const look = twMerge(
    // Layout defaults the caller may change: a lone cell is at least square, while a row of seven weekday cells
    // may pass min-w-0 (width is layout, as in a Choices row).
    "flex-row items-center justify-center gap-1 px-2",
    sm ? "min-w-9 py-1" : "min-w-11 py-2",
    className,
    // The target height and the look: last, so a caller's className never overrides them.
    sm ? "min-h-9" : "min-h-11",
    "rounded-control border",
    selected ? "border-accent bg-accent" : "border-border-strong bg-surface",
    onPress &&
      !disabled &&
      (selected
        ? "active:border-accent-hover active:bg-accent-hover"
        : "active:bg-surface-secondary"),
    disabled && "opacity-disabled"
  );
  const content = (
    <SignalInkContext.Provider value={selected}>
      {check ? <CheckSlot on={selected} /> : null}
      {typeof children === "string" ? (
        <CellLabel role={sm ? "small" : "h4"} selected={selected}>
          {children}
        </CellLabel>
      ) : (
        children
      )}
    </SignalInkContext.Provider>
  );
  const state = { selected, checked: checkable ? selected : undefined, disabled };
  const a11y = {
    accessible: true,
    accessibilityLabel,
    accessibilityHint,
    accessibilityState: state,
    // Web: a checkbox or radio is checked, a pressable button cell a toggle, a static mark the current item.
    ...webA11y(state, null, checkable ? "checked" : onPress ? "pressed" : "current"),
  };
  if (!onPress) {
    return (
      <View
        {...a11y}
        accessibilityRole={checkable ? accessibilityRole : undefined}
        className={look}
      >
        {content}
      </View>
    );
  }
  return (
    <Pressable
      {...a11y}
      accessibilityRole={accessibilityRole}
      hitSlop={sm ? 4 : undefined}
      disabled={disabled}
      onPress={onPress}
      className={look}
    >
      {content}
    </Pressable>
  );
}

/**
 * The one segmented control (replaces underline tabs, pills used as settings, RadioGroup and HeroUI Tabs).
 * Selected = signal fill, signal-ink label at 600 and a check. Up to 4 options (6 when mono); more, or more than
 * 3 at accessibility text sizes, becomes a Select.
 */
export function Choices<T extends string>({
  values,
  value,
  onChange,
  label,
  accessibilityLabel,
  size = "md",
  mono = false,
  optionLabel,
  disabled = false,
}: {
  values: readonly T[];
  value: T;
  onChange: (value: T) => void;
  label: (value: T) => string;
  accessibilityLabel: string;
  /** sm: 36pt + hitSlop 4, only for chart range chips in a chart header. */
  size?: "md" | "sm";
  mono?: boolean;
  /** What a screen reader says for a cell whose visible label is a code ("3M" → "3 months"). */
  optionLabel?: (value: T) => string;
  /** Dims the control and blocks every cell; screen readers hear each option as disabled. */
  disabled?: boolean;
}) {
  const { largeType } = useKit();
  const haptics = useHaptics();
  if (values.length > (mono ? 6 : 4) || (largeType && values.length > 3)) {
    return (
      <Select
        title={accessibilityLabel}
        values={values}
        value={value}
        onChange={onChange}
        label={label}
        disabled={disabled}
      />
    );
  }
  const sm = size === "sm";
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={disabled ? { disabled } : undefined}
      {...webA11y(disabled ? { disabled } : null)}
      className={twMerge(
        "flex-row rounded-control border border-border-strong",
        disabled && "opacity-disabled"
      )}
    >
      {values.map((option, i) => {
        const selected = option === value;
        return (
          <Fragment key={option}>
            {i > 0 ? <View className="w-px bg-border-strong" /> : null}
            <Pressable
              accessibilityRole="radio"
              accessibilityLabel={optionLabel?.(option)}
              accessibilityState={{ checked: selected, selected, disabled }}
              {...webA11y({ checked: selected, selected, disabled }, null, "checked")}
              hitSlop={sm ? 4 : undefined}
              disabled={disabled}
              onPress={() => {
                if (selected) return;
                haptics.selection();
                onChange(option);
              }}
              className={twMerge(
                "flex-1 basis-0 flex-row items-center justify-center gap-1 px-2",
                sm ? "min-h-9 py-1" : "min-h-11 py-2",
                // Inner corners follow the 4pt container inside its 1pt edge.
                i === 0 && "rounded-s-mark",
                i === values.length - 1 && "rounded-e-mark",
                selected ? "bg-accent" : "bg-surface active:bg-surface-secondary"
              )}
            >
              <CheckSlot on={selected} />
              <CellLabel role={mono ? "label" : sm ? "small" : "h4"} selected={selected}>
                {label(option)}
              </CellLabel>
            </Pressable>
          </Fragment>
        );
      })}
    </View>
  );
}

function Chip({
  label,
  selected,
  role,
  icon,
  onPress,
}: {
  label: string;
  selected: boolean;
  role: "radio" | "checkbox";
  icon?: IconName;
  onPress: () => void;
}) {
  // A chip is a small SignalCell: the glyph, when there is one, takes the check slot's place.
  return (
    <SignalCell
      selected={selected}
      onPress={onPress}
      accessibilityRole={role}
      accessibilityLabel={label}
      size="sm"
      check={!icon}
      className="px-3"
    >
      {icon ? <Icon name={icon} size={16} /> : null}
      <CellLabel role="small" selected={selected}>
        {label}
      </CellLabel>
    </SignalCell>
  );
}

const ChipDivider = () => <View className="mx-1 h-6 w-px bg-separator" />;

type ChipRowBase<T extends string> = {
  values: readonly T[];
  label: (value: T) => string;
  accessibilityLabel: string;
  groups?: readonly (readonly T[])[];
  toggle?: { label: string; icon?: IconName; value: boolean; onChange: (value: boolean) => void };
};
/** Single-select or none: tapping the selected chip clears it. */
export type ChipRowProps<T extends string> = ChipRowBase<T> & {
  multiple?: false;
  required?: false;
  value: T | null;
  onChange: (value: T | null) => void;
};
/** Single-select that always keeps a choice (macro's amount units): tapping the selected chip does nothing. */
export type ChipRowRequiredProps<T extends string> = ChipRowBase<T> & {
  multiple?: false;
  required: true;
  value: T;
  onChange: (value: T) => void;
};
/**
 * Any number on at once (lift equipment and plates, macro weekdays): checkbox chips, and the value keeps the
 * chips' order. `required` keeps the last one on.
 */
export type ChipRowMultipleProps<T extends string> = ChipRowBase<T> & {
  multiple: true;
  required?: boolean;
  value: readonly T[];
  onChange: (value: T[]) => void;
};

/**
 * Horizontal filter and quick-pick chips: single-select or none (tap the selected chip to clear), `required`
 * single-select, or `multiple`; optional groups with a 1pt separator between them, and an optional independent
 * toggle chip first (lift Favorites). Any number of chips; selection is exempt from the signal budget. Starts at
 * the start edge and mirrors in RTL.
 */
export function ChipRow<T extends string>(props: ChipRowRequiredProps<T>): ReactElement;
export function ChipRow<T extends string>(props: ChipRowMultipleProps<T>): ReactElement;
export function ChipRow<T extends string>(props: ChipRowProps<T>): ReactElement;
export function ChipRow<T extends string>(
  props: ChipRowProps<T> | ChipRowRequiredProps<T> | ChipRowMultipleProps<T>
) {
  const { values, label, accessibilityLabel, groups, toggle, required = false } = props;
  const haptics = useHaptics();
  const sets = groups?.length ? groups : [values];
  const order = sets.flat();
  const isOn = (option: T) =>
    props.multiple ? props.value.includes(option) : option === props.value;
  const press = (option: T) => {
    if (props.multiple) {
      const on = props.value.includes(option);
      if (on && required && props.value.length === 1) return;
      haptics.selection();
      const next = on ? props.value.filter((v) => v !== option) : [...props.value, option];
      props.onChange(next.sort((a, b) => order.indexOf(a) - order.indexOf(b)));
      return;
    }
    const on = option === props.value;
    if (on && required) return;
    haptics.selection();
    // Only the clearable form ever receives null (required returned above).
    (props.onChange as (value: T | null) => void)(on ? null : option);
  };
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      accessibilityLabel={accessibilityLabel}
      contentContainerClassName="flex-row items-center gap-2 py-1"
    >
      {toggle ? (
        <>
          <Chip
            role="checkbox"
            label={toggle.label}
            icon={toggle.icon}
            selected={toggle.value}
            onPress={() => {
              haptics.selection();
              toggle.onChange(!toggle.value);
            }}
          />
          <ChipDivider />
        </>
      ) : null}
      {sets.map((set, g) => (
        <Fragment key={g}>
          {g > 0 ? <ChipDivider /> : null}
          {set.map((option) => (
            <Chip
              key={option}
              role={props.multiple ? "checkbox" : "radio"}
              label={label(option)}
              selected={isOn(option)}
              onPress={() => press(option)}
            />
          ))}
        </Fragment>
      ))}
    </ScrollView>
  );
}

/**
 * The native switch (UISwitch / Material): Increase Contrast on/off labels, Liquid Glass and RTL for free.
 * Signal track when on; the thumb is signal ink on Android and stays the system thumb on iOS until the
 * `switchInkThumb` device check. Always sits inside a ListRow that owns the label.
 */
export function Toggle({
  value,
  onChange,
  accessibilityLabel,
  disabled = false,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
  accessibilityLabel: string;
  disabled?: boolean;
}) {
  const { flags } = useKit();
  const haptics = useHaptics();
  const inkThumb = value && (Platform.OS === "android" || flags.switchInkThumb);
  return (
    <Switch
      value={value}
      onValueChange={(next) => {
        haptics.selection();
        onChange(next);
      }}
      disabled={disabled}
      accessibilityLabel={accessibilityLabel}
      // The signal is the same in both schemes; the off track and iOS background stay the system's.
      trackColor={{ true: light.accent }}
      thumbColor={inkThumb ? light.accentForeground : undefined}
    />
  );
}

/**
 * Slider geometry for app marks drawn under it (macro's recommended pace band). The thumb's centre travels from
 * `inset` to width − `inset`, so a value v sits at inset + (v − min) / (max − min) × (width − 2 × inset): lay a
 * band out in a row padded by `inset` on both sides.
 */
export const sliderMetrics = { thumb: 22, inset: 11, rail: 4 } as const;

/**
 * A 4pt rail, tint fill and a 22pt square thumb (radius 2). With `stops` the value snaps to the nearest stop
 * and each new stop fires a selection haptic. No animation. Adjustable, with increment/decrement actions; on web
 * (which drops those actions) the thumb is a tab stop with the slider keys: arrows step (left and right mirror
 * under RTL), Page Up / Page Down step ten (one stop), Home / End go to the ends.
 */
export function Slider({
  value,
  onChange,
  onChangeEnd,
  min,
  max,
  step,
  stops,
  accessibilityLabel,
  accessibilityHint,
  valueText,
}: {
  value: number;
  onChange: (value: number) => void;
  onChangeEnd?: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  stops?: number[];
  accessibilityLabel: string;
  /** e.g. "Recommended: 0.5–1% of body weight a week". */
  accessibilityHint?: string;
  valueText: string;
}) {
  const strings = useKitStrings();
  const haptics = useHaptics();
  const { isRTL } = useKit();
  const snap = (n: number) => {
    if (stops?.length) {
      return stops.reduce((best, s) => (Math.abs(s - n) < Math.abs(best - n) ? s : best));
    }
    return step ? clamp(onStep(Math.round((n - min) / step) * step + min, step), min, max) : n;
  };
  const first = (v: number | number[]) => (Array.isArray(v) ? v[0] : v);
  const a11yValue = {
    min: 0,
    max: 100,
    now: Math.round(((value - min) / (max - min || 1)) * 100),
    text: valueText,
  };
  const change = (n: number) => {
    if (n === value) return;
    if (stops?.length) haptics.selection();
    onChange(n);
  };
  const sorted = stops?.length ? [...stops].sort((a, b) => a - b) : null;
  const commit = (next: number) => {
    if (next === value) return;
    haptics.selection();
    onChange(next);
    onChangeEnd?.(next);
  };
  const nudge = (direction: 1 | -1, steps = 1) => {
    let next: number;
    if (sorted) {
      const at = sorted.indexOf(snap(value));
      next = sorted[clamp(at + direction, 0, sorted.length - 1)];
    } else {
      next = clamp(value + direction * steps * (step ?? 1), min, max);
      if (step) next = onStep(next, step);
    }
    commit(next);
  };
  // The keys a slider answers to on web (WAI-ARIA slider pattern). The rail runs from the start edge, so under
  // RTL the left arrow increases.
  const keys = webKeys((key) => {
    const forward = isRTL ? "ArrowLeft" : "ArrowRight";
    const back = isRTL ? "ArrowRight" : "ArrowLeft";
    if (key === forward || key === "ArrowUp") nudge(1);
    else if (key === back || key === "ArrowDown") nudge(-1);
    else if (key === "PageUp") nudge(1, 10);
    else if (key === "PageDown") nudge(-1, 10);
    else if (key === "Home") commit(sorted ? sorted[0] : min);
    else if (key === "End") commit(sorted ? sorted[sorted.length - 1] : max);
    else return false;
    return true;
  });
  return (
    <HeroSlider
      value={value}
      onChange={(v) => change(snap(first(v)))}
      onChangeEnd={(v) => onChangeEnd?.(snap(first(v)))}
      minValue={min}
      maxValue={max}
      // With stops the kit snaps, so HeroUI moves freely (its default step of 1 would skip fractional stops).
      step={stops?.length ? (max - min) / 1000 : (step ?? 1)}
      animation="disable-all"
    >
      <HeroSlider.Track
        // (22 − 4) / 2 = 9: the rail sits centred on the thumb (sliderMetrics).
        className="my-[9px] h-1 rounded-mark bg-surface-tertiary"
        hitSlop={{ top: 20, bottom: 20 }}
      >
        <HeroSlider.Fill className="rounded-mark bg-tint" />
        <HeroSlider.Thumb
          hitSlop={11}
          className="h-[22px] w-[22px] rounded-mark bg-foreground p-0"
          classNames={{ thumbKnob: "rounded-mark bg-foreground shadow-none" }}
          accessibilityLabel={accessibilityLabel}
          accessibilityHint={accessibilityHint}
          accessibilityValue={a11yValue}
          {...webA11y(null, a11yValue)}
          {...keys}
          accessibilityActions={[
            { name: "increment", label: strings.increase },
            { name: "decrement", label: strings.decrease },
          ]}
          onAccessibilityAction={(e) => nudge(e.nativeEvent.actionName === "increment" ? 1 : -1)}
        />
      </HeroSlider.Track>
    </HeroSlider>
  );
}

/**
 * Minus, a `Value s` readout (min 48 wide), plus. One adjustable element for screen readers, with
 * increment/decrement actions labelled from kit strings. Replaces lift's program-editor and travel steppers.
 */
export function Stepper({
  value,
  onChange,
  min,
  max,
  step = 1,
  label,
  format,
}: {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  /** What is counted, e.g. "Sets". Read as the element's name. */
  label: string;
  format: (n: number) => string;
}) {
  const strings = useKitStrings();
  const haptics = useHaptics();
  const move = (direction: 1 | -1) => {
    const next = clamp(onStep(value + direction * step, step), min, max);
    if (next === value) return;
    haptics.selection();
    onChange(next);
  };
  const shown = format(value);
  return (
    <View
      accessible
      // Web: a labelled group around the two buttons and the readout (a slider role cannot hold buttons, and
      // react-native-web drops the adjustable actions); native keeps one adjustable element.
      accessibilityRole={web ? undefined : "adjustable"}
      role={web ? "group" : undefined}
      accessibilityLabel={label}
      accessibilityValue={{ text: shown }}
      accessibilityActions={[
        { name: "increment", label: strings.increase },
        { name: "decrement", label: strings.decrease },
      ]}
      onAccessibilityAction={(e) => move(e.nativeEvent.actionName === "increment" ? 1 : -1)}
      className="flex-row items-center gap-1 self-start"
    >
      <IconButton
        icon="remove"
        variant="secondary"
        accessibilityLabel={strings.decrease}
        disabled={value <= min}
        onPress={() => move(-1)}
      />
      <View className="min-w-12 items-center px-1">
        <Value value={shown} />
      </View>
      <IconButton
        icon="add"
        variant="secondary"
        accessibilityLabel={strings.increase}
        disabled={value >= max}
        onPress={() => move(1)}
      />
    </View>
  );
}

/**
 * Field look with a leading `search` glyph and a 44pt clear button. Only inside sheets: top-level list search
 * becomes native header search (Later).
 */
export function SearchInput({
  value,
  onChange,
  placeholder,
  accessibilityLabel,
  autoFocus = false,
  onFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  accessibilityLabel: string;
  autoFocus?: boolean;
  onFocus?: () => void;
}) {
  const strings = useKitStrings();
  return (
    <InputGroup>
      <InputGroup.Prefix isDecorative>
        <Icon name="search" size={17} tone="muted" />
      </InputGroup.Prefix>
      <InputGroup.Input
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="search"
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onFocus={onFocus}
        returnKeyType="search"
        autoCapitalize="none"
        autoCorrect={false}
        selectionColorClassName={caret}
        className={twMerge(fieldInput, inputEdge)}
        style={{ fontSize: 16 }}
      />
      {value ? (
        <InputGroup.Suffix className="px-0">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={strings.clearSearch}
            onPress={() => onChange("")}
            className="h-11 w-11 items-center justify-center active:opacity-60"
          >
            <Icon name="clear" size={17} tone="muted" />
          </Pressable>
        </InputGroup.Suffix>
      ) : null}
    </InputGroup>
  );
}

/**
 * The search field's look as a button that opens search elsewhere (macro's quick-log bar opens the logger):
 * Field edge, a leading `search` glyph and the prompt in muted text. Role button, so nothing pretends to take
 * typing; the search itself is a SearchInput in the sheet it opens.
 */
export function SearchTrigger({
  label,
  onPress,
  accessibilityHint,
}: {
  /** The prompt, e.g. "Search foods"; also the accessibility label. */
  label: string;
  onPress: () => void;
  accessibilityHint?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      onPress={onPress}
      className="min-h-11 flex-row items-center gap-2 rounded-control border border-field-border bg-field px-3 py-2 active:bg-surface-secondary"
    >
      <Icon name="search" size={17} tone="muted" />
      <Text tone="muted" className="shrink">
        {label}
      </Text>
    </Pressable>
  );
}
