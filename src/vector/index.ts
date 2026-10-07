// App code imports only "@/vector". Kit files import each other by relative path, never through this barrel.
export {
  VectorProvider,
  useKit,
  useKitStrings,
  useKitFormat,
  useScript,
  useHaptics,
  useIsRTL,
  useSignalInk,
  vectorHeroConfig,
  announce,
} from "./provider";
export type { VectorProviderProps, VectorHaptics, VectorIconRenderer, VectorKit } from "./provider";
export { Text, Label, Heading, Note, Value, Meta, roles, resolveRole } from "./text";
export type { RoleName, VectorTextProps } from "./text";
export { Icon } from "./icon";
export type { IconTone, IconSize } from "./icon";
export { icons, resolveIcon } from "./icons";
export type { IconName, IconSpec, IoniconsName } from "./icons";
export {
  isLiquidGlass,
  tabOptions,
  detailHeaderOptions,
  sheetOptions,
  nativeTint,
  nativeForeground,
  navigationTheme,
} from "./native";
export {
  createFormat,
  localeTag,
  isolate,
  isMonoSafe,
  intlSupport,
  parseDecimal,
  decimalSeparator,
} from "./format";
export type {
  Format,
  FormatStrings,
  FormatUnit,
  IntlUnit,
  SymbolUnit,
  NumberStyle,
  NumberParts,
  DeviceLocale,
} from "./format";
export { duration, easing, useReducedMotionSafe, useListMotion } from "./motion";
export { scriptOf, isKitLanguage } from "./script";
export type { ScriptClass } from "./script";
export { kitStrings, kitLanguages } from "./strings";
export type { KitLanguage, KitStrings, KitStringKey } from "./strings";
export { defaultFlags } from "./flags";
export type { VectorFlags } from "./flags";
export * as tokens from "./tokens";
export { Button, IconButton, LinkButton, buttonLook, iconButtonLook } from "./button";
export type { ButtonProps, IconButtonProps, LinkButtonProps } from "./button";
export { Panel, useRowIndex } from "./panel";
export type { PanelProps } from "./panel";
export {
  Screen,
  DetailScreen,
  NavigationTheme,
  ScreenFooter,
  DockProvider,
  useDock,
  useUndo,
  useScreenReader,
} from "./screen";
export type { ScreenProps, HeaderButton, HeaderMenu } from "./screen";
export {
  Field,
  DateInput,
  TimeInput,
  Select,
  Choices,
  ChipRow,
  SignalCell,
  Toggle,
  Slider,
  Stepper,
  SearchInput,
  SearchTrigger,
  sliderMetrics,
} from "./form";
export type {
  FieldProps,
  ChipRowProps,
  ChipRowRequiredProps,
  ChipRowMultipleProps,
  SignalCellProps,
} from "./form";
export { ListRow, SettingsSection, RecordRow, RowRule, SwipeRow, ActionMenu } from "./list";
export type {
  ListRowProps,
  ListRowTrailing,
  RecordRowProps,
  SwipeAction,
  SwipeRowHandle,
  MenuAction,
} from "./list";
export { Callout, ErrorText, Status, Meter, SystemState, ProcessLine } from "./feedback";
export { Editor, EditorScreen, EditorPresenceProvider, useEditorPortalHost } from "./editor";
export type { EditorProps, EditorScreenProps, EditorPresence } from "./editor";
export {
  TrendChart,
  Sparkline,
  RangeChips,
  RangeSummary,
  Legend,
  ranges,
  rangeStart,
  daysBetween,
  periodLabel,
} from "./chart";
export type {
  Range,
  ChartPoint,
  ChartBandPoint,
  ChartGranularity,
  ChartLine,
  TrendChartProps,
  SparklineProps,
  LegendItem,
  LegendStyle,
} from "./chart";
// VectorGallery is not exported here: Metro does not tree-shake, so every "@/vector" import would evaluate the
// dev-only gallery in production. The route requires "@/vector/gallery" inside __DEV__ instead.
