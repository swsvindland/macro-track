import { useEffect, useState, type ReactNode } from "react";
import { Text as RNText, View } from "react-native";
import { twMerge } from "tailwind-merge";
import { ScopedTheme } from "uniwind";
import { Button, IconButton, LinkButton } from "./button";
import {
  Legend,
  RangeChips,
  RangeSummary,
  Sparkline,
  TrendChart,
  rangeStart,
  type ChartBandPoint,
  type ChartLine,
  type ChartPoint,
  type Range,
} from "./chart";
import { Editor } from "./editor";
import { Callout, ErrorText, Meter, ProcessLine, Status, SystemState } from "./feedback";
import { intlSupport, type Format } from "./format";
import {
  ChipRow,
  Choices,
  DateInput,
  Field,
  SearchInput,
  SearchTrigger,
  Select,
  SignalCell,
  Slider,
  Stepper,
  TimeInput,
} from "./form";
import { Icon, type IconTone } from "./icon";
import { icons, type IconName } from "./icons";
import { ActionMenu, ListRow, RecordRow, SettingsSection, SwipeRow } from "./list";
import { Panel } from "./panel";
import { SignalBudget, VectorProvider, useKit, useKitFormat } from "./provider";
import { DetailScreen, ScreenFooter, useUndo } from "./screen";
import { kitLanguages, type KitLanguage } from "./strings";
import { Heading, Label, Meta, Note, Text, Value, roles, type RoleName } from "./text";
import { fonts } from "./tokens";

// Dev-only gallery (mounted by lift's src/app/vector-gallery.tsx behind __DEV__): every kit component, in light
// and dark side by side through Uniwind ScopedTheme, for the simulator screenshot review (MIGRATION P1.8) and
// design-system §12 checks #5 (Inter weights) and #11 (Hermes Intl). The sample content below is English on
// purpose: the language switch changes the kit's own words, script rules and formatting, not the samples.

