// How Drizzle spells identifiers: camelCase keys in TypeScript, snake_case
// names in Postgres. One constant for the places that must agree: drizzle-kit
// (drizzle.config.ts), the client (client.ts), code that spells a database
// name itself (schema/geometry.ts names a check after its column) and the
// specimen tests that render DDL the way drizzle-kit would.
export const CASING = "snake_case" as const
