import SwiftUI
import WidgetKit

// Written by src/lib/widget.ts through the shared App Group.
private let appGroup = "group.dev.svindland.vector.macro"

struct Macros: Codable {
  let calories: Double
  let protein: Double
  let carbs: Double
  let fat: Double
}

struct Day: Codable {
  let eaten: Macros
  let target: Macros?

  static let sample = Day(
    eaten: Macros(calories: 1260, protein: 92, carbs: 130, fat: 41),
    target: Macros(calories: 2300, protein: 170, carbs: 240, fat: 70)
  )
}

/// Strings translated on the phone, in the app's language (`widgetText` in src/lib/widget.ts).
/// Every field is optional, so snapshots written before a field existed still decode.
struct WidgetText: Codable {
  var kcalLeft: String?
  var kcalOver: String?
  var kcalEaten: String?
  var kcal: String?
  var protein: String?
  var carbs: String?
  var fat: String?
  /** Templates such as "P {value}". */
  var proteinShort: String?
  var carbsShort: String?
  var fatShort: String?
  /** "/ {target} g" */
  var ofTarget: String?
  var grams: String?
  var scan: String?
  var photo: String?
  var scanHint: String?
  var photoHint: String?
  var title: String?
  var openToUpdate: String?
}

private struct Snapshot: Codable {
  let days: [String: Day]
  /** BCP-47 tag from localeTag() in src/vector/format.ts; formats the widget's numbers. */
  var locale: String?
  var text: WidgetText?
}

/** The app's day key, YYYY-MM-DD in the phone's time zone. */
private func dayKey(_ date: Date) -> String {
  let parts = Calendar.current.dateComponents([.year, .month, .day], from: date)
  return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
}

private func loadSnapshot() -> Snapshot? {
  guard let text = UserDefaults(suiteName: appGroup)?.string(forKey: "snapshot"),
    let data = text.data(using: .utf8)
  else { return nil }
  return try? JSONDecoder().decode(Snapshot.self, from: data)
}

/// Strings and number formatting for one render. English fallbacks cover the time before the app
/// first writes a snapshot.
struct WidgetCopy {
  let locale: Locale
  let script: VectorScript
  let t: WidgetText

  init(locale identifier: String?, text: WidgetText?) {
    locale = identifier.map(Locale.init(identifier:)) ?? .current
    script = VectorScript.of(identifier ?? Locale.current.identifier)
    t = text ?? WidgetText()
  }

  static let fallback = WidgetCopy(locale: nil, text: nil)

  var kcalLeft: String { t.kcalLeft ?? "kcal left" }
  var kcalOver: String { t.kcalOver ?? "kcal over" }
  var kcalEaten: String { t.kcalEaten ?? "kcal eaten" }
  var kcal: String { t.kcal ?? "kcal" }
  var grams: String { t.grams ?? "g" }
  var title: String { t.title ?? "Macros" }
  var openToUpdate: String { t.openToUpdate ?? "Open the app to update today." }

  func whole(_ value: Double) -> String {
    Int(value.rounded()).formatted(.number.locale(locale))
  }

  /** "+120": the sign is part of the locale's number format. */
  func signed(_ value: Double) -> String {
    Int(value.rounded()).formatted(.number.sign(strategy: .always()).locale(locale))
  }

  func ofTarget(_ target: Double) -> String {
    (t.ofTarget ?? "/ {target} g").replacingOccurrences(of: "{target}", with: whole(target))
  }

  /** A macro's short template with its amount, or the bare short label without one. */
  func short(_ template: String?, _ fallback: String, _ value: Double? = nil) -> String {
    let text = template ?? "\(fallback) {value}"
    guard let value else {
      return text.replacingOccurrences(of: "{value}", with: "").trimmingCharacters(in: .whitespaces)
    }
    return text.replacingOccurrences(of: "{value}", with: whole(value))
  }
}

struct MacrosEntry: TimelineEntry {
  let date: Date
  /** Nil until the app has written this day, e.g. a week after it was last opened. */
  let day: Day?
  var copy: WidgetCopy = .fallback
}

struct Provider: TimelineProvider {
  func placeholder(in context: Context) -> MacrosEntry {
    MacrosEntry(date: .now, day: .sample)
  }

  func getSnapshot(in context: Context, completion: @escaping (MacrosEntry) -> Void) {
    let snapshot = loadSnapshot()
    let day = snapshot?.days[dayKey(.now)]
    completion(
      MacrosEntry(
        date: .now, day: day ?? (context.isPreview ? .sample : nil),
        copy: WidgetCopy(locale: snapshot?.locale, text: snapshot?.text)))
  }

