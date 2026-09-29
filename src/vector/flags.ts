/**
 * Decided-in-advance defaults for behaviour that cannot be verified without a device. Flipping one is a kit
 * minor bump made in the canonical copy after the device check listed in docs/design-system.md §12.
 */
export const defaultFlags = {
  /**
   * NativeTabs.BottomAccessory hosts the Dock on iOS 26. false → docked strip above the tab bar everywhere.
   * NOT WIRED in 1.0.0 (Later): the accessory is a child of the app-owned <NativeTabs>, so flipping this changes
   * nothing until a kit minor adds the accessory slot and Screen stops drawing the strip.
   */
  bottomAccessoryDock: false,
  /** Stack headers become transparent glass (headerTransparent) on iOS 26. false → unpainted, non-transparent. */
  transparentHeaders: false,
  /** Tab roots let the ScrollView run under the status bar on iOS 26. false → SafeAreaView edges={['top']}. */
  scrollUnderStatusBar: false,
  /** Uniwind.updateCSSVariables swaps the Increase Contrast set at runtime. false → base tokens (all pass AA). */
  runtimeContrastSwap: false,
  /** iOS UISwitch thumb in signal ink when on. false → system thumb (the track is still signal). Android: always ink. */
  switchInkThumb: false,
  /** Explicit CJK system families on iOS (Hiragino Sans / PingFang SC / Apple SD Gothic Neo). false → system
   *  fallback. Read by Text and the Choices / chip labels (text.tsx sansFamily). */
  cjkSystemFamilies: false,
  /** A DetailScreen action marked `prominent` becomes a 'prominent' native item (light-mode tint fill) on iOS 26.
   *  false → plain tinted header items. Read by DetailScreen. */
  prominentHeaderItems: false,
} as const;

export type VectorFlags = { -readonly [K in keyof typeof defaultFlags]: boolean };
