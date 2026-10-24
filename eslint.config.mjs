import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["node_modules/**", ".semgrep/**"],
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    ...js.configs.recommended,
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ["src/**/*.ts", "scripts/**/*.ts", "tests/**/*.ts"],
    extends: [tseslint.configs.base],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [
            {
              from: "package",
              package: "node:test",
              name: [
                "test",
                "it",
                "describe",
                "suite",
                "subtest",
                "before",
                "after",
                "beforeEach",
                "afterEach",
              ],
            },
          ],
        },
      ],
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/only-throw-error": "error",
      // WHY: Forwarding an already-caught rejection (typed unknown) must not rewrap it, which would change error identity.
      "@typescript-eslint/prefer-promise-reject-errors": [
        "error",
        { allowThrowingUnknown: true },
      ],
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      // WHY: mirrors Qlty's function-parameters threshold (5) so `npm run lint`
      // catches a 6-parameter function before Qlty does. max: 5 (not 4) keeps
      // the third-party ToolDefinition.execute 5-argument callback signature legal.
      "@typescript-eslint/max-params": ["error", { max: 5 }],
      "no-empty": ["error", { allowEmptyCatch: false }],
      "@typescript-eslint/no-empty-function": "error",
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-console": ["error", { allow: ["error"] }],
    },
  },
  {
    files: ["tests/**/*.ts"],
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-empty-function": "off",
      // WHY: max-params mirrors Qlty for shipped code; test helpers may bundle
      // fixture arguments more loosely (see tests/fuzz.test.ts).
      "@typescript-eslint/max-params": "off",
    },
  },
);
