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
// A page loads every parent's entries in one query and groups them by parent,
// the way users.ts loads Project Access, ordered by the row an entry names
// and then its role. That order is the same for a page, for a single read and
// for the answer to a write, so what a write answers is what the next read
// says.
//
// Every statement carries `company_id = the caller's` beside the fence
// (ADR-0001: the API is the authority, RLS the backstop), and the parent's
// project is what a row inherits: these tables are project-scoped too, and
// their key to the parent carries `project_id`, so a set can never reach out
// of the project its record is in.
//
// What is not here is what only a route knows: which column is the parent's
// and which the entry's, what a row of the table is called, and the sentence
// a bad entry earns. Those come in as one descriptor per family.
import type { Tx } from "@waste/db/client"
import { property } from "@waste/db/schema/customers"
import { and, asc, eq, inArray } from "drizzle-orm"
import type { PgColumn, PgTable } from "drizzle-orm/pg-core"

import { requireRow } from "./shared"

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

/** One family's set: the columns above, how a row of it is written, and what a bad entry is told. */
export type MemberSet<Table extends MemberTable> = SetColumns & {
  table: Table
  /** One entry as a row of the table; the module spells it, since only it knows what its two id columns are called. */
  rowOf: (entry: Entry, parent: Parent) => Table["$inferInsert"]
  /** Holds the id entry number `index` names to what its key allows, or refuses the request; the path and the sentence are the module's. */
  require: (tx: Tx, parent: Parent, entry: Entry, index: number) => Promise<void>
}

/**
 * A member of a Group or of a Point is a Property of that record's own
 * project: the composite key says so, and this says it before the insert, as
 * a 400 naming the entry that is wrong rather than a 23503 a client cannot
 * read. One rule, so one spelling, though two modules make the check.
 */
export async function requireMemberProperty(tx: Tx, parent: Parent, entry: Entry, index: number): Promise<void> {
  await requireRow(
    tx,
    property,
    { companyId: parent.companyId, id: entry.id, also: eq(property.projectId, parent.projectId) },
    { path: `members.${index}.propertyId`, message: "Not a property of this project" },
  )
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

/** Holds every entry to what its key allows, in the order the body gave them, so the refusal names the entry the caller has to fix. */
export async function requireEntries<Table extends MemberTable>(
  tx: Tx,
  set: MemberSet<Table>,
  parent: Parent,
  entries: readonly Entry[],
): Promise<void> {
  for (const [index, entry] of entries.entries()) await set.require(tx, parent, entry, index)
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

/** Replaces the whole set: what the record had goes, what the body holds arrives, both in the request's one transaction. */
export async function replaceEntries<Table extends MemberTable>(
  tx: Tx,
  set: MemberSet<Table>,
  parent: Parent,
  entries: readonly Entry[],
): Promise<void> {
  await tx.delete(set.table).where(and(eq(set.table.companyId, parent.companyId), eq(set.parentId, parent.id)))
  await writeEntries(tx, set, parent, entries)
}
