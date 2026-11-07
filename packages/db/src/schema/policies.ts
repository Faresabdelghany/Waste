// What a table is to the rest of the package beyond its columns, declared
// beside it in its schema module with `policies(table, { … })`: what its audit
// trigger needs, whether the reset to the seed keeps its rows, what the public
// door may read of it, and the document counters it carries.
// `src/table-policies.ts` gathers the declarations in one walk over the
// schema's exports and derives every list the package holds the database to.
//
// The audit trail. Which tables the log keeps, and the module whose `view`
// grant reads each one's history, is the domain's word (`AUDITED_TABLES`,
// @waste/domain/audit/vocabulary), which the wire and the API read too; a
// table here says only what its trigger needs. A ledger — a table that spread
// `recorded` — is its own history and is exempt without saying so, or says
// why in its own words. Every other table says one of two things: `audited`,
// with `parent` naming the column of its own that points at the row it is a
// set or a child of, so the parent's history reads the set's changes beside
// its own; or `exempt`, and why its edits are no history. The parent's table
// is the one that column's foreign key points at.
//
// `counters`: the table's document counters, each stepped once per document
// numbered (`nextNumber`, commands/shared.ts). They are no history — a nightly
// generation run steps the route counter once per route — so the table's audit
// trigger ignores them, and they are no seed's word, so the reset to the seed
// puts each back to its column default.
//
// `door`: the columns the public door's role may read (ADR-0010), and its rows
// as the predicate of the table's one policy for that role. A column left out
// is one no public answer can carry, whatever a route's code asks.
import type { PgColumn, PgTable } from "drizzle-orm/pg-core"

import { quoted } from "../names"

export type Audit = {
  /** The column of this table naming the row it is a set or a child of. */
  parent?: PgColumn
}

export type Door = { columns: readonly PgColumn[]; rows: string }

/** Counters by the key the table's columns are read and written under: the table's own field names. */
export type Counters = Readonly<Record<string, PgColumn>>

type Classified = { audited: Audit; exempt?: never } | { exempt: string; audited?: never } | { audited?: never; exempt?: never }

export type Declaration = Classified & {
  /** The reset to the seed keeps the company's rows of this table. */
  kept?: true
  door?: Door
  counters?: Counters
}

export class TablePolicies {
  constructor(
    readonly table: PgTable,
    readonly declared: Declaration,
  ) {}
}

export const policies = (table: PgTable, declaration: Declaration): TablePolicies => new TablePolicies(table, declaration)

/** A row inside the company the public request set. */
export const IN_COMPANY = `${quoted("company_id")} = (select wms.current_company_id())`

/** A row inside the company the request set, of a project that publishes itself: what every project-scoped table the door reads is bounded by. */
export const inPublishedProject = (table: string): string =>
  `${IN_COMPANY} and exists (select 1 from "wms"."project" "published" where "published"."company_id" = ${quoted(table)}.${quoted("company_id")} and "published"."id" = ${quoted(table)}.${quoted("project_id")} and "published"."public_slug" is not null)`
