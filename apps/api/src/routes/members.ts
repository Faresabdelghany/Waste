// The sets that travel with a Registry record (Issue #78): a Property's
// parties, a Property Group's members, a Shared Collection Point's members.
// All three are the same sentence said three times — a record, the rows it
// names, and what each one is to it — so the mechanics are here once and each
// route module says only which table, which columns, and which sentence.
//
// A set is read with its record and replaced whole (`PUT …/parties`,
// `PUT …/members`): the client already holds the list it rendered, and "add
// one, remove one" over that list is two requests that can disagree. The
// replacement is delete-then-insert inside the request's one transaction and
// never a diff, because a diff is three statements and a tie-break rule where
// this is two and none: the rows carry nothing a delete would lose — no id a
// client was given, no stamp anyone reads.
//
// Nothing here is per entry. A page loads every parent's entries in one query
// and groups them by parent, the way users.ts loads Project Access, and a
// body's entries are held to what their key allows in one query too: a set
// body may carry two hundred, and two hundred round trips inside the request's
// transaction, behind the lock the record's own stamp has just taken, is not a
// check but a queue. A page and a body each cost one statement and the
// refusal is the same — the lowest entry that is wrong, by the path the body
// spelled it at.
//
// The read order is the row an entry names and then its role, and it is the
// same for a page, for a single read and for the answer to a write, so what a
// write answers is what the next read says.
//
// Every statement carries `company_id = the caller's` beside the fence
// (ADR-0001: the API is the authority, RLS the backstop), and the parent's
// project is what a row inherits: these tables are project-scoped too, and
// their key to the parent carries `project_id`, so a set can never reach out
// of the project its record is in.
//
// Two checks live here beside the mechanics, because each is one rule a whole
// set has to pass at once: every party of a Property is a Customer of this
// company, and every member of a Group or a Point is a Property of that
// record's project. The sentence each refuses with is routes/references.ts's,
// where the singular of the same check lives, so a body naming one bad id and
// a body naming one among two hundred are told the same thing. What stays
// with a route is what only it knows: which column is the parent's and which
// the entry's, and what a row of its table is called. Those come in as one
// descriptor per family.
import type { Tx } from "@waste/db/client"
import { customer, property } from "@waste/db/schema/customers"
import { and, asc, eq, inArray, type SQL } from "drizzle-orm"
import type { PgColumn, PgTable } from "drizzle-orm/pg-core"

import { invalidRequest } from "../problem"
import { NOT_A_CUSTOMER, NOT_A_PROPERTY } from "./references"
import { stamp } from "./shared"

/**
 * One entry, as the mechanics see it: the row it names and what it is to the
 * record. The wire spells that id `customerId` or `propertyId` and the route
 * module translates, so this can be written once for all three.
 */
export type Entry = { id: string; role: string }

/** The record a set hangs on, and the scope every row of the set inherits from it. */
export type Parent = { companyId: string; projectId: string; id: string }

/** A child table of a project-scoped record: the tenant, the project and a role on every row. */
export type MemberTable = PgTable & { companyId: PgColumn; projectId: PgColumn; role: PgColumn }

/** What reading and deleting a set need: the table and the two ids it is made of. */
export type SetColumns = {
  table: MemberTable
  /** The column naming the record the set belongs to. */
  parentId: PgColumn
  /** The column naming what an entry points at: a Customer, or a Property. */
  entryId: PgColumn
}

/** One family's set: the columns above, how a row of it is written, and what holds its entries to what their key allows. */
export type MemberSet<Table extends MemberTable> = SetColumns & {
  table: Table
  /** One entry as a row of the table; the module spells it, since only it knows what its two id columns are called. */
  rowOf: (entry: Entry, parent: Parent) => Table["$inferInsert"]
  /** Holds the whole list to what its key allows, in one statement, or refuses the request at the entry that is wrong. */
  require: (tx: Tx, parent: Parent, entries: readonly Entry[]) => Promise<void>
}

/** Every entry's id, each once: what the one lookup asks for, however often the body named it. */
const namedIds = (entries: readonly Entry[]): string[] => [...new Set(entries.map((entry) => entry.id))]

/**
 * The lowest entry whose id did not come back. A caller fixes one field at a
 * time and the list is ordered, so the first wrong entry is the one to name;
 * the path is the body's own spelling of it.
 */
function refuseMissing(entries: readonly Entry[], found: ReadonlySet<string>, path: (index: number) => string, message: string): void {
  const index = entries.findIndex((entry) => !found.has(entry.id))
  if (index === -1) return
  throw invalidRequest("body", [{ path: path(index), message }])
}

