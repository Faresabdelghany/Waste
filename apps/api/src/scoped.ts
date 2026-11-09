// A family's rows as a route reaches them (#574): one declaration per table
// gives the fence every statement carries, the 404 for a row outside it, the
// read of one row, the read of one row under its lock, and a page of a list.
//
// The reach is the tenant and, for a project-scoped family, the projects the
// caller works in (auth/projects.ts): a row outside either is the family's 404,
// in the one sentence every family has used — "No depot <id> in the projects
// this account works in", or "… in this company" for a company-wide one. A
// family whose reach is something else — the fleet an office's projects or a
// Service Provider's own admit (`reachesFleet`) — names its fence in place of
// the projects' and keeps their sentence.
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
import { inProjects } from "./auth/projects"
import { fetchLimit, pageOf, type PageAt, type Paged } from "./pagination"
import { problem, type ProblemError } from "./problem"

/** What a family declaration gives its routes. */
export type Scoped<Columns extends SelectedFields> = {
  /** What every statement of the family is bounded by. */
  scope: (principal: Principal) => SQL | undefined
  /** The 404 for a row outside the reach. */
  noSuch: (id: string) => ProblemError
  /** One row by id, inside the reach; undefined when it is not there. */
  find: (tx: Tx, principal: Principal, id: string) => Promise<SelectResultFields<Columns> | undefined>
  /** One row by id, or the family's 404. */
  get: (tx: Tx, principal: Principal, id: string) => Promise<SelectResultFields<Columns>>
  /** One row by id under its lock, taken before the read since a rule the API holds over the row is held per transaction (`@waste/db/commands/shared`); or the family's 404. */
  locked: (tx: Tx, principal: Principal, id: string, strength?: LockStrength) => Promise<SelectResultFields<Columns>>
  /** One page of the family's rows inside the reach and the filters given, in id order from the cursor on. */
  list: (tx: Tx, principal: Principal, at: PageAt, ...filters: (SQL | undefined)[]) => Promise<Paged<SelectResultFields<Columns>>>
}

/** A fence of the family's own beside the tenant, in place of the project fence: a fleet a Service Provider runs, say. */
export type Fence = (principal: Principal) => SQL | undefined

type Options<Columns extends SelectedFields> = {
  /** The family's name in its 404: "No <noun> <id> in the projects this account works in". */
  noun: string
  /** What a row is read as. */
  columns: Columns
  /** A condition every row of the family meets beside its reach: a message the office reads names a customer. */
  also?: SQL
  /** A page's order: oldest first unless the family reads newest first. */
  order?: "asc" | "desc"
}

type ProjectTable = TenantTable & { projectId: PgColumn }

/** The rows of one family as a route reaches them: a project's, inside the projects the caller works in (a table without a project is refused at compile time), */
export function scoped<Columns extends SelectedFields & { id: PgColumn }>(table: ProjectTable, options: Options<Columns> & { reach: "projects" }): Scoped<Columns>
/** … the company's, … */
export function scoped<Columns extends SelectedFields & { id: PgColumn }>(table: TenantTable, options: Options<Columns> & { reach: "company" }): Scoped<Columns>
/** … or the company's inside a fence of the family's own. */
export function scoped<Columns extends SelectedFields & { id: PgColumn }>(table: TenantTable, options: Options<Columns> & { reach: Fence }): Scoped<Columns>
export function scoped<Columns extends SelectedFields & { id: PgColumn }>(table: TenantTable & { projectId?: PgColumn }, { noun, reach, columns, also, order = "asc" }: Options<Columns> & { reach: "projects" | "company" | Fence }): Scoped<Columns> {
  type Row = SelectResultFields<Columns>
  const fence = (principal: Principal): SQL | undefined => {
    const tenant = eq(table.companyId, principal.companyId)
    if (reach === "company") return and(tenant, also)
    if (reach === "projects") return and(tenant, inProjects(table.projectId as PgColumn, principal), also)
    return and(tenant, reach(principal), also)
  }
  const place = reach === "company" ? "in this company" : "in the projects this account works in"
  const read = (tx: Tx) => tx.select(columns as SelectedFields).from(table as PgTable)

  /** One row by id, inside the reach; undefined when it is not there. */
  async function find(tx: Tx, principal: Principal, id: string): Promise<Row | undefined> {
    const [row] = await read(tx)
      .where(and(fence(principal), eq(table.id, id)))
      .limit(1)
    return row as Row | undefined
  }

  /** The 404 for a row outside the reach. */
  const noSuch = (id: string) => problem(404, { detail: `No ${noun} ${id} ${place}` })

  return {
    /** What every statement of the family is bounded by. */
    scope: fence,
    noSuch,
    find,
    /** One row by id, or the family's 404. */
    async get(tx: Tx, principal: Principal, id: string): Promise<Row> {
      const row = await find(tx, principal, id)
      if (row === undefined) throw noSuch(id)
      return row
    },
    /** One row by id under its lock, taken before the read since a rule the API holds over the row is held per transaction (`@waste/db/commands/shared`); or the family's 404. */
    async locked(tx: Tx, principal: Principal, id: string, strength?: LockStrength): Promise<Row> {
      await lockRow(tx, table, { companyId: principal.companyId, id }, strength)
      const row = await find(tx, principal, id)
      if (row === undefined) throw noSuch(id)
      return row
    },
    /** One page of the family's rows inside the reach and the filters given, in id order from the cursor on. */
    async list(tx: Tx, principal: Principal, { after, limit }: PageAt, ...filters: (SQL | undefined)[]): Promise<Paged<Row>> {
      const from = after === undefined ? undefined : order === "asc" ? gt(table.id, after) : lt(table.id, after)
      const rows = await read(tx)
        .where(and(fence(principal), ...filters, from))
        .orderBy(order === "asc" ? asc(table.id) : desc(table.id))
        .limit(fetchLimit(limit))
      return pageOf(rows as (Row & { id: string })[], limit)
    },
  }
}
