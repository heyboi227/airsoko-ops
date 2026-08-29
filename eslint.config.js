import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/node_modules/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "apps/api/drizzle/**",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },

  // The domain kernel is the load-bearing piece of this architecture: every
  // operational rule lives there and it must stay pure so it can be tested
  // without a database, a server, or a browser. This is that promise made
  // mechanical -- if the kernel ever reaches for I/O, lint fails.
  {
    files: ["packages/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@airsoko/api",
                "@airsoko/web",
                "drizzle-orm*",
                "pg",
                "express",
                "react",
                "react-dom",
                "@mui/*",
                "node:fs",
                "node:http",
                "node:https",
                "node:net",
              ],
              message:
                "The domain kernel must stay pure. No I/O, no framework, no persistence -- move this to apps/api or apps/web.",
            },
          ],
        },
      ],
      // Parsing an instant is fine; reading the wall clock is not. Kernel rules
      // must be deterministic, so the evaluation instant arrives as an argument.
      "no-restricted-syntax": [
        "error",
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message:
            "Kernel rules must be deterministic: take the evaluation instant as an argument instead of reading the clock.",
        },
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message:
            "Kernel rules must be deterministic: take the evaluation instant as an argument instead of reading the clock.",
        },
      ],
    },
  },

  {
    files: ["packages/contracts/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["drizzle-orm*", "pg", "express", "react", "react-dom", "@mui/*"],
              message:
                "Contracts are the shared wire format. They must be importable from both the API and the browser.",
            },
          ],
        },
      ],
    },
  },

  {
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },

  {
    // Includes the build scripts under apps/api/scripts, which are plain .js
    files: ["apps/api/**/*.{ts,js}", "e2e/**/*.ts", "*.config.{ts,js}", "**/*.config.{ts,js}"],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      "no-console": "off",
    },
  },
);