  // The app reloads the timeline after every write. Until then, each midnight turns over to
  // the next day it already wrote, with nothing eaten and that day's (shifted) targets.
  func getTimeline(in context: Context, completion: @escaping (Timeline<MacrosEntry>) -> Void) {
    let snapshot = loadSnapshot()
    let days = snapshot?.days ?? [:]
    let copy = WidgetCopy(locale: snapshot?.locale, text: snapshot?.text)
    let calendar = Calendar.current
    var entries = [MacrosEntry(date: .now, day: days[dayKey(.now)], copy: copy)]
    var midnight = calendar.startOfDay(for: .now)
    for _ in 0..<7 {
      guard let next = calendar.date(byAdding: .day, value: 1, to: midnight) else { break }
      midnight = next
      entries.append(MacrosEntry(date: midnight, day: days[dayKey(midnight)], copy: copy))
    }
    completion(Timeline(entries: entries, policy: .never))
  }
}

// MARK: - Pieces

/** Home's headline: kcal left, kcal over (with the over glyph), or kcal eaten without targets. */
private struct Headline {
  /** Always positive; `over` says which side of the target it is on. */
  let amount: Double
  let value: String
  let unit: String
  let over: Bool

  init(_ day: Day, _ copy: WidgetCopy) {
    if let target = day.target {
      let left = target.calories - day.eaten.calories
      over = left < 0
      amount = abs(left)
      unit = over ? copy.kcalOver : copy.kcalLeft
    } else {
      over = false
      amount = day.eaten.calories
      unit = copy.kcalEaten
    }
    value = copy.whole(amount)
  }
}

private struct MacroColumn: View {
  let name: String
  let short: String
  let eaten: Double
  let target: Double?
  let compact: Bool
  let copy: WidgetCopy

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      if compact {
        Text(verbatim: short).font(.caption2.weight(.medium)).foregroundStyle(.secondary)
      } else {
        VectorLabel(text: name, script: copy.script)
      }
      let value = Text(verbatim: copy.whole(eaten))
        .font(VectorFont.readout(compact ? .caption : .subheadline, weight: .medium))
      let unit = Text(verbatim: compact ? "" : " " + (target.map(copy.ofTarget) ?? copy.grams))
        .font(.caption)
        .foregroundStyle(.secondary)
      Text("\(value)\(unit)")
        .monospacedDigit()
        .lineLimit(1)
        .minimumScaleFactor(0.7)
      if let target, target > 0 {
        VectorMeter(fraction: eaten / target, over: eaten > target, style: .neutral, height: 3)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

private struct MacroRow: View {
  let day: Day
  var compact = false
  let copy: WidgetCopy

  var body: some View {
    // Always P · C · F, as in the app.
    HStack(alignment: .top, spacing: compact ? 8 : 14) {
      MacroColumn(
        name: copy.t.protein ?? "Protein", short: copy.short(copy.t.proteinShort, "P"),
        eaten: day.eaten.protein, target: day.target?.protein, compact: compact, copy: copy)
      MacroColumn(
        name: copy.t.carbs ?? "Carbs", short: copy.short(copy.t.carbsShort, "C"),
        eaten: day.eaten.carbs, target: day.target?.carbs, compact: compact, copy: copy)
      MacroColumn(
        name: copy.t.fat ?? "Fat", short: copy.short(copy.t.fatShort, "F"),
        eaten: day.eaten.fat, target: day.target?.fat, compact: compact, copy: copy)
    }
  }
}

private struct HeadlineView: View {
  let day: Day
  let copy: WidgetCopy
  var style: Font.TextStyle = .title

  var body: some View {
    let headline = Headline(day, copy)
    VStack(alignment: .leading, spacing: 5) {
      HStack(alignment: .firstTextBaseline, spacing: 4) {
        if headline.over {
          Image(systemName: VectorSymbol.over).font(.footnote).accessibilityHidden(true)
        }
        Text(verbatim: headline.value)
          .vectorReadout(style, weight: .medium)
          .widgetAccentable()
        Text(verbatim: headline.unit)
          .font(.footnote.weight(.medium))
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }
      if let target = day.target {
        VectorMeter(
          fraction: day.eaten.calories / max(target.calories, 1), over: headline.over, height: 6)
      }
    }
    .accessibilityElement(children: .combine)
  }
}

enum LogAction {
  case scan, photo

  var url: URL {
    URL(string: self == .scan ? "macrotrack://scan" : "macrotrack://photo")!
  }
  func label(_ copy: WidgetCopy) -> String {
    self == .scan ? (copy.t.scan ?? "Scan") : (copy.t.photo ?? "AI")
  }
  func spoken(_ copy: WidgetCopy) -> String {
    self == .scan
      ? (copy.t.scanHint ?? "Scan barcode") : (copy.t.photoHint ?? "Log a photo or description")
  }
  var symbol: String { self == .scan ? VectorSymbol.scan : VectorSymbol.analysis }
  /// Scan is the widget's one signal plate; the second action stays quiet.
  var role: VectorPlateRole { self == .scan ? .signal : .quiet }
}

private struct ActionButton: View {
  let action: LogAction
  let copy: WidgetCopy
  /** Icon over label for the medium widget's column; icon alone in the small widget. */
  var stacked = false

  var body: some View {
    Link(destination: action.url) {
      VStack(spacing: 4) {
        Image(systemName: action.symbol).font(.title3.weight(.semibold))
        if stacked {
          Text(verbatim: action.label(copy))
            .font(.caption.weight(.semibold))
            .lineLimit(1)
            .minimumScaleFactor(0.7)
        }
      }
      // An opaque plate here turned white on tinted and clear Home Screens. vectorPlate keeps
      // the glyph accentable and the plate translucent there.
      .vectorPlate(action.role)
    }
    .accessibilityLabel(action.spoken(copy))
  }
}

private struct EmptyDay: View {
  let copy: WidgetCopy

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(verbatim: copy.title).font(.headline)
      Text(verbatim: copy.openToUpdate)
        .font(.caption)
        .foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

// MARK: - Families

private struct SmallView: View {
  let entry: MacrosEntry

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if let day = entry.day {
        HeadlineView(day: day, copy: entry.copy, style: .title2)
        MacroRow(day: day, compact: true, copy: entry.copy)
      } else {
        EmptyDay(copy: entry.copy)
      }
      Spacer(minLength: 0)
      HStack(spacing: 8) {
        ActionButton(action: .scan, copy: entry.copy)
        ActionButton(action: .photo, copy: entry.copy)
      }
      .frame(height: 38)
    }
  }
}

private struct MediumView: View {
  let entry: MacrosEntry

