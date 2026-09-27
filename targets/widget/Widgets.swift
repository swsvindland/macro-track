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

private struct Snapshot: Codable {
  let days: [String: Day]
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

struct MacrosEntry: TimelineEntry {
  let date: Date
  /** Nil until the app has written this day, e.g. a week after it was last opened. */
  let day: Day?
}

struct Provider: TimelineProvider {
  func placeholder(in context: Context) -> MacrosEntry {
    MacrosEntry(date: .now, day: .sample)
  }

  func getSnapshot(in context: Context, completion: @escaping (MacrosEntry) -> Void) {
    let day = loadSnapshot()?.days[dayKey(.now)]
    completion(MacrosEntry(date: .now, day: day ?? (context.isPreview ? .sample : nil)))
  }

  // The app reloads the timeline after every write. Until then, each midnight turns over to
  // the next day it already wrote, with nothing eaten and that day's (shifted) targets.
  func getTimeline(in context: Context, completion: @escaping (Timeline<MacrosEntry>) -> Void) {
    let days = loadSnapshot()?.days ?? [:]
    let calendar = Calendar.current
    var entries = [MacrosEntry(date: .now, day: days[dayKey(.now)])]
    var midnight = calendar.startOfDay(for: .now)
    for _ in 0..<7 {
      guard let next = calendar.date(byAdding: .day, value: 1, to: midnight) else { break }
      midnight = next
      entries.append(MacrosEntry(date: midnight, day: days[dayKey(midnight)]))
    }
    completion(Timeline(entries: entries, policy: .never))
  }
}

// MARK: - Pieces

private func whole(_ value: Double) -> String {
  Int(value.rounded()).formatted()
}

/** Home's headline: kcal left, kcal over in red, or kcal eaten without targets. */
private struct Headline {
  let value: String
  let unit: String
  let over: Bool

  init(_ day: Day) {
    if let target = day.target {
      let left = target.calories - day.eaten.calories
      over = left < 0
      value = whole(abs(left))
      unit = over ? "kcal over" : "kcal left"
    } else {
      over = false
      value = whole(day.eaten.calories)
      unit = "kcal eaten"
    }
  }
}

private struct Bar: View {
  let value: Double
  let max: Double
  var fill = Color("calories")
  var height: CGFloat = 4

