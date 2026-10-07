// Vector Kit 1.0.0 — targets/_shared/VectorTheme.swift  (lineage: SIBYL)
// Byte-identical in lift-track, macro-track and water-track. Hash-checked by scripts/vector-kit.mjs.
// Canonical copy: /Users/sam/Development/VectorApps/vector-design/kit/targets/_shared/VectorTheme.swift.
//
// @bacons/apple-targets 5.0.0 compiles every file in targets/_shared into the main app AND every target, so this
// file must type-check for all of them (checked by `node scripts/vector-kit.mjs check --swift`):
//   iOS app       -sdk iphoneos -target arm64-apple-ios16.4
//   iOS appex     -sdk iphoneos -target arm64-apple-ios16.4 -application-extension   (lift activity; macro widget 17.0)
//   watchOS       -sdk watchos  -target arm64_32-apple-watchos10.0                    (water 10.0, lift 11.0)
// Rules: Vector-prefixed names only, no @main, no asset-catalog lookups, no fonts (SF / SF Mono only),
// leading/trailing only (never left/right), every OS-26 API behind #available with a shipped fallback.

import SwiftUI
#if canImport(UIKit)
import UIKit
#endif
#if canImport(WidgetKit)
import WidgetKit
#endif

// MARK: - Tokens

/// One colour in four appearances. watchOS always uses `dark` (the watch UI is black).
struct VectorRGB: Sendable {
    let light: UInt32
    let dark: UInt32
    let hcLight: UInt32
    let hcDark: UInt32
}

// TOKENS:BEGIN — generated from src/vector/tokens.json by scripts/vector-kit.mjs gen (kit 1.3.1). Do not edit.
enum VectorTokens {
    static let version = "1.3.1"
    static let background = VectorRGB(light: 0xFFFFFF, dark: 0x071017, hcLight: 0xFFFFFF, hcDark: 0x071017)
    static let foreground = VectorRGB(light: 0x15212B, dark: 0xF3F6F7, hcLight: 0x071017, hcDark: 0xFFFFFF)
    static let surface = VectorRGB(light: 0xFFFFFF, dark: 0x0D171E, hcLight: 0xFFFFFF, hcDark: 0x0D171E)
    static let surfaceSecondary = VectorRGB(light: 0xF7F9FA, dark: 0x111D25, hcLight: 0xF7F9FA, hcDark: 0x111D25)
    static let surfaceTertiary = VectorRGB(light: 0xF1F5F7, dark: 0x15232C, hcLight: 0xF1F5F7, hcDark: 0x15232C)
    static let muted = VectorRGB(light: 0x5F6D78, dark: 0x93A0A8, hcLight: 0x3E4D57, hcDark: 0xC8D1D6)
    static let signal = VectorRGB(light: 0x22D3EE, dark: 0x22D3EE, hcLight: 0x22D3EE, hcDark: 0x22D3EE)
    static let signalInk = VectorRGB(light: 0x071017, dark: 0x071017, hcLight: 0x000000, hcDark: 0x000000)
    static let success = VectorRGB(light: 0x177245, dark: 0x5AD58A, hcLight: 0x0F5E37, hcDark: 0x8BEBBE)
    static let warning = VectorRGB(light: 0x8A6212, dark: 0xD9A441, hcLight: 0x6B4700, hcDark: 0xF6D27F)
    static let danger = VectorRGB(light: 0x9F3039, dark: 0xF08A93, hcLight: 0x8A1F28, hcDark: 0xFFC9CE)
    static let border = VectorRGB(light: 0xD9E1E6, dark: 0x263640, hcLight: 0xAAB5BC, hcDark: 0x40515B)
    static let separator = VectorRGB(light: 0xE9EEF1, dark: 0x1B2931, hcLight: 0xD9E1E6, hcDark: 0x263640)
    static let tint = VectorRGB(light: 0x007088, dark: 0x22D3EE, hcLight: 0x00566B, hcDark: 0xA5F3FC)
    static let foregroundSecondary = VectorRGB(light: 0x3E4D57, dark: 0xC8D1D6, hcLight: 0x071017, hcDark: 0xFFFFFF)
    static let borderStrong = VectorRGB(light: 0x7A8791, dark: 0x687B86, hcLight: 0x5F6D78, hcDark: 0x8A979F)
    static let markRadius: CGFloat = 2
    static let controlRadius: CGFloat = 4
}
// TOKENS:END

