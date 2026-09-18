// One connection pool, two faces: `db` is Drizzle over it for typed queries and
// transactions, `sql` is postgres.js itself for the statements Drizzle has no
// builder for (role and setting management, specimen tables in tests). Which
// role the pool logs in as is the URL's business: the API gets `wms_api`,
// migrations and bootstrap get the owner (see src/__tests__/database.ts and
// .env.example at the repository root).
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js"
import postgres, { type Sql } from "postgres"

import * as schema from "./schema"

export type Db = PostgresJsDatabase<typeof schema>

export type Database = {
  db: Db
  sql: Sql
  /** Ends the pool. Idempotent: a second call joins the first. */
  close(): Promise<void>
}

export type ClientOptions = {
  /** Pool size. */
  max?: number
  /** Where Postgres NOTICE messages go; dropped by default so `CREATE ... IF NOT EXISTS` stays quiet. */
  onnotice?: (notice: postgres.Notice) => void
}

export function createDb(url: string, { max = 10, onnotice = () => {} }: ClientOptions = {}): Database {
  // prepare: false makes the same client valid behind Supabase's transaction
  // pooler too, where named prepared statements are not supported.
  const sql = postgres(url, { max, prepare: false, onnotice })
  const db = drizzle({ client: sql, schema, casing: "snake_case" })
  let closing: Promise<void> | undefined
  return {
    db,
    sql,
    close: () => (closing ??= sql.end({ timeout: 5 })),
  }
}
