// The publication check of the `check` operation (Issue #152): the `powersync`
// publication (migration 0008) holds exactly the tables the sync rules read,
// `SYNCED_TABLES` in src/sql/publication.ts, the one spelling. The
// fingerprint says the same once a database is at the head; this says it on
// its own, so `check` reads the publication even while migrations are pending
// and the committed fingerprint does not apply yet.
import type { Sql } from "postgres"

import { wms } from "../schema/wms"
import { PUBLICATION } from "../sql/publication"

/** The publication's `wms` tables by name, or null where the database has no such publication. */
export async function readPublicationTables(sql: Sql): Promise<string[] | null> {
  const [publication] = await sql<{ tables: string }[]>`
    select coalesce((select json_agg(c.relname order by c.relname)
                     from pg_publication_rel pr join pg_class c on c.oid = pr.prrelid join pg_namespace n on n.oid = c.relnamespace
                     where pr.prpubid = p.oid and n.nspname = ${wms.schemaName}), '[]')::text as tables
    from pg_publication p where p.pubname = ${PUBLICATION}`
  return publication === undefined ? null : (JSON.parse(publication.tables) as string[])
}

/** Every way the publication differs from the tables the sync rules read, one sentence each. */
export function publicationProblems(tables: readonly string[] | null, expected: readonly string[]): string[] {
  if (tables === null) return [`the ${PUBLICATION} publication does not exist: migration 0008 creates it`]
  return [
    ...expected.filter((table) => !tables.includes(table)).map((table) => `the ${PUBLICATION} publication lacks ${wms.schemaName}.${table}`),
    ...tables.filter((table) => !expected.includes(table)).map((table) => `the ${PUBLICATION} publication holds ${wms.schemaName}.${table}, which the sync rules do not read`),
  ]
}