// MARK: - Flags (decided in advance; flipping one is a kit version bump after a device check)

enum VectorFlags {
    /// iOS/watchOS 26 `.glassProminent` tinted #22D3EE keeps a #071017 label. Unverified → false: the capsule
    /// `VectorFillButtonStyle` is used on 26 as well. Flip only after the device check in DESIGN_SYSTEM §8.6.
    static let glassProminentLabelOK = false
    /// Use system glass for secondary buttons / interactive tiles on 26+. These are stock system styles
    /// with no custom label colour, so they ship on.
    static let systemGlassControls = true
    /// Floating capsule (watch undo banner) uses `.glassEffect` on 26+. Never used inside WidgetKit.
    static let glassFloatingCapsule = true
}

// MARK: - Colour

extension Color {
    init(vectorHex hex: UInt32, opacity: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: opacity
        )
    }

    /// Adaptive colour: light/dark + Increase Contrast on iOS (dynamic UIColor, so it follows the widget,
    /// Live Activity and app appearance without any environment plumbing). watchOS: the dark value.
    init(vector c: VectorRGB) {
        #if os(watchOS)
        self.init(vectorHex: c.dark)
        #elseif canImport(UIKit)
        self.init(uiColor: UIColor { traits in
            let high = traits.accessibilityContrast == .high
            let hex: UInt32 = traits.userInterfaceStyle == .dark
                ? (high ? c.hcDark : c.dark)
                : (high ? c.hcLight : c.light)
            return UIColor(
                red: CGFloat((hex >> 16) & 0xFF) / 255,
                green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255,
                alpha: 1
            )
        })
        #else
        self.init(vectorHex: c.light)
        #endif
    }
}

/// Brand and structure colours. Inside WidgetKit / ActivityKit views, TEXT uses `.primary` / `.secondary`
/// (never these), so hierarchy survives accented and vibrant rendering.
enum VectorColor {
    /// Brand cyan #22D3EE. A FILL only; whatever sits on it uses `signalInk`.
    static let signal = Color(vector: VectorTokens.signal)
    /// #071017 (#000000 under Increase Contrast): glyphs and labels on `signal`.
    static let signalInk = Color(vector: VectorTokens.signalInk)
    /// Text-safe cyan: #007088 light / #22D3EE dark. Links, lines, tint, Live Activity meter fill.
    static let tint = Color(vector: VectorTokens.tint)
    static let background = Color(vector: VectorTokens.background)
    static let surface = Color(vector: VectorTokens.surface)
    static let surfaceSecondary = Color(vector: VectorTokens.surfaceSecondary)
    static let surfaceTertiary = Color(vector: VectorTokens.surfaceTertiary)
    static let foreground = Color(vector: VectorTokens.foreground)
    static let foregroundSecondary = Color(vector: VectorTokens.foregroundSecondary)
    static let muted = Color(vector: VectorTokens.muted)
    static let border = Color(vector: VectorTokens.border)
    static let borderStrong = Color(vector: VectorTokens.borderStrong)
    static let separator = Color(vector: VectorTokens.separator)
    static let success = Color(vector: VectorTokens.success)
    static let warning = Color(vector: VectorTokens.warning)
    static let danger = Color(vector: VectorTokens.danger)
}

// MARK: - Metrics

enum VectorMetrics {
    static let markRadius: CGFloat = VectorTokens.markRadius   // meter tracks/fills, ticks, bars
    static let controlRadius: CGFloat = VectorTokens.controlRadius // non-interactive data tiles only
    static let hairline: CGFloat = 1
    static let minTarget: CGFloat = 44
    static let watchButtonHeight: CGFloat = 48
    static let lockScreenMargin: CGFloat = 14
}

// MARK: - Type (SF in native surfaces; Inter/Plex Mono are app-only)

enum VectorScript: Sendable {
    case cased, cjk, arabic, hebrew

