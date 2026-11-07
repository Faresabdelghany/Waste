// A period inside a period (ADR-0005), from the parent's side. A child placed
// outside its parent's period is the writer's to refuse at the bound it
// chose (apps/api's routes/periods.ts); a parent whose period moves under its
// children is refused here, counting the rows in the way, since they are not
// in the body and the caller has to end them first (`refuseStranded`).
//
// A parent with dated children declares them once (`DatedChild`): the table,
// the column naming the parent, what each is called when a move would leave
// rows outside, and its own children. A parent's shortening then counts every
// declared child (`refuseStrandedChildren`), and a parent ended on a day — a
// termination, a change of service, a move — refuses every declared child
// that begins on or after the day and ends those in force past it there, the
// children's children first (`endChildrenOn`), so nothing it holds outlives
// it and nothing is missed because a door forgot to name it.
//
// A count that refuses a write carries `company_id` and the parent's id and
// never a caller's project fence: the parent was read under the caller's
// scope and a child's project is the parent's by the composite key, so the
// count must not be the one statement that could miss a row. The rule is held
// per transaction, under the parent's row lock, which every writer of a child
// takes before it reads the parent.
import type { Period } from "@waste/domain/periods"
import { Refused } from "@waste/domain/refusal"
import { and, asc, count as countRows, eq, gt, gte, inArray, isNull, or, sql, type SQL } from "drizzle-orm"
import type { PgColumn, PgTable } from "drizzle-orm/pg-core"

import type { Tx } from "../client"
import type { ValidityColumns } from "../schema/columns"
import { lockRows } from "./shared"

/**
 * The `where` fragment matching the rows whose period leaves `parent`'s: a
 * row with no end leaves a parent that has one, which is why the null is
 * named rather than left to a comparison that would answer null.
 */
export function notWithin(columns: ValidityColumns, parent: Period): SQL {
  const leaves = [sql`${columns.validFrom} < ${parent.validFrom}`]
  if (parent.validTo !== null) {
    leaves.push(sql`${columns.validTo} is null`, sql`${columns.validTo} > ${parent.validTo}`)
  }
  return sql`(${sql.join(leaves, sql` or `)})`
}

/**
 * Counts the rows of `table` that `where` picks — the children a parent's
 * move would strand — and refuses the move with the count where there are
 * any. `where` is the caller's: which table, which parent, and what "outside"
 * means for its rows (`notWithin` for a child with a period of its own, the
 * day against the bounds for a child that is a day).
 */
export async function refuseStranded(tx: Tx, table: PgTable, where: SQL | undefined, sentence: (rows: number) => string): Promise<void> {
  const [row] = await tx.select({ rows: countRows() }).from(table).where(where)
  const strays = row?.rows ?? 0
  if (strays > 0) throw Refused.conflict(sentence(strays))
}

/** A dated child of a parent record, declared once: what its parent's moves judge and end. */
export type DatedChild = {
  table: PgTable & ValidityColumns & { id: PgColumn; companyId: PgColumn }
  /** The column naming the parent. */
  parent: PgColumn
  /** What a parent's new period that would leave rows outside is refused with. */
  stranded: (rows: number) => string
  /** What a parent ended on a day is refused with where rows begin on or after it. */
  beginsLater: (rows: number) => string
  /** Its own dated children, ended before it. */
  children: readonly DatedChild[]
}

/** The rows of `child` whose parent is one of `parentIds`. */
const ofParents = (child: DatedChild, companyId: string, parentIds: readonly string[]): SQL | undefined => and(eq(child.table.companyId, companyId), inArray(child.parent, [...parentIds]))

/** A row in force past `on`: open, or ending after it. */
const runsPast = (columns: ValidityColumns, on: string): SQL | undefined => or(isNull(columns.validTo), gt(columns.validTo, on))

async function idsOf(tx: Tx, child: DatedChild, where: SQL | undefined): Promise<string[]> {
  const rows = await tx.select({ id: child.table.id }).from(child.table).where(where).orderBy(asc(child.table.id))
  return rows.map((row) => row.id as string)
}

/** A parent's new period: each declared child whose rows it would leave outside is refused, in the order the parent declares them. */
export async function refuseStrandedChildren(tx: Tx, children: readonly DatedChild[], parent: { companyId: string; id: string }, period: Period): Promise<void> {
  for (const child of children) await refuseStranded(tx, child.table, and(ofParents(child, parent.companyId, [parent.id]), notWithin(child.table, period)), child.stranded)
}

/** The parents ending on `on`: each declared child, and each of its children, with rows beginning on or after the day is refused — ending on it would strand them. */
async function refuseBeginningOn(tx: Tx, children: readonly DatedChild[], companyId: string, parentIds: readonly string[], on: string): Promise<void> {
  for (const child of children) {
    const ofThem = ofParents(child, companyId, parentIds)
    await refuseStranded(tx, child.table, and(ofThem, gte(child.table.validFrom, on)), child.beginsLater)
    if (child.children.length === 0) continue
    const ids = await idsOf(tx, child, ofThem)
    if (ids.length > 0) await refuseBeginningOn(tx, child.children, companyId, ids, on)
  }
}

/** Ends these rows of `child` on `on`: a child that is a parent itself locked in id order, its own children ended first, so it strands none. */
async function endRowsOn(tx: Tx, child: DatedChild, companyId: string, ids: readonly string[], on: string): Promise<void> {
  if (ids.length === 0) return
  if (child.children.length > 0) {
    await lockRows(tx, child.table, companyId, ids)
    for (const grandchild of child.children) await endRowsOn(tx, grandchild, companyId, await idsOf(tx, grandchild, and(ofParents(grandchild, companyId, ids), runsPast(grandchild.table, on))), on)
  }
  await tx
    .update(child.table)
    .set({ validTo: on })
    .where(and(eq(child.table.companyId, companyId), inArray(child.table.id, [...ids])))
}

/**
 * Ends what the parents hold on `on`, the parents themselves left to their
 * caller: refuses first every declared child beginning on or after the day,
 * then ends every one in force past it, each child's own children first.
 */
export async function endChildrenOn(tx: Tx, children: readonly DatedChild[], companyId: string, parentIds: readonly string[], on: string): Promise<void> {
  await refuseBeginningOn(tx, children, companyId, parentIds, on)
  for (const child of children) await endRowsOn(tx, child, companyId, await idsOf(tx, child, and(ofParents(child, companyId, parentIds), runsPast(child.table, on))), on)
}

/**
 * Ends these rows of a declared child on `on`, with what they hold: refuses
 * first their own children beginning on or after the day, then ends those in
 * force past it and the rows themselves.
 */
export async function endOn(tx: Tx, child: DatedChild, companyId: string, ids: readonly string[], on: string): Promise<void> {
  await refuseBeginningOn(tx, child.children, companyId, ids, on)
  await endRowsOn(tx, child, companyId, ids, on)
}

/** Whether the parent still holds a declared child in force past `on`: something of it runs on. */
export async function holdsPast(tx: Tx, children: readonly DatedChild[], parent: { companyId: string; id: string }, on: string): Promise<boolean> {
  for (const child of children) {
    const [held] = await tx
      .select({ id: child.table.id })
      .from(child.table)
      .where(and(ofParents(child, parent.companyId, [parent.id]), runsPast(child.table, on)))
      .limit(1)
    if (held !== undefined) return true
  }
  return false
}