const sample = {
  title: "Vector kit",
  theme: "Theme",
  both: "Light and dark",
  light: "Light",
  dark: "Dark",
  language: "Kit language",
  palette: "Palette",
  type: "Type",
  weights: "Inter weights and Plex Mono",
  icons: "Icons",
  actions: "Actions",
  panels: "Panels",
  inputs: "Inputs",
  lists: "Lists",
  feedback: "Feedback",
  charts: "Charts",
  scaffold: "Scaffold",
  environment: "Environment",
  pangram: "Log the set, then rest",
  eyebrow: "Today",
  save: "Save changes",
  log: "Log drink",
  add: "Add food",
  edit: "Edit",
  delete: "Delete",
  more: "More actions",
  moreInfo: "Read how the trend works",
  pulse: "Pulse the value",
  panelTitle: "Body weight",
  panelBody: "Trend weight smooths daily readings with a seven-day half-life.",
  rest: "Rest",
  skip: "Skip",
  start: "Start workout",
  weight: "Weight",
  notes: "Notes",
  hint: "Use the scale reading from this morning.",
  invalid: "Enter a number between 20 and 400.",
  date: "Date",
  time: "Reminder",
  units: "Units",
  unitNames: { metric: "Metric", imperial: "Imperial", stone: "Stone" },
  sets: "Sets",
  pace: "Pace",
  search: "Search foods",
  muscles: { chest: "Chest", back: "Back", legs: "Legs", arms: "Arms", core: "Core" },
  favorites: "Favorites",
  health: "Apple Health",
  healthNote: "Weights sync both ways.",
  language_: "Language",
  english: "English",
  erase: "Erase all data",
  drink: "Water",
  coffee: "Coffee",
  deleted: "Drink deleted",
  undo: "Show undo",
  editor: "Open editor",
  editorTitle: "Add weight",
  record: "Record",
  callout: {
    info: "Readings from Apple Health appear within a minute.",
    success: "Backup finished.",
    warning: "Calories are over the day’s target.",
    danger: "Could not save. Try again.",
  },
  status: {
    live: "Live",
    ok: "Synced",
    attention: "Over",
    error: "Failed",
    idle: "Idle",
    off: "Off",
  },
  calories: "Calories",
  hydration: "Hydration",
  syncing: "Syncing…",
  days: { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri" },
  setDone: "Set 1 done",
  nextSession: "Week 2, Push: next",
  reps: "Reps",
  effort: { hard: "Hard", good: "Good", easy: "Easy" },
  effortQuestion: "How hard was it?",
  over: "120 kcal over",
  noRecords: "No records",
  empty: "Log a drink and it appears here.",
  retry: "Retry",
  analyzing: "Analyzing photo",
  importing: "Importing records",
  trend: "Trend",
  trendWeight: "Trend weight",
  scaleWeight: "Scale weight",
  range: "Chart range",
  estimate: "Expenditure",
  holding: "Holding",
  band: "Range",
  checkIns: "Check-ins",
  strength: "Estimated 1RM",
  sessions: "12 sessions",
  bac: "Blood alcohol",
  hoursAgo: "6 hours ago",
  now: "Now",
  macros: { protein: "Protein", carbs: "Carbs", fat: "Fat" },
  noData: "No data in range",
  yes: "Yes",
  no: "No",
};

// Deterministic sample series ending on a fixed day, so screenshots compare across runs.
const sampleTo = "2026-09-29";
const dayBefore = (n: number) =>
  new Date(Date.parse(sampleTo) - n * 86400000).toISOString().slice(0, 10);
const wobble = (i: number) => Math.sin(i * 1.7) * 0.6 + Math.sin(i * 0.31) * 0.4;
const asDate = (day: string) => new Date(`${day}T12:00:00`);

const weights: { day: string; raw: number; trend: number }[] = [];
for (let i = 400, trend = 86; i >= 0; i--) {
  if (i % 3 === 1) continue;
  const raw = 80 + i * 0.015 + wobble(i);
  trend += (raw - trend) * 0.18;
  weights.push({ day: dayBefore(i), raw, trend });
}

const expenditure = Array.from({ length: 120 }, (_, k) => {
  const i = 119 - k;
  const kcal = 2450 + 60 * Math.sin(i / 9) + wobble(i) * 20;
  const spread = 60 + i;
  return { day: dayBefore(i), kcal, low: kcal - spread, high: kcal + spread };
});
// Days 40–55 back are "holding" (dashed); runs share their end points so the line stays continuous.
const run = (a: number, b: number): ChartPoint[] =>
  expenditure.slice(a, b + 1).map((p) => ({ day: p.day, value: p.kcal }));
const expenditureLines: ChartLine[] = [
  { role: "subject", points: run(0, 64), label: sample.estimate },
  { role: "subject", style: "dashed", points: run(64, 79), label: sample.holding },
  { role: "subject", points: run(79, 119), label: sample.estimate },
];
const expenditureBand: ChartBandPoint[] = expenditure.map(({ day, low, high }) => ({
  day,
  low,
  high,
}));
const checkIns: ChartPoint[] = expenditure
  .filter((_, k) => k % 14 === 6)
  .map((p) => ({ day: p.day, value: p.kcal + 40 }));

const strength: ChartPoint[] = Array.from({ length: 12 }, (_, k) => ({
  day: dayBefore((11 - k) * 5),
  value: 100 + k * 1.5 + wobble(k) * 2,
}));

const bacEnd = Date.parse(`${sampleTo}T22:00:00Z`);
const bacFrom = new Date(bacEnd - 6 * 3600000).toISOString();
const bacTo = new Date(bacEnd).toISOString();
const bac: ChartPoint[] = Array.from({ length: 17 }, (_, k) => {
  const hours = 2 + k * 0.25;
  const value = 0.05 * Math.sin(((hours - 2) / 5) * Math.PI);
  return { day: new Date(bacEnd - (6 - hours) * 3600000).toISOString(), value };
});

const palette: [string, string][] = [
  ["background", "bg-background"],
  ["surface", "bg-surface"],
  ["surface-secondary", "bg-surface-secondary"],
  ["surface-tertiary", "bg-surface-tertiary"],
  ["overlay", "bg-overlay"],
  ["separator", "bg-separator"],
  ["border", "bg-border"],
  ["border-strong", "bg-border-strong"],
  ["muted", "bg-muted"],
  ["foreground-secondary", "bg-foreground-secondary"],
  ["foreground", "bg-foreground"],
  ["tint", "bg-tint"],
  ["accent (signal)", "bg-accent"],
  ["accent-foreground", "bg-accent-foreground"],
  ["accent-soft", "bg-accent-soft"],
  ["success", "bg-success"],
  ["warning", "bg-warning"],
  ["danger", "bg-danger"],
  ["cat-1", "bg-cat-1"],
  ["cat-2", "bg-cat-2"],
  ["cat-3", "bg-cat-3"],
];
const iconTones: IconTone[] = [
  "foreground",
  "muted",
  "tint",
  "onSignal",
  "onDanger",
  "danger",
  "warning",
  "success",
];
const unitValues = ["metric", "imperial", "stone"] as const;
const muscleValues = ["chest", "back", "legs", "arms", "core"] as const;
const themeValues = ["both", "light", "dark"] as const;

/** Each specimen with a primary gets its own budget: the gallery shows many, a real screen shows one. */
const Specimen = ({ children }: { children: ReactNode }) => (
  <SignalBudget name="gallery specimen">{children}</SignalBudget>
);

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View className="gap-3">
      <Heading level={2}>{title}</Heading>
      {children}
    </View>
  );
}