    /// From the snapshot's locale identifier (the phone's in-app language), not the device language.
    static func of(_ identifier: String) -> VectorScript {
        let code = identifier.split(whereSeparator: { $0 == "-" || $0 == "_" }).first.map(String.init) ?? identifier
        switch code.lowercased() {
        case "ja", "ko", "zh": return .cjk
        case "ar", "fa", "ur": return .arabic
        case "he", "iw": return .hebrew
        default: return .cased
        }
    }
}

enum VectorFont {
    /// Measured values: SF Mono, scales with Dynamic Type. Pair with `.monospacedDigit()` (see `vectorReadout`).
    static func readout(_ style: Font.TextStyle = .title2, weight: Font.Weight = .regular) -> Font {
        Font.system(style, design: .monospaced).weight(weight)
    }

    /// Words: SF (the native stand-in for Inter).
    static func text(_ style: Font.TextStyle = .body, weight: Font.Weight = .regular) -> Font {
        Font.system(style).weight(weight)
    }

    /// Eyebrow / status word. Monospaced caption for cased scripts; plain SF medium otherwise.
    static func label(_ script: VectorScript) -> Font {
        script == .cased
            ? Font.system(.caption2, design: .monospaced).weight(.regular)
            : Font.system(.caption).weight(.medium)
    }
}

extension View {
    /// A measured number: SF Mono, fixed-width digits, one line, shrinks before truncating.
    func vectorReadout(_ style: Font.TextStyle = .title2, weight: Font.Weight = .regular) -> some View {
        font(VectorFont.readout(style, weight: weight))
            .monospacedDigit()
            .lineLimit(1)
            .minimumScaleFactor(0.6)
    }

    /// Widget / Live Activity roots: cap Dynamic Type so fixed platters never clip.
    func vectorWidgetTypeCap() -> some View {
        dynamicTypeSize(...DynamicTypeSize.xxLarge)
    }

    /// Watch pages: cap at accessibility2; pages must also scroll.
    func vectorWatchTypeCap() -> some View {
        dynamicTypeSize(...DynamicTypeSize.accessibility2)
    }
}

/// SIBYL eyebrow. The text arrives already localized from the phone. Uppercase + tracking only where the
/// script has case; CJK/Arabic/Hebrew get plain medium text with zero tracking.
struct VectorLabel: View {
    let text: String
    var script: VectorScript = .cased

    var body: some View {
        Text(verbatim: text)
            .font(VectorFont.label(script))
            .textCase(script == .cased ? .uppercase : nil)
            .tracking(script == .cased ? 0.9 : 0)
            .foregroundStyle(.secondary)
            .lineLimit(1)
    }
}

// MARK: - Semantic SF Symbols (same keys as src/vector/icons.ts)

enum VectorSymbol {
    static let add = "plus"
    static let close = "xmark"
    static let check = "checkmark"
    static let done = "checkmark.circle.fill"
    static let forward = "chevron.forward"     // auto-mirrors in RTL
    static let back = "chevron.backward"       // auto-mirrors in RTL
    static let undo = "arrow.uturn.backward"   // auto-mirrors in RTL
    static let over = "exclamationmark.circle.fill"
    static let scan = "barcode.viewfinder"
    static let timer = "timer"
    static let water = "drop"
    static let lift = "dumbbell"
    static let food = "fork.knife"
    static let weight = "scalemass"
    static let heart = "heart.fill"

    /// `apple.intelligence` where the OS has it, `sparkles` otherwise.
    static var analysis: String {
        #if canImport(UIKit)
        return UIImage(systemName: "apple.intelligence") != nil ? "apple.intelligence" : "sparkles"
        #else
        return "sparkles"
        #endif
    }
}

// MARK: - Always-On

private struct VectorHiddenWhenDimmed: ViewModifier {
    @Environment(\.isLuminanceReduced) private var dimmed
    func body(content: Content) -> some View {
        content
            .opacity(dimmed ? 0 : 1)          // keep the space: nothing jumps when the wrist drops
            .allowsHitTesting(!dimmed)
            .accessibilityHidden(dimmed)
    }
}

extension View {
    /// Controls that cannot be used in Always-On (Log, Skip rest, Undo, tiles) disappear but keep their space.
    func vectorHiddenWhenDimmed() -> some View { modifier(VectorHiddenWhenDimmed()) }
}

