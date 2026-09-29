// Vector kit stand-ins for the compiled-component harnesses. Kit components render as named
// element types, as the shims' stand-ins did (Note and Heading read as Text, LinkButton as
// Button, ErrorText as Error), while formatting, kit strings and t() are the real English ones,
// so assertions read what a person sees. Each kitMock() call has its own Undo record.
const { readFileSync } = require("node:fs");

const en = JSON.parse(readFileSync("src/lib/locales/en.json", "utf8"));

/** The app's t() in English; an unknown key fails the test, as it fails tsc. */
function englishT(key, values) {
  if (!Object.hasOwn(en, key)) throw new Error(`Unknown translation key: ${key}`);
  const text = en[key];
  return values
    ? text.replace(/\{(\w+)\}/g, (match, name) =>
        Object.hasOwn(values, name) ? String(values[name]) : match
      )
    : text;
}

/** `load` is the test file's own TypeScript loader. */
function kitMock(load) {
  const { createFormat, decimalSeparator, parseDecimal } = load("src/vector/format.ts");
  const { kitStrings } = load("src/vector/strings.ts");
  // Only the type scale is read from text.tsx; its components are stood in for below.
  const { roles } = load("src/vector/text.tsx", {
    ...Object.fromEntries(
      [
        "react",
        "react/jsx-runtime",
        "react-native",
        "react-native-reanimated",
        "tailwind-merge",
        "./format",
        "./provider",
        "./script",
      ].map((name) => [name, {}])
    ),
    "./motion": { duration: {}, easing: {} },
    "./tokens": { fonts: {} },
  });
  // chart.tsx renders through React; only its pure range helpers are used, so its imports are stubs.
  const chart = load(
    "src/vector/chart.tsx",
    Object.fromEntries(
      [
        "react",
        "react/jsx-runtime",
        "react-native",
        "react-native-svg",
        "tailwind-merge",
        "uniwind",
        "./form",
        "./icon",
        "./provider",
        "./text",
      ].map((name) => [name, {}])
    )
  );
  const format = createFormat("en-US");
  // Every Undo offered, in order; null where one was dismissed.
  const offers = [];
  // What the kit says once Undo runs (each offer's undoneMessage), in order.
  const spoken = [];
  const undo = {
    show: (offer) => offers.push(offer),
    dismiss: () => offers.push(null),
  };
  const Panel = Object.assign(function Panel() {}, {
    Header: "Panel.Header",
    Title: "Panel.Title",
    Description: "Panel.Description",
    Body: "Panel.Body",
    Footer: "Panel.Footer",
  });
  return {
    ActionMenu: "ActionMenu",
    Button: "Button",
    Callout: "Callout",
    ChipRow: "ChipRow",
    Choices: "Choices",
    DateInput: "DateInput",
    DetailScreen: "DetailScreen",
    ErrorText: "Error",
    Field: "Field",
    Heading: "Text",
    Icon: "Icon",
    IconButton: "IconButton",
    Label: "Label",
    Legend: "Legend",
    LinkButton: "Button",
    ListRow: "ListRow",
    Meta: "Meta",
    Meter: "Meter",
    Note: "Text",
    Panel,
    ProcessLine: "ProcessLine",
    RangeChips: "RangeChips",
    RangeSummary: "RangeSummary",
    RecordRow: "RecordRow",
    RowRule: "RowRule",
    Screen: "Screen",
    ScreenFooter: "ScreenFooter",
    SearchInput: "SearchInput",
    SearchTrigger: "SearchTrigger",
    Select: "Select",
    SettingsSection: "SettingsSection",
    SignalCell: "SignalCell",
    Slider: "Slider",
    Sparkline: "Sparkline",
    Status: "Status",
    SwipeRow: "SwipeRow",
    SystemState: "SystemState",
    Text: "Text",
    Toggle: "Toggle",
    TrendChart: "TrendChart",
    Value: "Value",
    decimalSeparator,
    parseDecimal,
    roles,
    sliderMetrics: { thumb: 22, inset: 11, rail: 4 },
    daysBetween: chart.daysBetween,
    rangeStart: chart.rangeStart,
    ranges: chart.ranges,
    useKitFormat: () => format,
    useKitStrings: () => kitStrings.en,
    useHaptics: () => ({ selection() {}, commit() {}, complete() {}, warn() {}, error() {} }),
    useUndo: () => undo,
    useIsRTL: () => false,
    format,
    offers,
    spoken,
    /** The Undo on screen now, if any. */
    currentUndo: () => offers.at(-1) ?? null,
    /**
     * Taps Undo as the kit's strip does: it goes away first, so a second tap finds nothing, and
     * its undoneMessage is spoken after the undo runs.
     */
    pressUndo() {
      const offer = offers.at(-1);
      if (!offer) return;
      offers.push(null);
      offer.onUndo();
      if (offer.undoneMessage) spoken.push(offer.undoneMessage);
    },
  };
}

module.exports = { englishT, kitMock };