function Palette() {
  return (
    <Group title={sample.palette}>
      <View className="flex-row flex-wrap gap-3">
        {palette.map(([name, fill]) => (
          <View key={name} className="w-24 gap-1">
            <View className={twMerge("h-10 rounded-mark border border-border", fill)} />
            <Text variant="caption" tone="secondary">
              {name}
            </Text>
          </View>
        ))}
      </View>
      <View className="flex-row flex-wrap gap-2">
        <View className="flex-row items-center gap-2 rounded-mark bg-accent px-3 py-2">
          <Icon name="check" size={16} tone="onSignal" />
          <Text variant="bodyStrong" tone="onSignal">
            {sample.log}
          </Text>
        </View>
        <View className="rounded-mark bg-tint px-3 py-2">
          <Text variant="bodyStrong" className="text-tint-foreground">
            {sample.save}
          </Text>
        </View>
      </View>
    </Group>
  );
}

function TypeSpecimens() {
  const f = useKitFormat();
  const [pulse, setPulse] = useState(0);
  const kg = f.unitParts(72.4 + pulse / 10, "kilogram", 1);
  // The same weight → family pairing text.tsx uses (all "Inter" until the owner supplies static faces).
  const weightSample = [
    ["400", fonts.normal],
    ["500", fonts.medium],
    ["600", fonts.semibold],
  ] as const;
  return (
    <Group title={sample.type}>
      {(Object.keys(roles) as RoleName[]).map((role) => (
        <View key={role} className="gap-0.5">
          <Text variant="caption" tone="muted">
            {`${role} ${roles[role].size}/${roles[role].line}`}
          </Text>
          <Text variant={role}>
            {"mono" in roles[role]
              ? role === "label"
                ? sample.eyebrow
                : f.number(1234.5, 1)
              : sample.pangram}
          </Text>
        </View>
      ))}
      <Heading level={3}>{sample.weights}</Heading>
      {/* Check #5: the variable Inter instance must show three distinct weights on device. */}
      {weightSample.map(([weight, family]) => (
        <RNText
          key={weight}
          className="text-foreground"
          style={{ fontFamily: family, fontWeight: weight, fontSize: 20, lineHeight: 28 }}
        >
          {`Inter ${weight} · ${sample.pangram}`}
        </RNText>
      ))}
      <RNText className="text-foreground" style={{ fontFamily: fonts.mono, fontSize: 20 }}>
        {"0123456789 +−.,:%"}
      </RNText>
      <View className="gap-2">
        {/* unitParts spreads straight in: value, unit, locale order and locale spacing. */}
        <Value {...kg} size="xl" pulseKey={pulse} />
        <Value {...kg} size="l" />
        <Value {...kg} size="m" />
        <Value {...kg} size="s" />
        <Value value={f.time(new Date(2026, 8, 29, 7, 30))} size="xs" tone="muted" />
        <Value value={f.date(new Date(2026, 8, 29), "medium")} size="s" />
      </View>
      <LinkButton onPress={() => setPulse((n) => n + 1)}>{sample.pulse}</LinkButton>
      <Heading level={1}>{sample.title}</Heading>
      <Heading level={4}>{sample.panelTitle}</Heading>
      <Note>{sample.panelBody}</Note>
      <Label>{sample.eyebrow}</Label>
      <Meta
        items={[sample.drink, f.unit(250, "milliliter"), f.time(new Date(2026, 8, 29, 7, 30))]}
      />
    </Group>
  );
}

function Icons() {
  return (
    <Group title={sample.icons}>
      <View className="flex-row flex-wrap gap-2">
        {(Object.keys(icons) as IconName[]).map((name) => (
          <View key={name} className="w-20 items-center gap-1 py-1">
            <Icon name={name} />
            <Text variant="caption" tone="muted" numberOfLines={1}>
              {name}
            </Text>
          </View>
        ))}
      </View>
      <View className="flex-row flex-wrap gap-3">
        {iconTones.map((tone) => (
          <View
            key={tone}
            className={twMerge(
              "items-center gap-1 rounded-mark p-2",
              tone === "onSignal" && "bg-accent",
              tone === "onDanger" && "bg-danger"
            )}
          >
            <Icon name="done" tone={tone} />
            <Text
              variant="caption"
              tone={tone === "onSignal" ? "onSignal" : "muted"}
              className={tone === "onDanger" ? "text-danger-foreground" : undefined}
            >
              {tone}
            </Text>
          </View>
        ))}
      </View>
    </Group>
  );
}

