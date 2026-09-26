const { AndroidConfig, withStringsXml } = require("expo/config-plugins");

// "Vector Macros" is cut off under a launcher icon, so Android shows a shorter label.
// iOS does the same through ios.infoPlist.CFBundleDisplayName.
module.exports = function withLauncherName(config, { name }) {
  if (!name?.trim()) throw new Error("with-launcher-name needs a name such as Macros.");
  return withStringsXml(config, (config) => {
    config.modResults = AndroidConfig.Strings.setStringItem(
      [AndroidConfig.Resources.buildResourceItem({ name: "app_name", value: name })],
      config.modResults
    );
    return config;
  });
};
