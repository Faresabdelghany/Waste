// What a table's migration file has to say beyond what drizzle-kit generated
// for it, and whether it says it. migrations/README.md lays out the rule: the
// hand-written statements of a table go into the file that created it, below
// drizzle-kit's, each after a `--> statement-breakpoint` line, spelled as the
// helpers spell them. The gate in __tests__/hand-written.test.ts holds every
// table of the schema to it, and this module is what the gate reads.
//
// Three of the statements follow from the columns alone, so they are derived
// and compared statement for statement: the tenant fence (every table), the
// updated_at trigger (a table with `updated_at`) and, for a ledger — a table
// with `recorded_at`, the mark of the `recorded` column set (Issue #101) —
// the REVOKE of UPDATE and DELETE from the API role in the trigger's place.
// The exclusion constraints depend on a business key the columns do not
// declare, so for an effective-dated table the gate checks that a constraint
// of the right shape is there, the shape taken from the helper itself, and
// names the helper that writes it; a reservation table — one carrying the
// `_window` check — is held to at least one constraint of the window helper's
// shape the same way, the range read from that helper, its name and its
// predicate the table's own.
//
// A file is read the way the migrator reads it: split at the breakpoints into
// statements, wherever the marker stands (drizzle-kit writes it at the end of
// an ALTER TABLE or CREATE INDEX line, a hand-written file on a line of its
// own), comments dropped, whitespace collapsed. A statement commented out is
// not there; a statement wrapped over several lines is.
import { getTableName } from "drizzle-orm"
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core"

import { columnNamed, qualifiedTable, tableObjectName } from "../names"
import { WINDOW_CHECK } from "../schema/columns"
import { appendOnly } from "./append-only"
import { excludeOverlapping, NO_OVERLAP } from "./exclude-overlapping"
import { WINDOW_RANGE } from "./exclude-overlapping-window"
import { tenantFence } from "./tenant-fence"
import { touchUpdatedAt } from "./touch-updated-at"

const HELPER = "handWrittenStatements"
/** drizzle-orm's migrator splits on this text wherever it stands, and so does this. */
const BREAKPOINT = "--> statement-breakpoint"
/** Where the constraint's key ends and its period begins, in the helper's spelling. */
const PERIOD_STARTS = ", daterange("
/** The range the window helper writes, closing the gist list: a window constraint carries it whatever its key and predicate. */
const WINDOW_INFIX = `${WINDOW_RANGE})`

/** One spelling for comparison: whitespace runs collapsed, ends trimmed. */
export const normalised = (statement: string): string => statement.replace(/\s+/g, " ").trim()

/** The statements of a migration file as the migrator runs them, normalised, comments dropped, empty pieces gone. */
export function statementsOf(migration: string): string[] {
  return migration
    .split(BREAKPOINT)
    .map((piece) =>
      normalised(
        piece
          .split("\n")
          .filter((line) => !line.trimStart().startsWith("--"))
          .map((line) => line.replace(/\s--.*$/, ""))
          .join("\n"),
      ),
    )
    .filter((statement) => statement.length > 0)
}

/** Whether the table is a ledger: it spread `recorded`, so it carries `recorded_at`, and nothing may update a row. */
export const isLedger = (table: PgTable): boolean => columnNamed(table, "recorded_at") !== undefined

/** The statements every migration that creates this table must carry, derived from its columns: the fence, then the trigger or, for a ledger, the revoke. */
export function handWrittenStatements(table: PgTable): string[] {
  return [...tenantFence(table), ...(isLedger(table) ? appendOnly(table) : touchUpdatedAt(table))]
}

/** How the table's exclusion constraint begins and ends, whatever its key, in the helper's own spelling; undefined for a table without validity. */
export function overlapConstraintShape(table: PgTable): { prefix: string; suffix: string } | undefined {
  if (!columnNamed(table, "valid_from")) return undefined
  const [statement] = excludeOverlapping(table, [])
  const at = statement.indexOf(PERIOD_STARTS)
  return { prefix: statement.slice(0, at), suffix: statement.slice(at + PERIOD_STARTS.length - "daterange(".length) }
}

/** Whether the table is a reservation: it carries the `_window` check, so its window is a rule and not a snapshot. */
export const isReservation = (table: PgTable): boolean => {
  if (!columnNamed(table, "planned_from")) return false
  const checkName = tableObjectName(table, WINDOW_CHECK, HELPER)
  return getTableConfig(table).checks.some((check) => check.name === checkName)
}

/**
 * How a window exclusion constraint of this table begins and what it carries,
 * whatever its key and predicate: `ALTER TABLE ... ADD CONSTRAINT "<table>_`
 * and the range over the window; undefined for a table that is not a
 * reservation.
 */
export function windowConstraintShape(table: PgTable): { prefix: string; infix: string } | undefined {
  if (!isReservation(table)) return undefined
  return { prefix: `ALTER TABLE ${qualifiedTable(table, HELPER)} ADD CONSTRAINT "${getTableName(table)}_`, infix: WINDOW_INFIX }
}

/** The statement drizzle-kit writes to create the table, as far as its name. */
export const createTableStatement = (table: PgTable): string => `CREATE TABLE ${qualifiedTable(table, HELPER)} (`

/** Whether this migration creates the table (a CREATE TABLE that is not commented out). */
export const createsTable = (table: PgTable, migration: string): boolean =>
  statementsOf(migration).some((statement) => statement.startsWith(createTableStatement(table)))

/**
 * What this migration text lacks for the table: each derived statement that is
 * not among its statements, and, for an effective-dated table without an
 * exclusion constraint of the right shape or a reservation table without one
 * over its window, the helper call that writes one. Empty when the file is
 * complete.
 */
export function missingHandWritten(table: PgTable, migration: string): string[] {
  const present = new Set(statementsOf(migration))
  const missing = handWrittenStatements(table).filter((statement) => !present.has(normalised(statement)))
  const shape = overlapConstraintShape(table)
  if (shape) {
    const prefix = normalised(shape.prefix)
    const suffix = normalised(shape.suffix)
    if (![...present].some((statement) => statement.startsWith(prefix) && statement.endsWith(suffix))) {
      missing.push(`-- excludeOverlapping(${getTableName(table)}, [...its business key]) writes the exclusion constraint: ${shape.prefix}, ... ${shape.suffix}`)
    }
  }
  const windowShape = windowConstraintShape(table)
  if (windowShape) {
    const prefix = normalised(windowShape.prefix)
    const infix = normalised(windowShape.infix)
    if (![...present].some((statement) => statement.startsWith(prefix) && statement.includes(infix) && statement.includes(`_${NO_OVERLAP}"`))) {
      missing.push(`-- excludeOverlappingWindow(${getTableName(table)}, [...its key], { live? }) writes the exclusion constraint: ${windowShape.prefix}..._${NO_OVERLAP}" EXCLUDE USING gist ("company_id" WITH =, ..., ${windowShape.infix}`)
    }
  }
  return missing
}