function Actions() {
  const noop = () => {};
  return (
    <Group title={sample.actions}>
      <Specimen>
        <Button icon="add" onPress={noop}>
          {sample.add}
        </Button>
      </Specimen>
      <Specimen>
        <Button size="lg" onPress={noop}>
          {sample.start}
        </Button>
      </Specimen>
      <Specimen>
        <Button loading onPress={noop}>
          {sample.save}
        </Button>
      </Specimen>
      <Specimen>
        <Button disabled onPress={noop}>
          {sample.save}
        </Button>
      </Specimen>
      <Button variant="secondary" icon="history" onPress={noop}>
        {sample.record}
      </Button>
      <Button variant="ghost" icon="forward" iconPosition="end" onPress={noop}>
        {sample.moreInfo}
      </Button>
      <Button variant="destructive" icon="delete" onPress={noop}>
        {sample.erase}
      </Button>
      <View className="flex-row flex-wrap items-center gap-2">
        <IconButton icon="more" accessibilityLabel={sample.more} onPress={noop} />
        <IconButton icon="add" tone="tint" accessibilityLabel={sample.add} onPress={noop} />
        <IconButton
          icon="edit"
          variant="secondary"
          accessibilityLabel={sample.edit}
          onPress={noop}
        />
        <IconButton icon="delete" tone="danger" accessibilityLabel={sample.delete} onPress={noop} />
        <Specimen>
          <IconButton
            icon="scan"
            variant="primary"
            accessibilityLabel={sample.add}
            onPress={noop}
          />
        </Specimen>
        <IconButton icon="close" disabled accessibilityLabel={sample.more} onPress={noop} />
      </View>
      <LinkButton icon="forward" onPress={noop}>
        {sample.moreInfo}
      </LinkButton>
    </Group>
  );
}

function Panels() {
  const f = useKitFormat();
  const noop = () => {};
  return (
    <Group title={sample.panels}>
      <Panel>
        <Panel.Header eyebrow={sample.weight} meta={f.time(new Date(2026, 8, 29, 7, 30))} />
        <Panel.Title>{sample.panelTitle}</Panel.Title>
        <Panel.Description>{sample.panelBody}</Panel.Description>
        <Panel.Body>
          <Value value={f.number(72.4, 1)} unit="kg" size="l" />
        </Panel.Body>
        <Panel.Footer>
          <Button variant="secondary" onPress={noop}>
            {sample.record}
          </Button>
          <LinkButton onPress={noop}>{sample.moreInfo}</LinkButton>
        </Panel.Footer>
      </Panel>
      <Panel tone="live">
        <Panel.Header eyebrow={sample.rest} meta={f.duration(92)} />
        <Panel.Body>
          <Note>{sample.panelBody}</Note>
        </Panel.Body>
      </Panel>
      <Panel tone="critical">
        <Panel.Header eyebrow={sample.status.error} />
        <Panel.Body>
          <Note tone="default">{sample.callout.danger}</Note>
        </Panel.Body>
      </Panel>
      <Panel onPress={noop} accessibilityLabel={sample.panelTitle}>
        <Panel.Body>
          <Text variant="bodyStrong">{sample.panelTitle}</Text>
          <Note>{sample.panelBody}</Note>
        </Panel.Body>
      </Panel>
    </Group>
  );
}

