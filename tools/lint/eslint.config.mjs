// ESLint flat config. Lives in tools/lint so it can use its own TypeScript 6
// (see package.json here). It lints the whole repo from the root.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import nextPlugin from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/.next-e2e/**",
      "tools/lint/**",
      "next-env.d.ts",
      "supabase/**",
    ],
  },
  { files: ["**/*.{ts,tsx,mjs,js,mts}"], ...js.configs.recommended },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,mts}"],
    languageOptions: { parserOptions: { tsconfigRootDir: root } },
  },
  {
    files: ["app/**", "components/**", "lib/**", "proxy.ts"],
    plugins: { "@next/next": nextPlugin, "react-hooks": reactHooks },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      // This rule is for the old pages/ router. In the App Router the root layout is the right place for fonts.
      "@next/next/no-page-custom-font": "off",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    files: ["e2e/**", "**/*.config.*", "vitest.config.mts"],
    languageOptions: { globals: globals.node },
  },
  {
    // The functions this file hands to the page (page.evaluate) run in the browser, so it uses both sets of globals.
    files: ["e2e/browser.mjs"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
