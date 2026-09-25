// The set of ids that travels with a company-wide record (Issue #101, slice
// 3): the container types a Vehicle Type may service, the waste fractions an
// Unloading Station accepts. Both are one sentence — a record, and the rows
// of this company it names, nothing more about each — so the mechanics are
// here once and each route module says only which table, which columns and
// which check.
//
// It is a sibling of routes/members.ts and not a fourth descriptor there, for
// the reason collection-calendars.ts spelled its own: an entry there is a row
// named by id *with a role* on a *project-scoped* child of a project-scoped
// parent, and `Entry`, `Parent`, `MemberTable` and `replaceSet` all carry the
// role and the project. An entry here is an id and nothing else, and the two
// tables are the company's — `container_type_vehicle_type` and
// `unloading_station_fraction` have no `project_id`, since a type and a
// station serve every project. Generalising members.ts over both shapes would
// make every one of its callers spell an optional role and an optional project
// for a thing that has neither. The four steps are the same, though, and kept
// the same: a page loads every parent's entries in one query and groups them,
// a body's ids are held to what their key allows in one statement, the
// replacement is delete-then-insert inside the request's one transaction
// with the record's own row stamped first (`stamp()`, routes/shared.ts), and
// the read order is by the entry's id — the contracts say a set is sorted by
// id — for a page, a single read and the answer to a write alike, so what a
// write answers is what the next read says.
//
// Every statement carries `company_id = the caller's` beside the fence
// (ADR-0001): the parent's company is what a row inherits, and there is no
// project to inherit.
//
// The plural check reads the singular's sentence. `requireEachOf` finds the
// lowest id that is not a row of the table in this company in one statement
// and hands it to the singular check of routes/references.ts at its dotted
// path, so a body naming one bad id and a body naming one among two hundred
// are told the same thing and the sentence is spelled once. The two
// statements themselves — that one, and a page's entries grouped by parent —
// are routes/sets.ts's since the #101 review, shared with members.ts.
//
// A create and a PUT answer the set they were given, `asRead`, rather than
// reading the rows they just wrote back: the body was held to what its key
// allows and the contracts already hold each id to being named once
// (`eachOnce`), so what was written is known and sorting is the whole job —
// the order is the order Postgres gives a uuid, which for the lowercase
// spelling the contracts' `Id` normalises to is the string order. `writeIds`
// is the one guard behind that: a repeated id is thrown there, since a body
// schema that lost `eachOnce` would otherwise write two rows and answer one.
import type { Tx } from "@waste/db/client"
import { and, eq, type SQL } from "drizzle-orm"
import type { PgColumn, PgTable } from "drizzle-orm/pg-core"

import { eachPresent, groupedBy } from "./sets"
import { stamp, type TenantTable } from "./shared"

/** The record a set hangs on, and the company every row of the set inherits from it. */
export type Owner = { companyId: string; id: string }

/** A child table of a company-wide record: the tenant and the two ids a row is made of, no role and no project. */
export type IdSetTable = PgTable & { companyId: PgColumn }

/** What reading and deleting a set need: the table and the two ids it is made of. */
export type IdSetColumns = {
  table: IdSetTable
  /** The column naming the record the set belongs to. */
  parentId: PgColumn
  /** The column naming what an entry points at: a container type, a waste fraction. */
  entryId: PgColumn
}

/** One family's set: the columns above, how a row of it is written, and what holds its ids to what their key allows. */
export type IdSet<Table extends IdSetTable> = IdSetColumns & {
  table: Table
  /** One entry as a row of the table; the module spells it, since only it knows what its two id columns are called. */
  rowOf: (entryId: string, owner: Owner) => Table["$inferInsert"]
  /** Holds the whole list to what its key allows, in one statement, or refuses the request at the entry that is wrong. */
  require: (tx: Tx, companyId: string, ids: readonly string[]) => Promise<void>
}