function Inputs() {
  const f = useKitFormat();
  const [text, setText] = useState(sample.panelBody);
  const [weight, setWeight] = useState(f.number(72.4, 1));
  const [bad, setBad] = useState("4000");
  const [day, setDay] = useState("2026-09-29");
  const [time, setTime] = useState(() => new Date(2026, 8, 29, 7, 30));
  const [unit, setUnit] = useState<(typeof unitValues)[number]>("metric");
  const [range, setRange] = useState<Range>("3M");
  const [muscle, setMuscle] = useState<(typeof muscleValues)[number] | null>("back");
  const [days, setDays] = useState<(keyof typeof sample.days)[]>(["mon", "wed"]);
  const [shift, setShift] = useState<(keyof typeof sample.days)[]>(["fri"]);
  const [setDone, setSetDone] = useState(true);
  const [effort, setEffort] = useState<keyof typeof sample.effort>("good");
  const [favorites, setFavorites] = useState(false);
  const [health, setHealth] = useState(true);
  const [pace, setPace] = useState(0.5);
  const [sets, setSets] = useState(3);
  const [query, setQuery] = useState("");
  return (
    <Group title={sample.inputs}>
      <Field label={sample.notes} value={text} onChange={setText} multiline />
      <Field
        label={sample.weight}
        value={weight}
        onChange={setWeight}
        numeric
        unit="kg"
        hint={sample.hint}
      />
      <Field
        label={sample.weight}
        value={bad}
        onChange={setBad}
        numeric
        unit="kg"
        error={sample.invalid}
      />
      <Field label={sample.weight} value={weight} onChange={setWeight} numeric unit="kg" disabled />
      <DateInput label={sample.date} value={day} onChange={setDay} />
      <TimeInput label={sample.time} value={time} onChange={setTime} minuteInterval={5} />
      <Select
        title={sample.units}
        values={unitValues}
        value={unit}
        onChange={setUnit}
        label={(u) => sample.unitNames[u]}
        showTitle
      />
      <Choices
        values={unitValues}
        value={unit}
        onChange={setUnit}
        label={(u) => sample.unitNames[u]}
        accessibilityLabel={sample.units}
      />
      <RangeChips value={range} onChange={setRange} accessibilityLabel={sample.range} />
      <ChipRow
        values={muscleValues}
        value={muscle}
        onChange={setMuscle}
        label={(m) => sample.muscles[m]}
        accessibilityLabel={sample.muscles.chest}
        groups={[
          ["chest", "back"],
          ["legs", "arms", "core"],
        ]}
        toggle={{
          label: sample.favorites,
          icon: "favorite",
          value: favorites,
          onChange: setFavorites,
        }}
      />
      <ChipRow
        multiple
        required
        values={["mon", "tue", "wed", "thu", "fri"] as const}
        value={days}
        onChange={setDays}
        label={(d) => sample.days[d]}
        accessibilityLabel={sample.days.mon}
      />
      {/* SignalCell: app cells that are neither a Choices segment nor a ChipRow chip. The content passes its
          usual tones; a selected cell turns kit Text, Value and Icon to signal ink. */}
      <View className="flex-row gap-1">
        {(Object.keys(sample.days) as (keyof typeof sample.days)[]).map((d) => (
          <SignalCell
            key={d}
            selected={shift.includes(d)}
            onPress={() =>
              setShift((on) => (on.includes(d) ? on.filter((x) => x !== d) : [...on, d]))
            }
            accessibilityRole="checkbox"
            accessibilityLabel={sample.days[d]}
            check
            className="min-w-0 flex-1 flex-col gap-0.5"
          >
            {sample.days[d]}
          </SignalCell>
        ))}
      </View>
      <View className="flex-row items-center gap-2">
        <SignalCell
          selected={setDone}
          onPress={() => setSetDone(!setDone)}
          accessibilityRole="checkbox"
          accessibilityLabel={sample.setDone}
        >
          <Icon name="check" size={24} tone="muted" />
        </SignalCell>
        <SignalCell selected size="sm" accessibilityLabel={sample.nextSession}>
          <Icon name="play" size={16} tone="tint" />
        </SignalCell>
        <SignalCell selected={setDone} accessibilityLabel={sample.reps} onPress={() => {}}>
          <Value value="8" unit={sample.reps} />
        </SignalCell>
        <SignalCell selected={false} disabled accessibilityLabel={sample.reps} onPress={() => {}}>
          <Value value="8" unit={sample.reps} />
        </SignalCell>
      </View>
      <View
        className="flex-row gap-2"
        accessibilityRole="radiogroup"
        accessibilityLabel={sample.effortQuestion}
      >
        {(Object.keys(sample.effort) as (keyof typeof sample.effort)[]).map((e) => (
          <SignalCell
            key={e}
            selected={effort === e}
            onPress={() => setEffort(e)}
            accessibilityRole="radio"
            accessibilityLabel={sample.effort[e]}
            check
            className="flex-1"
          >
            {sample.effort[e]}
          </SignalCell>
        ))}
      </View>
      <Slider
        value={pace}
        onChange={setPace}
        min={0.25}
        max={1}
        stops={[0.25, 0.5, 0.75, 1]}
        accessibilityLabel={sample.pace}
        valueText={f.unit(pace, "kilogram", 2)}
      />
      <Stepper
        value={sets}
        onChange={setSets}
        min={1}
        max={8}
        label={sample.sets}
        format={(n) => f.number(n)}
      />
      <SearchInput
        value={query}
        onChange={setQuery}
        placeholder={sample.search}
        accessibilityLabel={sample.search}
      />
      <SearchTrigger label={sample.search} onPress={() => {}} />
      <SettingsSection eyebrow={sample.health} footnote={sample.healthNote}>
        <ListRow
          title={sample.health}
          icon="health"
          trailing="toggle"
          toggleValue={health}
          onToggle={setHealth}
        />
        <ListRow
          title={sample.syncing}
          icon="sync"
          trailing="toggle"
          toggleValue={health}
          onToggle={setHealth}
          disabled
        />
      </SettingsSection>
    </Group>
  );
}

