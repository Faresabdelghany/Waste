// drizzle-kit's view of the package, for `drizzle-kit generate` and nothing
// else: where the schema is, where the SQL files and the journal go, and how
// identifiers are cased. Applying migrations does not go through drizzle-kit
// (src/migrate.ts does it, and names the journal table), so no connection is
// configured here, and `push` is never used: it diffs against the live
// database and would fight the hand-written statements (extensions,
// functions, role, and later the exclusion constraints and policies Drizzle
// has no builder for).
import { defineConfig } from "drizzle-kit"

import { CASING } from "./src/casing"

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  // Postgres identifiers are snake_case; TypeScript stays camelCase.
  casing: CASING,
})
