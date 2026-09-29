const tokens = require("../../src/vector/tokens.json");

/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: "widget",
  name: "MacrosWidget",
  displayName: "Macros",
  deploymentTarget: "17.0",
  frameworks: ["SwiftUI", "WidgetKit"],
  // Every other colour comes from targets/_shared/VectorTheme.swift, generated from the same tokens.
  colors: {
    $accent: tokens.native.accent,
    $widgetBackground: tokens.native.widgetBackground,
  },
  entitlements: {
    "com.apple.security.application-groups":
      config.ios.entitlements["com.apple.security.application-groups"],
  },
});