function Lists() {
  const f = useKitFormat();
  const noop = () => {};
  const remove = {
    label: sample.delete,
    icon: "delete" as const,
    destructive: true,
    onAction: noop,
  };
  const edit = { label: sample.edit, icon: "edit" as const, onAction: noop };
  return (
    <Group title={sample.lists}>
      <SettingsSection eyebrow={sample.units} footnote={sample.healthNote}>
        <ListRow title={sample.language_} value={sample.english} onPress={noop} />
        <ListRow title={sample.weight} value={f.unit(72.4, "kilogram", 1)} onPress={noop} />
        <ListRow
          title={sample.health}
          description={sample.healthNote}
          icon="health"
          trailing="check"
        />
        <ListRow title={sample.erase} destructive onPress={noop} />
        <ListRow title={sample.language_} value={sample.english} onPress={noop} disabled />
        <ListRow
          title={sample.coffee}
          description={<Meta items={[sample.healthNote, f.number(350)]} />}
          icon="coffee"
          control={
            <Button variant="ghost" onPress={noop}>
              {sample.edit}
            </Button>
          }
        />
      </SettingsSection>
      <Panel inset="none">
        <SwipeRow leadingAction={edit} trailingAction={remove}>
          <RecordRow
            time={f.time(new Date(2026, 8, 29, 7, 30))}
            title={sample.drink}
            description={sample.healthNote}
            value={<Value value={f.number(250)} unit="mL" />}
            onPress={noop}
          />
        </SwipeRow>
        <RecordRow
          time={f.time(new Date(2026, 8, 29, 9, 5))}
          title={sample.coffee}
          leading="coffee"
          value={<Value value={f.number(350)} unit="mL" />}
          control={
            <ActionMenu
              accessibilityLabel={sample.more}
              sections={[
                {
                  actions: [
                    { key: "edit", label: sample.edit, icon: "edit", onPress: noop },
                    {
                      key: "delete",
                      label: sample.delete,
                      icon: "delete",
                      destructive: true,
                      onPress: noop,
                    },
                  ],
                },
              ]}
            />
          }
        />
      </Panel>
      <View className="flex-row items-center justify-between">
        <Label>{sample.more}</Label>
        <ActionMenu
          accessibilityLabel={sample.more}
          sections={[
            {
              actions: [
                { key: "metric", label: sample.unitNames.metric, onPress: noop, selected: true },
                { key: "imperial", label: sample.unitNames.imperial, onPress: noop },
              ],
            },
            {
              actions: [
                { key: "edit", label: sample.edit, icon: "edit", onPress: noop },
                {
                  key: "delete",
                  label: sample.delete,
                  icon: "delete",
                  destructive: true,
                  onPress: noop,
                },
              ],
            },
          ]}
        />
      </View>
    </Group>
  );
}

function Feedback() {
  const f = useKitFormat();
  const noop = () => {};
  return (
    <Group title={sample.feedback}>
      {(["info", "success", "warning", "danger"] as const).map((tone) => (
        <Callout key={tone} tone={tone} title={sample.status.ok}>
          {sample.callout[tone]}
        </Callout>
      ))}
      <ErrorText message={sample.callout.danger} />
      <View className="gap-2">
        {(["live", "ok", "attention", "error", "idle", "off"] as const).map((state) => (
          <Status
            key={state}
            state={state}
            label={sample.status[state]}
            meta={f.time(new Date(2026, 8, 29, 7, 30))}
          />
        ))}
      </View>
      <View className="gap-1">
        <Label>{sample.calories}</Label>
        <Meter
          tone="signal"
          value={1840}
          max={2200}
          target={2000}
          projected={2050}
          accessibilityLabel={sample.calories}
          valueText={`${f.number(1840)} / ${f.number(2200)}`}
        />
      </View>
      <View className="gap-1">
        <Note tone="warning">{sample.over}</Note>
        <Meter
          tone="signal"
          value={2320}
          max={2200}
          accessibilityLabel={sample.calories}
          valueText={sample.over}
        />
      </View>
      <View className="gap-1">
        <Label>{sample.hydration}</Label>
        {/* Past the goal is fine for water: the fill stays full, no warning. */}
        <Meter
          tone="signal"
          value={3100}
          max={2500}
          over="none"
          accessibilityLabel={sample.hydration}
          valueText={`${f.number(3100)} / ${f.number(2500)}`}
        />
      </View>
      <Meter value={0.6} max={1} accessibilityLabel={sample.pace} valueText={f.percent(0.6)} />
      <Meter
        value={0.3}
        max={1}
        size="sm"
        accessibilityLabel={sample.pace}
        valueText={f.percent(0.3)}
      />
      <SystemState
        kind="empty"
        code={sample.noRecords}
        message={sample.empty}
        action={{ label: sample.log, onPress: noop }}
      />
      <SystemState
        kind="error"
        message={sample.callout.danger}
        action={{ label: "", onPress: noop }}
      />
      <SystemState kind="loading" />
      <ProcessLine label={sample.analyzing} />
      <ProcessLine label={sample.importing} done={4} total={7} />
    </Group>
  );
}

