import { createContext, useContext, useId, useState, type ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  View,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView as NativeSafeAreaView } from "react-native-safe-area-context";
import { SafeAreaView as TabsSafeAreaView } from "react-native-screens/experimental";
import { withUniwind } from "uniwind";
import { Input, InputGroup, Label, Select, TextField } from "heroui-native";
import { PortalHost } from "heroui-native/portal";
import { Calendar, DateField } from "heroui-native-pro";
import { parseDate } from "@internationalized/date";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SystemButton, SystemText as Text } from "./system";
import { localDay } from "@/lib/metrics";
import { useStore } from "@/lib/store";

// Third-party native views need a Uniwind adapter for className styles.
// Without flex-1, the modal's safe-area container collapses and hides the form.
const SafeAreaView = withUniwind(NativeSafeAreaView);

const EditorPortalContext = createContext<string | undefined>(undefined);

export function Screen({
  title,
  subtitle,
  children,
  nativeHeader = false,
  action,
  footer,
  compact = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  nativeHeader?: boolean;
  action?: ReactNode;
  footer?: ReactNode;
  compact?: boolean;
}) {
  const { width } = useWindowDimensions();
  const content = (
    <SafeAreaView
      className="flex-1 bg-background"
      edges={nativeHeader ? ["bottom", "left", "right"] : ["top"]}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          padding: width < 600 ? 16 : width < 1024 ? 24 : 32,
          paddingTop: compact ? 12 : 24,
          paddingBottom: footer ? 16 : 40,
          gap: compact ? 16 : 20,
          width: "100%",
          maxWidth: 1440,
          alignSelf: "center",
        }}
      >
        {!nativeHeader && (
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
      {footer && <View className="bg-background px-4 pt-2 pb-2">{footer}</View>}
    </SafeAreaView>
  );
  // A fixed footer must respect the native tab bar, not just the device's
  // home indicator. Today disables the tab's automatic scroll-only insets.
  return footer ? (
    <TabsSafeAreaView edges={{ bottom: true, left: true, right: true }} style={{ flex: 1 }}>
      {content}
    </TabsSafeAreaView>
  ) : (
    content
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
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  numeric?: boolean;
  secure?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <TextField isDisabled={disabled}>
      <Label>{label}</Label>
      <Input
        accessibilityLabel={label}
        autoFocus={autoFocus}
        variant="primary"
        className={numeric ? "font-mono focus:border-focus" : "font-sans focus:border-focus"}
        value={value}
        onChangeText={onChange}
        keyboardType={numeric ? "decimal-pad" : "default"}
        autoCapitalize="none"
        secureTextEntry={secure}
        autoCorrect={!secure}
        placeholder={placeholder}
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
}: {
  title: string;
  open: boolean;
  close: () => void;
  children: ReactNode;
  busy?: boolean;
  footer?: ReactNode;
  compact?: boolean;
}) {
  const { t } = useStore();
  const portalHost = useId();
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
            <KeyboardAvoidingView
              style={{ flex: 1 }}
              behavior={Platform.OS === "ios" ? "padding" : undefined}
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
                keyboardShouldPersistTaps="handled"
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
