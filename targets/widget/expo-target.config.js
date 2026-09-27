/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: "widget",
  name: "MacrosWidget",
  displayName: "Macros",
  deploymentTarget: "17.0",
  frameworks: ["SwiftUI", "WidgetKit"],
  // Mirrors src/global.css: light values first, then dark.
  colors: {
    $accent: { light: "#007088", dark: "#22d3ee" },
    $widgetBackground: { light: "#ffffff", dark: "#0d171e" },
    calories: { light: "#007088", dark: "#67e8f9" },
    track: { light: "#e8eef2", dark: "#182a35" },
    danger: { light: "#9f3039", dark: "#f2a6ad" },
  },
  entitlements: {
    "com.apple.security.application-groups":
      config.ios.entitlements["com.apple.security.application-groups"],
  },
});