// MARK: - Rendering mode (widgets, Live Activities; harmless in apps where the mode is always fullColor)

/// What the current surface allows. `tinted` = accented (iOS 18 tinted, iOS 26 tinted/clear glass) or
/// vibrant (Lock Screen accessories, StandBy night): colour is discarded, only alpha survives.
struct VectorSurface {
    var tinted: Bool
    var dimmed: Bool
    var increasedContrast: Bool
}

/// Environment trio every rendering-mode-aware view reads. Declared per view (SwiftUI needs the @Environment
/// properties on the view itself).
@MainActor private protocol VectorSurfaceReading {
    var isTinted: Bool { get }
    var isDimmed: Bool { get }
    var isIncreasedContrast: Bool { get }
}

extension VectorSurfaceReading {
    var surface: VectorSurface {
        VectorSurface(tinted: isTinted, dimmed: isDimmed, increasedContrast: isIncreasedContrast)
    }
}

private struct VectorAccentable: ViewModifier {
    let on: Bool
    func body(content: Content) -> some View {
        #if canImport(WidgetKit)
        content.widgetAccentable(on)
        #else
        content
        #endif
    }
}

enum VectorPlateRole: Sendable {
    /// The one action: brand cyan with a black glyph in full colour (the app icon in miniature).
    case signal
    /// A second action: tertiary surface with a tint glyph.
    case quiet
}

private struct VectorPlateModifier: ViewModifier, VectorSurfaceReading {
    let role: VectorPlateRole
    #if canImport(WidgetKit)
    @Environment(\.widgetRenderingMode) private var mode
    var isTinted: Bool { mode != .fullColor }
    #else
    var isTinted: Bool { false }
    #endif
    @Environment(\.isLuminanceReduced) private var dimmed
    @Environment(\.colorSchemeContrast) private var contrast
    var isDimmed: Bool { dimmed }
    var isIncreasedContrast: Bool { contrast == .increased }

    func body(content: Content) -> some View {
        let s = surface
        let hc = s.increasedContrast ? 0.10 : 0
        return content
            .foregroundStyle(
                s.tinted || s.dimmed
                    ? AnyShapeStyle(Color.primary)
                    : AnyShapeStyle(role == .signal ? VectorColor.signalInk : VectorColor.tint)
            )
            // ORDER MATTERS: accentable BEFORE background, so the plate stays in the default group.
            .modifier(VectorAccentable(on: s.tinted))
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background {
                if s.dimmed {
                    ContainerRelativeShape().strokeBorder(Color.primary.opacity(0.5), lineWidth: 1)
                } else if s.tinted {
                    ContainerRelativeShape().fill(Color.primary.opacity((role == .signal ? 0.18 : 0.10) + hc))
                } else {
                    ContainerRelativeShape().fill(role == .signal ? VectorColor.signal : VectorColor.surfaceTertiary)
                }
            }
    }
}

extension View {
    /// Action plate for widgets (and Live Activity glyph plates). Replaces any opaque, non-accentable fill:
    /// fullColor = signal + #071017 glyph; accented/vibrant = primary alpha + accentable glyph; Always-On = 1pt stroke.
    func vectorPlate(_ role: VectorPlateRole = .signal) -> some View {
        modifier(VectorPlateModifier(role: role))
    }
}

/// Fill colour of a meter in full colour.
enum VectorMeterStyle: Sendable {
    /// Home Screen widget on the Vector container: signal fill inside a 1pt border-strong outline + ink tick.
    case signal
    /// Live Activity / system material: tint fill (#007088 light, #22D3EE dark), which stays ≥3:1 on glass.
    case tint
    /// Secondary meters (macros): ink fill.
    case neutral
}

/// Progress meter. Fills from the leading edge (mirrors in RTL). The value is always stated in adjacent text;
/// the meter itself is hidden from VoiceOver. Width of the fill is exactly width × clamp(fraction).
struct VectorMeter: View, VectorSurfaceReading {
    var fraction: Double
    var target: Double? = nil
    var over: Bool = false
    var style: VectorMeterStyle = .signal
    var height: CGFloat = 6

