const { withMainActivity } = require("expo/config-plugins");

// Health Connect launches MainActivity through two platform-specific privacy intents.
// Convert both to an Expo Router deep link, including when the app is already open.
module.exports = function withHealthRationale(config) {
  return withMainActivity(config, (config) => {
    const activity = config.modResults;
    if (activity.language !== "kt")
      throw new Error("Health rationale requires the Expo Kotlin activity.");
    if (activity.contents.includes("bodyTrackHealthIntent")) return config;
    activity.contents = activity.contents.replace(
      "super.onCreate(null)",
      "bodyTrackHealthIntent(intent)\n    super.onCreate(null)"
    );
    const methods = `
  private fun bodyTrackHealthIntent(incoming: android.content.Intent?) {
    if (incoming?.action == "androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE" ||
        incoming?.action == "android.intent.action.VIEW_PERMISSION_USAGE") {
      incoming.action = android.content.Intent.ACTION_VIEW
      incoming.data = android.net.Uri.parse("bodytrack://health-privacy")
    }
  }

  override fun onNewIntent(intent: android.content.Intent) {
    bodyTrackHealthIntent(intent)
    super.onNewIntent(intent)
    setIntent(intent)
  }
`;
    activity.contents = activity.contents.replace(/}\s*$/, `${methods}\n}\n`);
    return config;
  });
};
