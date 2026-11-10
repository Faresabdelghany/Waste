// A family's rows as a route reaches them (#574): one declaration per family
// — a table, read one way — gives the fence every statement carries, the 404
// for a row outside it, the read of one row, the read of one row under its
// lock, and a page of a list.
//
// The reach is the tenant and, for a project-scoped family, the projects the
// caller works in (auth/projects.ts): a row outside either is the family's 404,
// in the one sentence every family has used — "No depot <id> in the projects
// this account works in", or "… in this company" for a company-wide one. A
// family whose reach is something else — the fleet an office's projects or a
// Service Provider's own admit (`reachesFleet`) — names its fence in place of
// the projects' and keeps their sentence. One whose reads reach other rows
// than its commands — a Service Provider's account reads the rows it is
// assigned and commands none of them, or reads only its team's roles — names
// its read fence (`reads`) beside the commands', and the place its 404 says
// where that is not the projects ("this account reaches"); its commands read
// through `commanded` and `locked`. One whose row is read with a join names
// its read (`read`) instead of its columns.
//
// A page is the list rule of pagination.ts applied once: the rows after the
// cursor in `id` order, one more than the page asked for to see whether there
// is another. The cursor is decoded where the route reads its query
// (`pageAt`), so a cursor this API did not write is refused at the point each
// route judged it.
import type { Tx } from "@waste/db/client"
import { lockRow, type LockStrength, type TenantTable } from "@waste/db/commands/shared"
import { and, asc, desc, eq, gt, lt, type SQL } from "drizzle-orm"
import type { PgColumn, PgTable, SelectedFields } from "drizzle-orm/pg-core"
import type { SelectResultFields } from "drizzle-orm/query-builders/select.types"

import type { Principal } from "./auth/principal"
import { IN_PROJECTS, inProjects } from "./auth/projects"
import { fetchLimit, pageOf, type PageAt, type Paged } from "./pagination"
import { noSuchRow, type ProblemError } from "./problem"

/** What a family declaration gives its routes. */
export type Scoped<Row> = {
  /** What every command of the family is bounded by. */
  scope: (principal: Principal) => SQL | undefined
  /** The 404 for a row outside the reach. */
  noSuch: (id: string) => ProblemError
  /** One row by id, inside what the caller reads; undefined when it is not there. */
  find: (tx: Tx, principal: Principal, id: string) => Promise<Row | undefined>
  /** One row by id, or the family's 404. */
  get: (tx: Tx, principal: Principal, id: string) => Promise<Row>
  /** One row by id inside what the caller commands, which is `find` unless the family reads other rows than it commands: a command's read where its lock is held already or it takes none; undefined when it is not there. */
  commanded: (tx: Tx, principal: Principal, id: string) => Promise<Row | undefined>
  /** One row by id under its lock, taken before the read since a rule the API holds over the row is held per transaction (`@waste/db/commands/shared`), inside what the caller commands; or the family's 404. */
  locked: (tx: Tx, principal: Principal, id: string, strength?: LockStrength) => Promise<Row>
  /** One page of what the caller reads inside the filters given, in id order from the cursor on. */
  list: (tx: Tx, principal: Principal, at: PageAt, ...filters: (SQL | undefined)[]) => Promise<Paged<Row>>
}

/** A fence of the family's own beside the tenant, in place of the project fence: a fleet a Service Provider runs, say. */
export type Fence = (principal: Principal) => SQL | undefined

/** A select over the family's table, its joins made (bounded by the caller's company where a join needs it): what the family's row is read with where its columns alone do not say it. */
export type Read<Row> = (tx: Tx, principal: Principal) => {
  where(where: SQL | undefined): { limit(count: number): PromiseLike<Row[]>; orderBy(...order: SQL[]): { limit(count: number): PromiseLike<Row[]> } }
}

