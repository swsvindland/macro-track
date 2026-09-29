const expoConfig = require("eslint-config-expo/flat");
const vector = require("./eslint.vector.cjs");

module.exports = [
  ...expoConfig,
  ...vector,
  {
    ignores: ["dist/*", ".expo/*", "node_modules/*", "expo-env.d.ts", "uniwind-types.d.ts"],
  },
];