/** The singular check of routes/references.ts for a company-wide row, as the plural hands its one missing entry to it. */
type Singular = (tx: Tx, companyId: string, id: string, path: string) => Promise<void>

/**
 * The plural of a references.ts check: every id a row of `table` in this
 * company, found in one statement, and the lowest one that is not handed to
 * `singular` at `<path>.<index>`, which refuses it with the family's own
 * sentence — again until nothing is missing, since a row that arrived between
 * the two statements is a row that is there (routes/sets.ts).
 */
export function requireEachOf(table: TenantTable, path: string, singular: Singular): IdSet<IdSetTable>["require"] {
  return async (tx, companyId, ids) => {
    await eachPresent(
      tx,
      table,
      table.id,
      companyId,
      ids.map((id, index) => ({ id, path: `${path}.${index}` })),
      (entry) => singular(tx, companyId, entry.id, entry.path),
    )
  }
}

/**
 * The entries of a whole page in one query, grouped by parent and sorted by
 * the entry's id: a list of fifty records is two statements, never fifty-one.
 */
export async function idsOf(tx: Tx, set: IdSetColumns, companyId: string, parentIds: readonly string[]): Promise<Map<string, string[]>> {
  const grouped = await groupedBy(tx, set.table, set.parentId, { id: set.entryId }, [set.entryId], companyId, parentIds)
  return new Map([...grouped].map(([parent, entries]) => [parent, entries.map((entry) => entry.id)]))
}

/** A body's set as the next read answers it: in the order Postgres gives a uuid, which is the string order of its lowercase spelling. The contracts' `eachOnce` already refused a repeated id, so sorting is the whole job. */
export const asRead = (ids: readonly string[]): string[] => [...ids].sort()

/** One record's set, read the way a page reads it, so what a write answers is what the next read says. */
export async function idsFor(tx: Tx, set: IdSetColumns, companyId: string, parentId: string): Promise<string[]> {
  return (await idsOf(tx, set, companyId, [parentId])).get(parentId) ?? []
}

/** A set naming one id twice: the contracts' `eachOnce` refuses it at the boundary, and `asRead` answers the body as given, so a body that reached here with a repeat is a schema that lost the rule, not a client's doing. */
const namedTwice = (owner: Owner, id: string) => new Error(`writeIds: ${id} is named twice in the set of ${owner.id}; the contracts' eachOnce should have refused it`)

/** Writes the set a record starts with. Nothing to write is no statement; an id named twice is thrown, the one guard behind `asRead`. */
export async function writeIds<Table extends IdSetTable>(tx: Tx, set: IdSet<Table>, owner: Owner, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) throw namedTwice(owner, id)
    seen.add(id)
  }
  await tx.insert(set.table).values(ids.map((id) => set.rowOf(id, owner)))
}

/**
 * `PUT …/container-types` and `PUT …/fractions`, once.
 *
 * The record's own row is stamped first: the set is part of the record on the
 * wire, so replacing it changes the record, the update is what says so, and
 * it is also what answers "there is no such record here" — `touch` runs the
 * caller's own scope, so a record of another company comes back as nothing
 * and the route raises its own 404. Then the ids are held to what their key
 * allows and the whole set is replaced, all in the request's one transaction,
 * so a body with one bad entry leaves the record exactly as it was, stamp
 * included.
 */
export async function replaceIdSet<Table extends IdSetTable, Row extends { id: string }>(
  tx: Tx,
  set: IdSet<Table>,
  companyId: string,
  ids: readonly string[],
  touch: (stamped: { updatedAt: SQL }) => Promise<Row[]>,
): Promise<Row | undefined> {
  const [row] = await touch(stamp())
  if (row === undefined) return undefined
  const owner: Owner = { companyId, id: row.id }
  await set.require(tx, companyId, ids)
  await tx.delete(set.table).where(and(eq(set.table.companyId, companyId), eq(set.parentId, owner.id)))
  await writeIds(tx, set, owner, ids)
  return row
}
