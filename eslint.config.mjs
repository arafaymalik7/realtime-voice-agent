// Flat ESLint config (ESLint 9+). Type-aware linting for the TS sources.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "public/js/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": "off",
    },
  },
  {
    // Browser worklet: plain JS with AudioWorklet globals.
    files: ["public/worklet/*.js"],
    languageOptions: {
      globals: {
        sampleRate: "readonly",
        registerProcessor: "readonly",
        AudioWorkletProcessor: "readonly",
      },
    },
  }
);