  var body: some View {
    HStack(spacing: 14) {
      VStack(alignment: .leading, spacing: 10) {
        if let day = entry.day {
          HeadlineView(day: day, copy: entry.copy)
          Spacer(minLength: 0)
          MacroRow(day: day, copy: entry.copy)
        } else {
          EmptyDay(copy: entry.copy)
          Spacer(minLength: 0)
        }
      }
      VStack(spacing: 8) {
        ActionButton(action: .scan, copy: entry.copy, stacked: true)
        ActionButton(action: .photo, copy: entry.copy, stacked: true)
      }
      .frame(width: 76)
    }
  }
}

private struct CircularView: View {
  let entry: MacrosEntry

  var body: some View {
    if let day = entry.day, let target = day.target {
      let headline = Headline(day, entry.copy)
      Gauge(value: min(day.eaten.calories, target.calories), in: 0...max(target.calories, 1)) {
        Text(verbatim: entry.copy.kcal)
      } currentValueLabel: {
        Text(verbatim: headline.over ? entry.copy.signed(headline.amount) : headline.value)
          .monospacedDigit()
          .minimumScaleFactor(0.5)
      }
      .gaugeStyle(.accessoryCircularCapacity)
      .widgetAccentable()
    } else {
      ZStack {
        AccessoryWidgetBackground()
        Image(systemName: VectorSymbol.food)
      }
    }
  }
}

private struct RectangularView: View {
  let entry: MacrosEntry

  var body: some View {
    if let day = entry.day {
      let copy = entry.copy
      let headline = Headline(day, copy)
      VStack(alignment: .leading, spacing: 1) {
        Text(verbatim: "\(headline.value) \(headline.unit)")
          .font(.headline)
          .widgetAccentable()
        HStack(spacing: 6) {
          Text(verbatim: copy.short(copy.t.proteinShort, "P", day.eaten.protein))
          Text(verbatim: copy.short(copy.t.carbsShort, "C", day.eaten.carbs))
          Text(verbatim: copy.short(copy.t.fatShort, "F", day.eaten.fat))
        }
        .font(.caption)
        if let target = day.target {
          Gauge(value: min(day.eaten.calories, target.calories), in: 0...max(target.calories, 1)) {
            EmptyView()
          }
          .gaugeStyle(.accessoryLinearCapacity)
        }
      }
      .monospacedDigit()
      .frame(maxWidth: .infinity, alignment: .leading)
    } else {
      Text(verbatim: entry.copy.openToUpdate).font(.caption)
    }
  }
}

struct MacrosWidgetView: View {
  @Environment(\.widgetFamily) private var family
  let entry: MacrosEntry

  var body: some View {
    Group {
      switch family {
      case .systemMedium: MediumView(entry: entry)
      case .accessoryCircular: CircularView(entry: entry)
      case .accessoryRectangular: RectangularView(entry: entry)
      case .accessoryInline:
        if let day = entry.day {
          let headline = Headline(day, entry.copy)
          Text(verbatim: "\(headline.value) \(headline.unit)")
        } else {
          Text(verbatim: entry.copy.title)
        }
      default: SmallView(entry: entry)
      }
    }
    .vectorWidgetTypeCap()
    .vectorWidgetBackground()
  }
}

struct MacrosWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "Macros", provider: Provider()) { entry in
      MacrosWidgetView(entry: entry)
    }
    .configurationDisplayName("Macros")
    .description("Calories and macros left today, with barcode and AI logging a tap away.")
    .supportedFamilies([
      .systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular, .accessoryInline,
    ])
    .disfavoredLocations(VectorWidget.disfavoredSmallLocations, for: [.systemSmall])
  }
}

@main
struct MacrosWidgets: WidgetBundle {
  var body: some Widget {
    MacrosWidget()
  }
}