function WeightChartSample() {
  const f = useKitFormat();
  const [range, setRange] = useState<Range>("3M");
  const [at, setAt] = useState<ChartPoint | null>(null);
  const from = rangeStart(range, sampleTo, weights[0].day);
  const shown = weights.filter((p) => p.day >= from);
  const first = shown[0];
  const latest = shown[shown.length - 1];
  const scaleAt = at ? shown.find((p) => p.day === at.day) : undefined;
  const value = f.unitParts(at ? at.value : latest.trend, "kilogram", 1);
  return (
    <Panel>
      <Panel.Body>
        <RangeSummary
          label={at ? f.date(asDate(at.day)) : sample.trend}
          {...value}
          delta={at ? undefined : f.number(latest.trend - first.trend, 1, true)}
          meta={
            scaleAt
              ? [sample.scaleWeight, f.unit(scaleAt.raw, "kilogram", 1)]
              : [f.dateRange(asDate(first.day), asDate(latest.day))]
          }
        />
        <TrendChart
          from={from}
          to={sampleTo}
          lines={[
            {
              role: "reference",
              points: shown.map((p) => ({ day: p.day, value: p.raw })),
              label: sample.scaleWeight,
            },
            {
              role: "subject",
              points: shown.map((p) => ({ day: p.day, value: p.trend })),
              label: sample.trendWeight,
            },
          ]}
          goal={{ value: 80, label: f.unit(80, "kilogram") }}
          minSpan={2}
          yFormat={(n) => f.number(n)}
          summary={f.list([
            sample.trendWeight,
            f.dateRange(asDate(first.day), asDate(latest.day)),
            f.unit(latest.trend, "kilogram", 1),
          ])}
          onScrub={setAt}
        />
        <RangeChips value={range} onChange={setRange} accessibilityLabel={sample.range} />
      </Panel.Body>
    </Panel>
  );
}

function Charts() {
  const f = useKitFormat();
  const latestBac = bac[bac.length - 1].value;
  return (
    <Group title={sample.charts}>
      <WeightChartSample />
      <Panel>
        <Panel.Body>
          <RangeSummary
            label={sample.estimate}
            value={f.number(expenditure[expenditure.length - 1].kcal)}
            unit="kcal"
            meta={[f.dateRange(asDate(expenditure[0].day), asDate(sampleTo))]}
          />
          <TrendChart
            lines={expenditureLines}
            band={{ points: expenditureBand, label: sample.band }}
            markers={{ points: checkIns, label: sample.checkIns }}
            minSpan={300}
            yFormat={(n) => f.number(n)}
            summary={sample.estimate}
            onScrub={() => {}}
          />
        </Panel.Body>
      </Panel>
      <Panel>
        <Panel.Body>
          <RangeSummary
            label={sample.strength}
            value={f.number(strength[strength.length - 1].value)}
            unit="kg"
            delta={f.number(strength[strength.length - 1].value - strength[0].value, 0, true)}
            meta={[sample.sessions]}
          />
          <TrendChart
            lines={[{ role: "subject", points: strength }]}
            minSpan={5}
            zero={false}
            yFormat={(n) => f.number(n)}
            summary={sample.strength}
          />
        </Panel.Body>
      </Panel>
      <Panel>
        <Panel.Body>
          <View className="flex-row items-center gap-4">
            <View className="flex-1 gap-1">
              <Label>{sample.bac}</Label>
              <Value {...f.percentParts(latestBac / 100, 3, { fixed: true })} size="m" />
            </View>
            <View className="flex-1 gap-1">
              <Sparkline points={bac} from={bacFrom} to={bacTo} zero />
              <View className="flex-row justify-between">
                <Text variant="caption" tone="muted">
                  {sample.hoursAgo}
                </Text>
                <Text variant="caption" tone="muted">
                  {sample.now}
                </Text>
              </View>
            </View>
          </View>
          <View className="flex-row items-center gap-4">
            <View className="flex-1">
              <Value value={f.number(strength[strength.length - 1].value)} unit="kg" />
            </View>
            <View className="w-24">
              <Sparkline points={strength} minSpan={5} />
            </View>
          </View>
          <View className="w-32">
            <Sparkline points={[]} />
          </View>
        </Panel.Body>
      </Panel>
      <Legend
        items={[
          { label: sample.macros.protein, style: "cat-1" },
          { label: sample.macros.carbs, style: "cat-2" },
          { label: sample.macros.fat, style: "cat-3" },
        ]}
      />
      <TrendChart
        lines={[{ role: "subject", points: [] }]}
        yFormat={(n) => f.number(n)}
        summary={sample.noData}
        height={120}
      />
    </Group>
  );
}

function Scaffold() {
  const f = useKitFormat();
  const undo = useUndo();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const noop = () => {};
  return (
    <Group title={sample.scaffold}>
      <Specimen>
        <ScreenFooter>
          <Button size="lg" className="flex-1" onPress={noop}>
            {sample.start}
          </Button>
        </ScreenFooter>
      </Specimen>
      <ScreenFooter tone="live">
        <Text variant="label" tone="onSignal">
          {sample.rest}
        </Text>
        <Value value={f.duration(92)} size="l" tone="onSignal" />
        <LinkButton onPress={noop}>{sample.skip}</LinkButton>
      </ScreenFooter>
      <Button
        variant="secondary"
        icon="undo"
        onPress={() => undo.show({ message: sample.deleted, onUndo: noop })}
      >
        {sample.undo}
      </Button>
      <Button variant="secondary" icon="edit" onPress={() => setOpen(true)}>
        {sample.editor}
      </Button>
      <Editor
        title={sample.editorTitle}
        eyebrow={sample.record}
        open={open}
        close={() => setOpen(false)}
        dirty={value !== ""}
        primary={{ label: sample.save, onPress: () => setOpen(false), disabled: value === "" }}
        destructive={{ label: sample.delete, onPress: () => setOpen(false) }}
      >
        <Field
          label={sample.weight}
          value={value}
          onChange={setValue}
          numeric
          unit="kg"
          autoFocus
        />
        <DateInput label={sample.date} value="2026-09-29" onChange={noop} />
      </Editor>
    </Group>
  );
}

