// One ESLint configuration for the whole workspace. Each package runs
// `eslint .` from its own directory through turbo; patterns below are relative
// to this file, so they still match from inside apps/web or packages/*.
//
// Policy: errors fail CI, warnings do not. Any rule switched off or downgraded
// here says why. Tighten, do not silence.
import { defineConfig, globalIgnores } from "eslint/config"
import nextCoreWebVitals from "eslint-config-next/core-web-vitals"
import nextTypescript from "eslint-config-next/typescript"
import tseslint from "typescript-eslint"

export default defineConfig([
  globalIgnores([
    "**/.next/**",
    "**/dist/**",
    "**/.turbo/**",
    "**/playwright-report/**",
    "**/test-results/**",
    "apps/web/next-env.d.ts",
  ]),

  // The Next.js app: Next's own core-web-vitals and TypeScript rule sets.
  {
    files: ["apps/web/**/*.{js,jsx,mjs,ts,tsx}"],
    extends: [nextCoreWebVitals, nextTypescript],
    rules: {
      // Measured 2026-09-17 (#47): 38 occurrences across the client-side
      // stores and dialogs. Real smell, but fixing them means reworking how
      // the prototype stores hydrate from localStorage. Warn until then; raise
      // back to "error" when the stores move to the server-backed adapter
      // (build-order step 5).
      "react-hooks/set-state-in-effect": "warn",
      // False positive here: `module` is a domain word (a workspace Module
      // record), not the CommonJS binding this rule protects.
      "@next/next/no-assign-module-variable": "off",
      // This repository does not enable the React Compiler, so whether the
      // compiler could preserve a manual useMemo is not a defect in our code.
      "react-hooks/preserve-manual-memoization": "off",
    },
  },

  // ADR-0001: the web app never talks to the database. @waste/db and the
  // packages beneath it are server-only; the Hono API is the web's one way in,
  // so a database client or a connection string can never reach the browser
  // bundle by accident.
  {
    files: ["apps/web/**/*.{js,jsx,mjs,ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@waste/db", "@waste/db/*", "drizzle-orm", "drizzle-orm/*", "postgres", "postgres/*"],
              message: "The web app never talks to the database (ADR-0001): go through the API in apps/api.",
            },
          ],
        },
      ],
    },
  },

  // Playwright suites: `use` is Playwright's fixture function, not React's hook.
  {
    files: ["apps/web/e2e/**/*.ts", "apps/web/playwright.config.ts", "apps/web/e2e-api/**/*.ts", "apps/web/playwright.api.config.ts"],
    rules: {
      "react-hooks/rules-of-hooks": "off",
    },
  },

  // Shared packages (domain, contracts, api, worker, ...): stricter than the app.
  // Package lint scripts should run `eslint . --max-warnings 0`.
  {
    files: ["packages/**/*.ts", "apps/api/**/*.ts", "apps/worker/**/*.ts"],
    extends: [tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
])
