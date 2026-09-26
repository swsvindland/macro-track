import {
  createContext,
  useContext,
  useId,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  View,
  useWindowDimensions,
} from "react-native";
import {
  SafeAreaView as NativeSafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { twMerge } from "tailwind-merge";
import { withUniwind } from "uniwind";
import { Input, InputGroup, Label, Menu, SearchField, Select, TextField } from "heroui-native";
import { PortalHost } from "heroui-native/portal";
import { Calendar, DateField } from "heroui-native-pro";
import { parseDate } from "@internationalized/date";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import ReanimatedSwipeable, {
  SwipeDirection,
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import {
  SystemButton,
  SystemIcon,
  SystemIconButton,
  SystemText as Text,
  type IconName,
} from "./system";
import { useCloseForAppAction } from "@/lib/app-actions";
import { localDay } from "@/lib/metrics";
import { useStore } from "@/lib/store";

// Third-party native views need a Uniwind adapter for className styles.
// Without flex-1, the modal's safe-area container collapses and hides the form.
const SafeAreaView = withUniwind(NativeSafeAreaView);

const EditorPortalContext = createContext<string | undefined>(undefined);

/** The footer for Screens inside that pass none, e.g. a tab's quick-log bar. */
export const ScreenFooter = createContext<ReactNode>(null);

export function Screen({
  title,
  subtitle,
  children,
  nativeHeader = false,
  action,
  compact = false,
  header,
  footer,
  scrollRef,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  nativeHeader?: boolean;
  action?: ReactNode;
  compact?: boolean;
  /** Replaces the large title with a fixed row that stays put while content scrolls. */
  header?: ReactNode;
  /** Floats over the content just above the tab bar, e.g. an Undo message. */
  footer?: ReactNode;
  scrollRef?: Ref<ScrollView>;
}) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const shared = useContext(ScreenFooter);
  const floating = footer ?? shared;
  return (
    <SafeAreaView
      className="flex-1 bg-background"
      edges={nativeHeader ? ["bottom", "left", "right"] : ["top"]}
    >
      {header && <View className="min-h-12 justify-center px-2">{header}</View>}
      <ScrollView
        ref={scrollRef}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={{
          padding: width < 600 ? 16 : width < 1024 ? 24 : 32,
          paddingTop: header ? 4 : compact ? 12 : 24,
          paddingBottom: floating ? 160 : 40,
          gap: compact ? 16 : 20,
          width: "100%",
          maxWidth: 1440,
          alignSelf: "center",
        }}
      >
        {!nativeHeader && !header && (
          <View className="gap-2 pb-1">
            <View className="flex-row items-center justify-between gap-3">
              <Text
                accessibilityRole="header"
                className="flex-1 text-3xl font-semibold text-foreground"
              >
                {title}
              </Text>
              {action}
            </View>
            {subtitle && <Text className="mt-2 text-muted">{subtitle}</Text>}
          </View>
        )}
        {children}
      </ScrollView>
      {floating && (
        <View
          pointerEvents="box-none"
          className="absolute inset-x-0 items-center px-4"
          // On iOS the tab bar floats over the screen and is part of its safe area.
          style={{ bottom: (Platform.OS === "ios" ? insets.bottom : 0) + 8 }}
        >
          <View className="w-full max-w-xl">{floating}</View>
        </View>
      )}
    </SafeAreaView>
  );
}

type SwipeAction = { label: string; icon: IconName; onAction: () => void; destructive?: boolean };

/**
 * A list row with an action on each swipe. The action runs as soon as the swipe
 * passes the threshold, so a destructive one should offer Undo. Screen readers
 * need the same actions as accessibilityActions on the row itself.
 */
export function SwipeRow({
  children,
  enabled = true,
  swipeLeft,
  swipeRight,
}: {
  children: ReactNode;
  enabled?: boolean;
  swipeLeft?: SwipeAction;
  swipeRight?: SwipeAction;
}) {
  const ref = useRef<SwipeableMethods>(null);
  const panel = (action: SwipeAction, side: "left" | "right") => (
    <View
      className={twMerge(
        "w-24 justify-center gap-1 px-4",
        side === "left" ? "items-start" : "items-end",
        action.destructive ? "bg-danger" : "bg-accent-soft"
      )}
    >
      <SystemIcon
        name={action.icon}
        size={20}
        color={action.destructive ? "danger-foreground" : "accent-soft-foreground"}
      />
      <Text
        className={twMerge(
          "text-xs font-medium",
          action.destructive ? "text-danger-foreground" : "text-accent-soft-foreground"
        )}
      >
        {action.label}
      </Text>
    </View>
  );
  return (
    <ReanimatedSwipeable
      ref={ref}
      enabled={enabled}
      friction={1.5}
      leftThreshold={72}
      rightThreshold={72}
      renderLeftActions={swipeRight && (() => panel(swipeRight, "left"))}
      renderRightActions={swipeLeft && (() => panel(swipeLeft, "right"))}
      onSwipeableWillOpen={(direction) => {
        const action = direction === SwipeDirection.LEFT ? swipeLeft : swipeRight;
        // A destructive action removes the row; anything else springs back.
        if (!action?.destructive) ref.current?.close();
        action?.onAction();
      }}
    >
      <View className="bg-surface">{children}</View>
    </ReanimatedSwipeable>
  );
}
export function Field({
  label,
  value,
  onChange,
  numeric = false,
  secure = false,
  placeholder,
  disabled = false,
  autoFocus = false,
  selectTextOnFocus = false,
  multiline = false,
  onSubmit,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  numeric?: boolean;
  secure?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  disabled?: boolean;
  /** Select a prefilled amount so typing replaces it instead of appending. */
  selectTextOnFocus?: boolean;
  /** A few lines of free text, such as a meal description. */
  multiline?: boolean;
  /** Return runs this instead of starting a new line. */
  onSubmit?: () => void;
}) {
  return (
    <TextField isDisabled={disabled}>
      <Label>{label}</Label>
      <Input
        accessibilityLabel={label}
        autoFocus={autoFocus}
        selectTextOnFocus={selectTextOnFocus}
        variant="primary"
        className={twMerge(
          numeric ? "font-mono focus:border-focus" : "font-sans focus:border-focus",
          multiline && "min-h-20 py-3"
        )}
        value={value}
        onChangeText={onChange}
        keyboardType={numeric ? "decimal-pad" : "default"}
        autoCapitalize={multiline ? "sentences" : "none"}
        secureTextEntry={secure}
        autoCorrect={!secure}
        placeholder={placeholder}
        multiline={multiline}
        textAlignVertical={multiline ? "top" : undefined}
        returnKeyType={onSubmit ? "go" : undefined}
        submitBehavior={onSubmit ? "blurAndSubmit" : undefined}
        onSubmitEditing={onSubmit}
      />
    </TextField>
  );
}
export function DateInput({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const { language, date } = useStore();
  const displayDate = value ? date(value) : "";
  const hostName = useContext(EditorPortalContext);
  const [isOpen, setIsOpen] = useState(false);
  return (
    <DateField
      value={{ value, label: displayDate }}
      onValueChange={(option) => onChange(option?.value ?? "")}
      isDisabled={disabled}
      isRequired
      isOpen={isOpen}
      onOpenChange={setIsOpen}
      locale={language === "zh" ? "zh-CN" : language}
    >
      <Label>{label}</Label>
      <DateField.InputGroup>
        <InputGroup.Input
          accessibilityLabel={label}
          value={displayDate}
          placeholder={label}
          isDisabled={disabled}
          editable={false}
          onPressIn={() => !disabled && setIsOpen(true)}
        />
        <DateField.Suffix>
          <DateField.Select presentation="dialog">
            <DateField.Trigger accessibilityLabel={label}>
              <DateField.TriggerIndicator />
            </DateField.Trigger>
            <DateField.Portal hostName={hostName} disableFullWindowOverlay>
              <DateField.Overlay />
              <DateField.Content presentation="dialog">
                <DateField.Calendar
                  accessibilityLabel={label}
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
                      {(day) => <Calendar.HeaderCell day={day} />}
                    </Calendar.GridHeader>
                    <Calendar.GridBody>{(date) => <Calendar.Cell date={date} />}</Calendar.GridBody>
                  </Calendar.Grid>
                </DateField.Calendar>
              </DateField.Content>
            </DateField.Portal>
          </DateField.Select>
        </DateField.Suffix>
      </DateField.InputGroup>
    </DateField>
  );
}
export function SettingsSelect<T extends string>({
  title,
  values,
  value,
  onChange,
  label,
}: {
  title: string;
  values: readonly T[];
  value: T;
  onChange: (value: T) => void;
  label: (value: T) => string;
}) {
  return (
    <Select
      value={{ value, label: label(value) }}
      onValueChange={(option) => {
        const selected = values.find((item) => item === option?.value);
        if (selected) onChange(selected);
      }}
    >
      <Select.Trigger accessibilityLabel={title}>
        <Select.Value placeholder={title} />
        <Select.TriggerIndicator />
      </Select.Trigger>
      <Select.Portal>
        <Select.Overlay />
        <Select.Content presentation="popover" width="trigger" className="max-h-80">
          <ScrollView keyboardShouldPersistTaps="handled">
            {values.map((option) => (
              <Select.Item key={option} value={option} label={label(option)}>
                <Select.ItemLabel />
                <Select.ItemIndicator />
              </Select.Item>
            ))}
          </ScrollView>
        </Select.Content>
      </Select.Portal>
    </Select>
  );
}
export function Choices<T extends string>({
  values,
  value,
  onChange,
  label,
}: {
  values: readonly T[];
  value: T;
  onChange: (value: T) => void;
  label?: (value: T) => string;
}) {
  const { t } = useStore();
  return (
    <View className="flex-row flex-wrap gap-2">
      {values.map((option) => (
        <SystemButton
          key={option}
          variant="ghost"
          className={
            value === option
              ? "bg-accent-soft border-accent-soft"
              : "bg-surface-secondary border-transparent"
          }
          accessibilityState={{ selected: value === option }}
          onPress={() => onChange(option)}
        >
          {value === option ? "✓ " : ""}
          {label ? label(option) : t(option)}
        </SystemButton>
      ))}
    </View>
  );
}
export function Editor({
  title,
  open,
  close,
  children,
  busy = false,
  footer,
  compact = false,
  scrollRef,
}: {
  title: string;
  open: boolean;
  close: () => void;
  children: ReactNode;
  busy?: boolean;
  footer?: ReactNode;
  compact?: boolean;
  scrollRef?: Ref<ScrollView>;
}) {
  const { t } = useStore();
  const insets = useSafeAreaInsets();
  const portalHost = useId();
  // A macrotrack:// link opens a sheet on Home, which iOS can't show over this one.
  useCloseForAppAction(open, close);
  return (
    <Modal
      visible={open}
      animationType="none"
      presentationStyle="pageSheet"
      onRequestClose={() => !busy && close()}
    >
      <GestureHandlerRootView style={{ flex: 1 }}>
        <EditorPortalContext.Provider value={portalHost}>
          <SafeAreaView className="flex-1 bg-background">
            {/* A page sheet starts below the status bar; without this offset the
                footer action sits under the keyboard. */}
            <KeyboardAvoidingView
              style={{ flex: 1 }}
              behavior={Platform.OS === "ios" ? "padding" : undefined}
              keyboardVerticalOffset={Platform.OS === "ios" ? insets.top : 0}
            >
              {compact && (
                <View className="flex-row items-center justify-between px-4 py-2">
                  <Text accessibilityRole="header" className="text-xl font-semibold">
                    {title}
                  </Text>
                  <SystemButton variant="ghost" isDisabled={busy} onPress={close}>
                    Cancel
                  </SystemButton>
                </View>
              )}
              <ScrollView
                ref={scrollRef}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
                contentContainerStyle={{
                  padding: compact ? 16 : 24,
                  gap: compact ? 12 : 20,
                  paddingBottom: 40,
                  maxWidth: 640,
                  width: "100%",
                  alignSelf: "center",
                }}
              >
                {!compact && (
                  <Text
                    accessibilityRole="header"
                    className="text-2xl font-semibold text-foreground"
                  >
                    {title}
                  </Text>
                )}
                {children}
                {!compact && (
                  <SystemButton variant="outline" isDisabled={busy} onPress={close}>
                    {t("cancel")}
                  </SystemButton>
                )}
              </ScrollView>
              {footer && <View className="bg-background px-4 py-3">{footer}</View>}
            </KeyboardAvoidingView>
          </SafeAreaView>
          {/* Keep calendar overlays above the native editor modal on both platforms. */}
          <PortalHost name={portalHost} />
        </EditorPortalContext.Provider>
      </GestureHandlerRootView>
    </Modal>
  );
}
export function ErrorText({ message }: { message: string }) {
  return message ? (
    <Text
      accessibilityRole="alert"
      className="border-l-2 border-danger bg-surface py-3 pl-4 text-danger"
    >
      {message}
    </Text>
  ) : null;
}

export type MenuAction = {
  key: string;
  label: string;
  icon?: IconName;
  onPress: () => void;
  disabled?: boolean;
  /** Shows a checkmark; use for the current choice in a single-select section. */
  selected?: boolean;
  destructive?: boolean;
};

/** A compact popover of actions behind a single trigger. */
export function ActionMenu({
  accessibilityLabel,
  sections,
  icon = "ellipsis-horizontal",
  trigger,
}: {
  accessibilityLabel: string;
  sections: { title?: string; actions: MenuAction[] }[];
  icon?: IconName;
  /** Custom trigger content; defaults to an icon button. */
  trigger?: ReactNode;
}) {
  const { width } = useWindowDimensions();
  return (
    <Menu>
      <Menu.Trigger asChild accessibilityLabel={trigger ? accessibilityLabel : undefined}>
        {trigger ?? <SystemIconButton icon={icon} accessibilityLabel={accessibilityLabel} />}
      </Menu.Trigger>
      <Menu.Portal unstable_accessibilityContainerViewIsModal>
        <Menu.Overlay />
        <Menu.Content
          presentation="popover"
          placement="bottom"
          align="end"
          width={Math.min(280, width - 32)}
          insets={{ left: 16, right: 16, top: 16, bottom: 16 }}
          className="p-1.5"
        >
          {sections.map((section, i) => (
            <View
              key={section.title ?? i}
              className={i ? "mt-1 border-t border-separator pt-1" : ""}
            >
              {section.title && <Menu.Label className="px-3 pt-1">{section.title}</Menu.Label>}
              {section.actions.map((action) => (
                <Menu.Item
                  key={action.key}
                  className="min-h-11"
                  isDisabled={action.disabled}
                  variant={action.destructive ? "danger" : "default"}
                  accessibilityState={{
                    disabled: action.disabled,
                    ...(action.selected !== undefined ? { selected: action.selected } : {}),
                  }}
                  onPress={action.onPress}
                >
                  {action.icon && (
                    <SystemIcon
                      name={action.icon}
                      size={18}
                      color={action.destructive ? "danger" : "muted"}
                    />
                  )}
                  <Menu.ItemTitle className="flex-1">{action.label}</Menu.ItemTitle>
                  {action.selected && (
                    <SystemIcon name="checkmark" size={18} color="accent-soft-foreground" />
                  )}
                </Menu.Item>
              ))}
            </View>
          ))}
        </Menu.Content>
      </Menu.Portal>
    </Menu>
  );
}

/** Search box with a leading icon and a clear button; no visible label. */
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
  return (
    <SearchField value={value} onChange={onChange}>
      <SearchField.Group>
        <SearchField.SearchIcon />
        <SearchField.Input
          autoFocus={autoFocus}
          onFocus={onFocus}
          placeholder={placeholder}
          accessibilityLabel={accessibilityLabel}
          returnKeyType="search"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <SearchField.ClearButton hitSlop={10} accessibilityLabel="Clear search" />
      </SearchField.Group>
    </SearchField>
  );
}

/** A date label that opens a calendar dialog; used by the compact Home header. */
export function DayPicker({
  value,
  max,
  label,
  onChange,
}: {
  value: string;
  /** Latest selectable day; passed in so a long-lived screen doesn't keep a stale "today". */
  max: string;
  label: string;
  onChange: (day: string) => void;
}) {
  const { language, date } = useStore();
  const hostName = useContext(EditorPortalContext);
  const [isOpen, setIsOpen] = useState(false);
  return (
    <DateField
      className="min-w-0 shrink"
      value={{ value, label: date(value) }}
      onValueChange={(option) => option?.value && onChange(option.value)}
      isOpen={isOpen}
      onOpenChange={setIsOpen}
      locale={language === "zh" ? "zh-CN" : language}
    >
      <DateField.Select presentation="dialog">
        <DateField.Trigger asChild accessibilityLabel={`${label}. Choose a date`}>
          <SystemButton variant="ghost" className="min-w-0 flex-shrink gap-1 px-2">
            <Text
              accessibilityRole="header"
              numberOfLines={1}
              className="flex-shrink text-lg font-semibold"
            >
              {label}
            </Text>
            <SystemIcon name="chevron-down" size={16} color="muted" />
          </SystemButton>
        </DateField.Trigger>
        <DateField.Portal hostName={hostName} disableFullWindowOverlay>
          <DateField.Overlay />
          <DateField.Content presentation="dialog">
            <DateField.Calendar
              accessibilityLabel="Diary date"
              minValue={parseDate("1900-01-01")}
              maxValue={parseDate(max)}
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
                <Calendar.GridBody>{(date) => <Calendar.Cell date={date} />}</Calendar.GridBody>
              </Calendar.Grid>
            </DateField.Calendar>
          </DateField.Content>
        </DateField.Portal>
      </DateField.Select>
    </DateField>
  );
}
