const { withProjectBuildGradle } = require("expo/config-plugins");

// expo-build-properties' android.kotlinVersion only reaches Expo's version catalog. The root
// build script's Kotlin Gradle plugin has no version, so it resolves to React Native's own
// (2.1.20), whose compiler cannot read ML Kit GenAI's Kotlin 2.3 metadata. Pin it to the
// configured version so the compiler and the catalog agree.
module.exports = function withKotlinPluginVersion(config, { version }) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? ""))
    throw new Error("with-kotlin-plugin-version needs a Kotlin version such as 2.2.21.");
  return withProjectBuildGradle(config, (config) => {
    const unpinned = "classpath('org.jetbrains.kotlin:kotlin-gradle-plugin')";
    const pinned = /classpath\('org\.jetbrains\.kotlin:kotlin-gradle-plugin:[^']+'\)/;
    const line = `classpath('org.jetbrains.kotlin:kotlin-gradle-plugin:${version}')`;
    const gradle = config.modResults;
    if (gradle.contents.includes(unpinned))
      gradle.contents = gradle.contents.replace(unpinned, line);
    else if (pinned.test(gradle.contents)) gradle.contents = gradle.contents.replace(pinned, line);
    else throw new Error("Could not find the Kotlin Gradle plugin in android/build.gradle.");
    return config;
  });
};