    #if canImport(WidgetKit)
    @Environment(\.widgetRenderingMode) private var mode
    var isTinted: Bool { mode != .fullColor }
    #else
    var isTinted: Bool { false }
    #endif
    @Environment(\.isLuminanceReduced) private var dimmed
    @Environment(\.colorSchemeContrast) private var contrast
    var isDimmed: Bool { dimmed }
    var isIncreasedContrast: Bool { contrast == .increased }

    var body: some View {
        let s = surface
        return GeometryReader { g in
            let w = g.size.width
            let f = min(max(fraction.isFinite ? fraction : 0, 0), 1)
            ZStack(alignment: .leading) {
                track(s).frame(width: w, height: height)
                fill(s)
                    .frame(width: w * f, height: height)
                    .modifier(VectorAccentable(on: true))
                // Index tick at the current value: the non-colour cue (signal on white is only 1.81:1).
                if style == .signal && !s.dimmed && f > 0 {
                    tick(at: w * f, in: w, colour: s.tinted ? Color.primary : VectorColor.foreground)
                }
                if let t = target, t > 0, t <= 1 {
                    tick(at: w * t, in: w, colour: s.tinted || s.dimmed ? Color.primary : VectorColor.foreground)
                }
            }
            .frame(width: w, height: height + 4)
        }
        .frame(height: height + 4)
        .accessibilityHidden(true)
    }

    @ViewBuilder private func track(_ s: VectorSurface) -> some View {
        let alpha = 0.20 + (s.increasedContrast ? 0.10 : 0)
        let shape = RoundedRectangle(cornerRadius: VectorMetrics.markRadius)
        if s.dimmed {
            shape.strokeBorder(Color.primary.opacity(0.5), lineWidth: 1)
        } else if s.tinted || style == .tint {
            // Alpha track: survives tinting and sits on system material (Live Activity).
            shape.fill(Color.primary.opacity(alpha))
        } else {
            shape.fill(VectorColor.surfaceTertiary)
                .overlay(shape.strokeBorder(style == .signal ? VectorColor.borderStrong : Color.clear, lineWidth: 1))
        }
    }

    /// Always-On: an outline segment, never a lit block.
    @ViewBuilder private func fill(_ s: VectorSurface) -> some View {
        let shape = RoundedRectangle(cornerRadius: VectorMetrics.markRadius)
        if s.dimmed {
            shape.strokeBorder(Color.primary, lineWidth: 1)
        } else {
            shape.fill(fillStyle(s))
        }
    }

    private func fillStyle(_ s: VectorSurface) -> AnyShapeStyle {
        if s.tinted { return AnyShapeStyle(Color.primary) }
        if over { return AnyShapeStyle(VectorColor.warning) }
        switch style {
        case .signal: return AnyShapeStyle(VectorColor.signal)
        case .tint: return AnyShapeStyle(VectorColor.tint)
        case .neutral: return AnyShapeStyle(VectorColor.foregroundSecondary)
        }
    }

    /// A 2pt tick, height + 4, centred on `x`, clamped inside the track.
    private func tick(at x: CGFloat, in width: CGFloat, colour: Color) -> some View {
        let lead = min(max(x - 1, 0), max(width - 2, 0))
        return HStack(spacing: 0) {
            Color.clear.frame(width: lead)
            Rectangle().fill(colour).frame(width: 2, height: height + 4)
            Spacer(minLength: 0)
        }
    }
}

#if canImport(WidgetKit)
extension View {
    /// The ONLY opaque fill in a widget. The system removes it in accented, clear, StandBy and vibrant contexts.
    @ViewBuilder func vectorWidgetBackground() -> some View {
        if #available(iOS 17.0, watchOS 10.0, *) {
            containerBackground(for: .widget) { VectorColor.surface }
        } else {
            background(VectorColor.surface)
        }
    }
}
#endif

#if os(iOS) && canImport(WidgetKit)
enum VectorWidget {
    /// Pass to `.disfavoredLocations(_:for: [.systemSmall])`. `.carPlay` exists only on iOS 26, so the array is
    /// built at runtime (WidgetConfiguration has no builder support for `if #available`).
    @available(iOS 17.0, *)
    static var disfavoredSmallLocations: [WidgetLocation] {
        var locations: [WidgetLocation] = []
        if #available(iOS 26.0, *) { locations.append(.carPlay) }
        return locations
    }
}
#endif