const formatSamples = (f: Format): [string, string][] => {
  const day = new Date(2026, 8, 29);
  return [
    ["number −2.4 signed", f.number(-2.4, 1, true)],
    ["number 80 fixed", f.number(80, 1)],
    ["editable 2000", f.editable(2000)],
    ["percent 0.05% fixed", f.percent(0.0005, 3, { fixed: true })],
    ["percentParts sign", f.percentParts(0.2).unit],
    ["unit 80 kg fixed", f.unit(80, "kilogram", 1, { fixed: true })],
    ["unit 12 g", f.unit(12, "gram")],
    ["unit 95 mg", f.unit(95, "milligram")],
    ["monthDay", f.monthDay(day)],
    ["monthYear", f.monthYear(day)],
    ["year", f.year(day)],
    ["weekdayLong", f.weekdayLong(day)],
    ["dateRange year", f.dateRange(new Date(2026, 8, 22), day, { year: true })],
    ["list or", f.list(["A", "B", "C"], { type: "disjunction" })],
    [
      "list unit",
      f.list([f.unit(1, "hour"), f.unit(5, "minute")], { type: "unit", style: "narrow" }),
    ],
  ];
};

function Environment() {
  const kit = useKit();
  const yes = (on: boolean) => (on ? sample.yes : sample.no);
  return (
    <Group title={sample.environment}>
      <SettingsSection eyebrow={sample.language}>
        <ListRow title="locale" value={kit.locale} />
        <ListRow title="script" value={kit.script} />
        <ListRow title="isRTL" value={yes(kit.isRTL)} />
        <ListRow title="fontScale" value={kit.format.number(kit.fontScale, 2)} />
        <ListRow title="largeType" value={yes(kit.largeType)} />
        <ListRow title="boldText" value={yes(kit.boldText)} />
        <ListRow title="reduceMotion" value={yes(kit.reduceMotion)} />
      </SettingsSection>
      {/* Check #11: Hermes Intl coverage, also logged once on mount. */}
      <SettingsSection eyebrow="Intl">
        {Object.entries(intlSupport).map(([key, on]) => (
          <ListRow key={key} title={key} value={yes(on)} />
        ))}
      </SettingsSection>
      {/* The same calls on the engine in hand: fallbacks show here when Intl lacks a feature. */}
      <SettingsSection eyebrow="format">
        {formatSamples(kit.format).map(([key, text]) => (
          <ListRow key={key} title={key} value={text} />
        ))}
      </SettingsSection>
      <SettingsSection eyebrow="flags">
        {Object.entries(kit.flags).map(([key, on]) => (
          <ListRow key={key} title={key} value={yes(on)} />
        ))}
      </SettingsSection>
    </Group>
  );
}

function Section({ theme }: { theme: "light" | "dark" }) {
  return (
    <ScopedTheme theme={theme}>
      <View className="gap-8 rounded-panel border border-border bg-background p-4">
        <Label>{sample[theme]}</Label>
        <Palette />
        <TypeSpecimens />
        <Icons />
        <Actions />
        <Panels />
        <Inputs />
        <Lists />
        <Feedback />
        <Charts />
        <Scaffold />
      </View>
    </ScopedTheme>
  );
}

/**
 * Every kit component with sample data, in light and dark. A route renders it inside __DEV__ only:
 * `export default __DEV__ ? VectorGallery : () => <Redirect href="/" />`.
 */
export function VectorGallery() {
  const kit = useKit();
  const [themes, setThemes] = useState<(typeof themeValues)[number]>("both");
  const [language, setLanguage] = useState<KitLanguage>(kit.language);
  useEffect(() => {
    console.log("[vector] gallery", { locale: kit.locale, intlSupport });
  }, [kit.locale]);
  return (
    <DetailScreen title={sample.title}>
      <Choices
        values={themeValues}
        value={themes}
        onChange={setThemes}
        label={(t) => sample[t]}
        accessibilityLabel={sample.theme}
      />
      <Select
        title={sample.language}
        values={kitLanguages}
        value={language}
        onChange={setLanguage}
        label={(l) => l}
      />
      {/* A nested provider switches the kit's words, script rules and formats; the app's own stays as it is. */}
      <VectorProvider
        language={language}
        haptics={kit.haptics}
        renderIcon={kit.renderIcon}
        flags={kit.flags}
      >
        <Environment />
        {themes !== "dark" ? <Section theme="light" /> : null}
        {themes !== "light" ? <Section theme="dark" /> : null}
      </VectorProvider>
    </DetailScreen>
  );
}
