// drizzle-kit's view of the package: where the schema is, where migrations go,
// and how the journal is named. Only `generate` runs through drizzle-kit;
// applying migrations goes through src/migrate.ts (the same journal), so tests,
// CI and the hosted project share one code path. `push` is never used: it
// diffs against the live database and would fight the hand-written statements
// (extensions, functions, role, and later the exclusion constraints and
// policies Drizzle has no builder for).
import { defineConfig } from "drizzle-kit"

// The repository root's .env, when present. drizzle-kit is its own process, so
// Node's --env-file flag on the package scripts does not reach it.
try {
  process.loadEnvFile("../../.env")
} catch {
  // No .env: the environment itself has to carry DATABASE_ADMIN_URL.
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  // Postgres identifiers are snake_case; TypeScript stays camelCase.
  casing: "snake_case",
  // Only the domain schema is ours to diff. The journal's schema and the
  // extensions' own tables (PostGIS keeps a few) are not.
  schemaFilter: ["wms"],
  extensionsFilters: ["postgis"],
  // The defaults, stated: src/migrate.ts names the same journal.
  migrations: { schema: "drizzle", table: "__drizzle_migrations" },
  dbCredentials: {
    url: process.env.DATABASE_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  },
  strict: true,
  verbose: true,
})