// MARK: - Buttons (apps + watch; never inside WidgetKit, which only takes Link / Button(intent:))

/// Capsule fill with a black label: the shipped primary everywhere (and the fallback before 26).
/// Always-On: 1pt outline, no fill. Pressed: opacity 0.7 (no scale).
struct VectorFillButtonStyle: ButtonStyle {
    var fill: Color = VectorColor.signal
    var ink: Color = VectorColor.signalInk

    func makeBody(configuration: Configuration) -> some View {
        VectorFillButtonBody(configuration: configuration, fill: fill, ink: ink)
    }
}

private struct VectorFillButtonBody: View {
    let configuration: ButtonStyleConfiguration
    let fill: Color
    let ink: Color
    @Environment(\.isLuminanceReduced) private var dimmed
    @Environment(\.isEnabled) private var enabled

    var body: some View {
        configuration.label
            .font(.headline)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .foregroundStyle(dimmed ? fill : ink)
            .frame(maxWidth: .infinity, minHeight: VectorMetrics.watchButtonHeight)
            .padding(.horizontal, 12)
            .background(Capsule().fill(dimmed ? Color.clear : fill))
            .overlay(Capsule().strokeBorder(fill, lineWidth: dimmed ? 1 : 0))
            .contentShape(Capsule())
            .opacity(configuration.isPressed ? 0.7 : (enabled ? 1 : 0.4))
    }
}

extension View {
    /// The one primary action (Start, Log, Finish). Capsule signal fill with #071017 label. On 26 it becomes
    /// `.glassProminent` only once `VectorFlags.glassProminentLabelOK` is flipped after a device check.
    @ViewBuilder func vectorPrimaryButton() -> some View {
        if #available(iOS 26.0, watchOS 26.0, *), VectorFlags.glassProminentLabelOK {
            buttonStyle(.glassProminent).tint(VectorColor.signal).foregroundStyle(VectorColor.signalInk)
        } else {
            buttonStyle(VectorFillButtonStyle())
        }
    }

    /// Secondary actions (Skip rest, Undo): system glass on 26, system bordered before.
    @ViewBuilder func vectorSecondaryButton() -> some View {
        if #available(iOS 26.0, watchOS 26.0, *), VectorFlags.systemGlassControls {
            buttonStyle(.glass)
        } else {
            buttonStyle(.bordered)
        }
    }

    /// Interactive tiles (water favourites, crown value tiles): Apple's shape, not a Vector rectangle.
    @ViewBuilder func vectorTileButton() -> some View {
        if #available(iOS 26.0, watchOS 26.0, *), VectorFlags.systemGlassControls {
            buttonStyle(.glass).buttonBorderShape(.roundedRectangle)
        } else {
            buttonStyle(.bordered).buttonBorderShape(.roundedRectangle)
        }
    }

    /// Floating capsule (watch undo banner). Never used inside WidgetKit.
    @ViewBuilder func vectorFloatingCapsule() -> some View {
        if #available(iOS 26.0, watchOS 26.0, *), VectorFlags.glassFloatingCapsule {
            glassEffect(.regular.interactive(), in: .capsule)
        } else {
            background(.ultraThinMaterial, in: Capsule())
        }
    }

    /// Double-tap / pinch on watchOS 11+ triggers this control. No-op elsewhere.
    @ViewBuilder func vectorPrimaryAction() -> some View {
        #if os(watchOS)
        if #available(watchOS 11.0, *) {
            handGestureShortcut(.primaryAction)
        } else {
            self
        }
        #else
        self
        #endif
    }
}

// MARK: - Non-interactive data tile (watch readouts). Interactive tiles use `vectorTileButton()`.

struct VectorDataTile<Content: View>: View {
    var focused: Bool = false
    @ViewBuilder var content: () -> Content

    var body: some View {
        content()
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
            .background(
                RoundedRectangle(cornerRadius: VectorMetrics.controlRadius)
                    .fill(Color.primary.opacity(0.08))
            )
            .overlay(
                RoundedRectangle(cornerRadius: VectorMetrics.controlRadius)
                    .strokeBorder(focused ? VectorColor.tint : Color.primary.opacity(0.16), lineWidth: focused ? 2 : 1)
            )
    }
}
