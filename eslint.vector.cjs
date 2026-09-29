// Vector Kit ESLint fragment (flat config). CommonJS because every repo's eslint.config.js uses require():
//   module.exports = [...expoConfig, ...require("./eslint.vector.cjs"), { ignores: [...] }];
// Kit files (src/vector/**) are exempt: the kit's own strings live in src/vector/strings.ts. Files still listed in
// vector.allow.json#eslintFiles are exempt until Phase 1 edits them; `vector-kit check --baseline` sets
// VECTOR_KIT_BASELINE=1 so every app file is linted while it writes that list.
const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");

// ESLint runs from the repo root (pnpm lint, editors), so the allow file is resolved from there.
function exemptFiles() {
  if (process.env.VECTOR_KIT_BASELINE === "1") return [];
  const file = path.join(process.cwd(), "vector.allow.json");
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(readFileSync(file, "utf8")).eslintFiles ?? [];
  } catch {
    return [];
  }
}

const exempt = exemptFiles();
const files = ["src/**/*.{js,jsx,ts,tsx}"];
const labelProps =
  "label|title|placeholder|accessibilityLabel|accessibilityHint|message|description|confirmLabel|loadingLabel";

module.exports = [
  {
    files,
    ignores: ["src/vector/**", ...exempt],
    rules: {
      // Every visible string comes from t(); only drawn separators may appear as JSX text.
      "react/jsx-no-literals": [
        "error",
        { noStrings: true, allowedStrings: ["·", "/", "–"], ignoreProps: true },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: `JSXAttribute[name.name=/^(${labelProps})$/] > Literal`,
          message:
            "[vector] Visible strings come from t(): this label prop is an untranslated literal.",
        },
      ],
    },
  },
  {
    files,
    // The two migration shims may still type-reference RN Text while call sites move to @/vector.
    ignores: ["src/vector/**", "src/components/system.tsx", "src/components/ui.tsx", ...exempt],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "react-native",
              importNames: ["Text", "TextInput"],
              message:
                "[vector] Use Text or Field from @/vector: they apply the script, Dynamic Type and Bold Text rules.",
            },
          ],
        },
      ],
    },
  },
];
