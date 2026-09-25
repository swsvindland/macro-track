const fs = require("fs");
const path = require("path");
const {
  IOSConfig,
  withAppDelegate,
  withInfoPlist,
  withXcodeProject,
} = require("expo/config-plugins");

// iOS 27 terminates apps at launch unless they adopt the UIScene life cycle. Expo SDK 58's
// template adopts it; SDK 57 ships the runtime (`ExpoAppSceneDelegate`, expo >= 57.0.25) but
// still generates an app-delegate-owned window. Port the SDK 58 template changes here.
// Remove this plugin after upgrading to SDK 58, whose template already does all of this.
const SCENE_DELEGATE = `internal import Expo

@objc(SceneDelegate)
class SceneDelegate: ExpoAppSceneDelegate {
  // Extension point for config plugins.
}
`;

const LEGACY_WINDOW =
  /\n#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\n\s*factory\.startReactNative\([^)]*\)\n#endif\n/;

function withSceneAppDelegate(config) {
  return withAppDelegate(config, (config) => {
    const appDelegate = config.modResults;
    if (appDelegate.language !== "swift")
      throw new Error("Scene life cycle requires the Expo Swift AppDelegate.");
    if (appDelegate.contents.includes("ExpoReactNativeFactoryProvider")) return config;
    const contents = appDelegate.contents
      .replace(
        "class AppDelegate: ExpoAppDelegate {",
        "class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {"
      )
      .replace(
        LEGACY_WINDOW,
        "\n    // SceneDelegate creates the window and starts React Native.\n"
      );
    if (!contents.includes("ExpoReactNativeFactoryProvider") || LEGACY_WINDOW.test(contents))
      throw new Error("Scene life cycle could not adapt the generated AppDelegate.");
    appDelegate.contents = contents;
    return config;
  });
}

function withSceneDelegateFile(config) {
  return withXcodeProject(config, (config) => {
    const { projectName, platformProjectRoot } = config.modRequest;
    const filepath = `${projectName}/SceneDelegate.swift`;
    fs.writeFileSync(path.join(platformProjectRoot, filepath), SCENE_DELEGATE);
    if (!config.modResults.hasFile(filepath)) {
      IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
        filepath,
        groupName: projectName,
        project: config.modResults,
      });
    }
    return config;
  });
}

function withSceneManifest(config) {
  return withInfoPlist(config, (config) => {
    config.modResults.UIApplicationSceneManifest ??= {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: "Default Configuration",
            UISceneDelegateClassName: "$(PRODUCT_MODULE_NAME).SceneDelegate",
          },
        ],
      },
    };
    return config;
  });
}

module.exports = function withSceneLifecycle(config) {
  return withSceneManifest(withSceneDelegateFile(withSceneAppDelegate(config)));
};