/** A Property's parties: every entry names a Customer of this company, checked in one statement. */
export async function requirePartyCustomers(tx: Tx, parent: Parent, entries: readonly Entry[]): Promise<void> {
  const ids = namedIds(entries)
  if (ids.length === 0) return
  const rows = await tx
    .select({ id: customer.id })
    .from(customer)
    .where(and(eq(customer.companyId, parent.companyId), inArray(customer.id, ids)))
  refuseMissing(entries, new Set(rows.map((row) => row.id)), (index) => `parties.${index}.customerId`, NOT_A_CUSTOMER)
}

/**
 * A Group's or a Point's members: every entry names a Property of that
 * record's own project, checked in one statement. The composite key says the
 * same thing and would answer 23503, which is a 500 saying nothing, where
 * this is a 400 naming the entry to fix.
 */
export async function requireMemberProperties(tx: Tx, parent: Parent, entries: readonly Entry[]): Promise<void> {
  const ids = namedIds(entries)
  if (ids.length === 0) return
  const rows = await tx
    .select({ id: property.id })
    .from(property)
    .where(and(eq(property.companyId, parent.companyId), eq(property.projectId, parent.projectId), inArray(property.id, ids)))
  refuseMissing(entries, new Set(rows.map((row) => row.id)), (index) => `members.${index}.propertyId`, NOT_A_PROPERTY)
}

/**
 * The entries of a whole page in one query, grouped by parent: a list of
 * fifty records is two statements, never fifty-one.
 */
export async function entriesOf(tx: Tx, set: SetColumns, companyId: string, parentIds: readonly string[]): Promise<Map<string, Entry[]>> {
  const byParent = new Map<string, Entry[]>()
  if (parentIds.length === 0) return byParent
  const rows = await tx
    .select({ parent: set.parentId, id: set.entryId, role: set.table.role })
    .from(set.table)
    .where(and(eq(set.table.companyId, companyId), inArray(set.parentId, [...parentIds])))
    .orderBy(asc(set.entryId), asc(set.table.role))
  // A bare `PgColumn` carries `data: unknown`, so the selection reads as
  // unknown however plainly these three are `uuid` and `text`; a narrower
  // column type in the descriptor is one no family's columns would still fit.
  for (const row of rows as { parent: string; id: string; role: string }[]) {
    const entry: Entry = { id: row.id, role: row.role }
    const found = byParent.get(row.parent)
    if (found === undefined) byParent.set(row.parent, [entry])
    else found.push(entry)
  }
  return byParent
}

/** One record's set, read the way a page reads it, so what a write answers is what the next read says. */
export async function entriesFor(tx: Tx, set: SetColumns, companyId: string, parentId: string): Promise<Entry[]> {
  return (await entriesOf(tx, set, companyId, [parentId])).get(parentId) ?? []
}

/** Writes the set a record starts with. Nothing to write is no statement. */
export async function writeEntries<Table extends MemberTable>(
  tx: Tx,
  set: MemberSet<Table>,
  parent: Parent,
  entries: readonly Entry[],
): Promise<void> {
  if (entries.length === 0) return
  await tx.insert(set.table).values(entries.map((entry) => set.rowOf(entry, parent)))
}

/**
 * `PUT …/parties` and `PUT …/members`, once.
 *
 * The record's own row is stamped first. The set is part of the record on the
 * wire, so replacing the set changes the record; the update is what says so,
 * and it is also what answers "there is no such record here" — `touch` runs
 * the caller's own scope, so a record of another company or of a project the
 * account does not work in comes back as nothing and the route raises its own
 * 404. The trigger would stamp `updated_at` whatever the set said; naming it
 * is naming what changed.
 *
 * Then the entries are held to what their key allows and the whole set is
 * replaced, all in the request's one transaction — so a body with one bad
 * entry leaves the record exactly as it was, stamp included.
 */
export async function replaceSet<Table extends MemberTable, Row extends { id: string; projectId: string }>(
  tx: Tx,
  set: MemberSet<Table>,
  companyId: string,
  entries: readonly Entry[],
  touch: (stamped: { updatedAt: SQL }) => Promise<Row[]>,
): Promise<Row | undefined> {
  const [row] = await touch(stamp())
  if (row === undefined) return undefined
  const parent: Parent = { companyId, projectId: row.projectId, id: row.id }
  await set.require(tx, parent, entries)
  await tx.delete(set.table).where(and(eq(set.table.companyId, companyId), eq(set.parentId, parent.id)))
  await writeEntries(tx, set, parent, entries)
  return row
}
