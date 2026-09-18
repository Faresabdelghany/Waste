// One connection pool, two faces: `db` is Drizzle over it for typed queries and
// transactions, `sql` is the postgres.js instance underneath for the statements
// Drizzle has no builder for (role and setting management, specimen tables in
// tests). Which role the pool logs in as is the URL's business: the API gets
// `wms_api`, migrations and bootstrap get the owner (see .env.example at the
// repository root).
//
// The two faces share one set of codecs, Drizzle's: Drizzle rewires the
// instance it is given so that dates, timestamps, intervals and JSON travel
// as Postgres text and it does the mapping itself. Through the raw face,
// therefore, `now()` arrives as a string and a Date parameter is not
// accepted; send temporal values as ISO strings there. Pinned by a test.
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js"
import postgres, { type Sql } from "postgres"

import { CASING } from "./casing"
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
  /**
   * A `search_path` for every connection of the pool, sent as a startup
   * parameter: it outranks the role's and the database's settings
   * (`pg_settings.source = client`), and Supabase's poolers forward it in
   * session mode. Unset, the connecting role's own setting applies.
   */
  searchPath?: string
}

export function createDb(url: string, { max = 10, onnotice = () => {}, searchPath }: ClientOptions = {}): Database {
  // prepare: false keeps the API's client valid behind Supabase's transaction
  // pooler, where named prepared statements are not supported. Migrations are
  // a different matter (see migrate.ts).
  const sql = postgres(url, {
    max,
    prepare: false,
    onnotice,
    ...(searchPath === undefined ? {} : { connection: { search_path: searchPath } }),
  })
  const db = drizzle({ client: sql, schema, casing: CASING })
  let closing: Promise<void> | undefined
  return {
    db,
    sql,
    close: () => (closing ??= sql.end({ timeout: 5 })),
  }
}