  var body: some View {
    GeometryReader { geo in
      ZStack(alignment: .leading) {
        Capsule().fill(Color("track"))
        Capsule()
          .fill(value > max ? Color("danger") : fill)
          .frame(width: max > 0 ? geo.size.width * min(value / max, 1) : 0)
          .widgetAccentable()
      }
    }
    .frame(height: height)
  }
}

private struct MacroColumn: View {
  let name: String
  let eaten: Double
  let target: Double?
  let compact: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(compact ? String(name.prefix(1)) : name)
        .font(.caption2.weight(.medium))
        .textCase(.uppercase)
        .foregroundStyle(.secondary)
      let value = Text(whole(eaten))
        .font(compact ? .caption.weight(.semibold) : .subheadline.weight(.semibold))
      let unit = Text(compact ? "" : target.map { " / \(whole($0)) g" } ?? " g")
        .font(.caption)
        .foregroundStyle(.secondary)
      Text("\(value)\(unit)")
        .monospacedDigit()
        .lineLimit(1)
        .minimumScaleFactor(0.7)
      if let target, target > 0 {
        Bar(value: eaten, max: target, fill: .secondary.opacity(0.8), height: 3)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

private struct MacroRow: View {
  let day: Day
  var compact = false

  var body: some View {
    HStack(alignment: .top, spacing: compact ? 8 : 14) {
      MacroColumn(
        name: "Protein", eaten: day.eaten.protein, target: day.target?.protein, compact: compact)
      MacroColumn(name: "Carbs", eaten: day.eaten.carbs, target: day.target?.carbs, compact: compact)
      MacroColumn(name: "Fat", eaten: day.eaten.fat, target: day.target?.fat, compact: compact)
    }
  }
}

private struct HeadlineView: View {
  let day: Day
  var size: CGFloat = 30

  var body: some View {
    let headline = Headline(day)
    VStack(alignment: .leading, spacing: 5) {
      let value = Text(headline.value).font(.system(size: size, weight: .semibold, design: .rounded))
      let unit = Text(" \(headline.unit)").font(.footnote.weight(.medium)).foregroundStyle(.secondary)
      Text("\(value)\(unit)")
        .foregroundStyle(headline.over ? Color("danger") : .primary)
        .monospacedDigit()
        .lineLimit(1)
        .minimumScaleFactor(0.6)
      if let target = day.target {
        Bar(value: day.eaten.calories, max: target.calories, height: 5)
      }
    }
  }
}

enum LogAction {
  case scan, photo

  var url: URL {
    URL(string: self == .scan ? "macrotrack://scan" : "macrotrack://photo")!
  }
  var label: String { self == .scan ? "Scan" : "AI" }
  var spoken: String { self == .scan ? "Scan a barcode" : "Log a photo or description" }
  var symbol: String {
    if self == .scan { return "barcode.viewfinder" }
    return UIImage(systemName: "apple.intelligence") != nil ? "apple.intelligence" : "sparkles"
  }
}

private struct ActionButton: View {
  let action: LogAction
  /** Icon over label for the medium widget's column; icon alone in the small widget. */
  var stacked = false

  var body: some View {
    Link(destination: action.url) {
      VStack(spacing: 4) {
        Image(systemName: action.symbol).font(.title3)
        if stacked {
          Text(action.label).font(.caption.weight(.semibold))
        }
      }
      .foregroundStyle(Color.accentColor)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(Color("track"), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
    .accessibilityLabel(action.spoken)
  }
}

private struct EmptyDay: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text("Macros").font(.headline)
      Text("Open the app to update today.")
        .font(.caption)
        .foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

// MARK: - Families

private struct SmallView: View {
  let day: Day?

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if let day {
        HeadlineView(day: day, size: 24)
        MacroRow(day: day, compact: true)
      } else {
        EmptyDay()
      }
      Spacer(minLength: 0)
      HStack(spacing: 8) {
        ActionButton(action: .scan)
        ActionButton(action: .photo)
      }
      .frame(height: 38)
    }
  }
}

private struct MediumView: View {
  let day: Day?

  var body: some View {
    HStack(spacing: 14) {
      VStack(alignment: .leading, spacing: 10) {
        if let day {
          HeadlineView(day: day)
          Spacer(minLength: 0)
          MacroRow(day: day)
        } else {
          EmptyDay()
          Spacer(minLength: 0)
        }
      }
      VStack(spacing: 8) {
        ActionButton(action: .scan, stacked: true)
        ActionButton(action: .photo, stacked: true)
      }
      .frame(width: 76)
    }
  }
}

private struct CircularView: View {
  let day: Day?

  var body: some View {
    if let day, let target = day.target {
      let headline = Headline(day)
      Gauge(value: min(day.eaten.calories, target.calories), in: 0...max(target.calories, 1)) {
        Text("kcal")
      } currentValueLabel: {
        Text(headline.over ? "+\(headline.value)" : headline.value)
          .monospacedDigit()
          .minimumScaleFactor(0.5)
      }
      .gaugeStyle(.accessoryCircularCapacity)
      .widgetAccentable()
    } else {
      ZStack {
        AccessoryWidgetBackground()
        Image(systemName: "fork.knife")
      }
    }
  }
}

private struct RectangularView: View {
  let day: Day?

  var body: some View {
    if let day {
      let headline = Headline(day)
      VStack(alignment: .leading, spacing: 1) {
        Text("\(headline.value) \(headline.unit)")
          .font(.headline)
          .widgetAccentable()
        Text("P \(whole(day.eaten.protein)) · C \(whole(day.eaten.carbs)) · F \(whole(day.eaten.fat))")
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
      Text("Open Macros to update").font(.caption)
    }
  }
}

struct MacrosWidgetView: View {
  @Environment(\.widgetFamily) private var family
  let entry: MacrosEntry

  var body: some View {
    Group {
      switch family {
      case .systemMedium: MediumView(day: entry.day)
      case .accessoryCircular: CircularView(day: entry.day)
      case .accessoryRectangular: RectangularView(day: entry.day)
      case .accessoryInline:
        if let day = entry.day {
          let headline = Headline(day)
          Text("\(headline.value) \(headline.unit)")
        } else {
          Text("Macros")
        }
      default: SmallView(day: entry.day)
      }
    }
    .containerBackground(for: .widget) { Color("$widgetBackground") }
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
  }
}

@main
struct MacrosWidgets: WidgetBundle {
  var body: some Widget {
    MacrosWidget()
  }
}