type Options = {
  /** The family's name in its 404: "No <noun> <id> in the projects this account works in". */
  noun: string
  /** A condition every row of the family meets beside its reach: a message the office reads names a customer. */
  also?: SQL
  /** A page's order: oldest first unless the family reads newest first. */
  order?: "asc" | "desc"
  /** What the caller reads where it is not what it commands: more for a provider's account, which reads the rows it is assigned and commands none of them, or less, as a provider's account reads only its team's roles. */
  reads?: (tx: Tx, principal: Principal) => SQL | undefined
  /** Where the 404 says the row is not, where the reach is the family's own: "this account reaches". */
  place?: string
}

/** The row: its columns, read off the table, or a read of the family's own; either way it carries its id, which a page's cursor is. */
type Source<Columns extends SelectedFields, Row> = { columns: Columns & { id: PgColumn }; read?: undefined } | { read: Read<Row & { id: string }>; columns?: undefined }

type ProjectTable = TenantTable & { projectId: PgColumn }

/** The rows of one family as a route reaches them: a project's, inside the projects the caller works in (a table without a project is refused at compile time), */
export function scoped<Columns extends SelectedFields, Row = SelectResultFields<Columns>>(table: ProjectTable, options: Options & Source<Columns, Row> & { reach: "projects" }): Scoped<Row>
/** … the company's, … */
export function scoped<Columns extends SelectedFields, Row = SelectResultFields<Columns>>(table: TenantTable, options: Options & Source<Columns, Row> & { reach: "company" }): Scoped<Row>
/** … or the company's inside a fence of the family's own. */
export function scoped<Columns extends SelectedFields, Row = SelectResultFields<Columns>>(table: TenantTable, options: Options & Source<Columns, Row> & { reach: Fence }): Scoped<Row>
export function scoped<Columns extends SelectedFields, Row = SelectResultFields<Columns>>(
  table: TenantTable & { projectId?: PgColumn },
  { noun, reach, columns, read: readOwn, also, order = "asc", reads, place: placed }: Options & Source<Columns, Row> & { reach: "projects" | "company" | Fence },
): Scoped<Row> {
  const fence = (principal: Principal): SQL | undefined => {
    const tenant = eq(table.companyId, principal.companyId)
    if (reach === "company") return and(tenant, also)
    if (reach === "projects") return and(tenant, inProjects(table.projectId as PgColumn, principal), also)
    return and(tenant, reach(principal), also)
  }
  const readable = (tx: Tx, principal: Principal): SQL | undefined => (reads === undefined ? fence(principal) : reads(tx, principal))
  const place = placed ?? (reach === "company" ? "in this company" : IN_PROJECTS)
  const read: Read<Row> = readOwn ?? ((tx: Tx) => tx.select(columns as SelectedFields).from(table as PgTable) as unknown as ReturnType<Read<Row>>)

  async function within(tx: Tx, principal: Principal, where: SQL | undefined, id: string): Promise<Row | undefined> {
    const [row] = await read(tx, principal)
      .where(and(where, eq(table.id, id)))
      .limit(1)
    return row
  }

  const noSuch = (id: string) => noSuchRow(noun, id, place)

  return {
    scope: fence,
    noSuch,
    find: (tx, principal, id) => within(tx, principal, readable(tx, principal), id),
    async get(tx, principal, id) {
      const row = await within(tx, principal, readable(tx, principal), id)
      if (row === undefined) throw noSuch(id)
      return row
    },
    commanded: (tx, principal, id) => within(tx, principal, fence(principal), id),
    async locked(tx, principal, id, strength) {
      await lockRow(tx, table, { companyId: principal.companyId, id }, strength)
      const row = await within(tx, principal, fence(principal), id)
      if (row === undefined) throw noSuch(id)
      return row
    },
    async list(tx, principal, { after, limit }, ...filters) {
      const from = after === undefined ? undefined : order === "asc" ? gt(table.id, after) : lt(table.id, after)
      const rows = await read(tx, principal)
        .where(and(readable(tx, principal), ...filters, from))
        .orderBy(order === "asc" ? asc(table.id) : desc(table.id))
        .limit(fetchLimit(limit))
      return pageOf(rows as (Row & { id: string })[], limit)
    },
  }
}
