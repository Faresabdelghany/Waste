// What a table's migration file has to say beyond what drizzle-kit generated
// for it, and whether it says it. migrations/README.md lays out the rule: the
// hand-written statements of a table go into the file that created it, below
// drizzle-kit's, each after a `--> statement-breakpoint` line, spelled as the
// helpers spell them. The gate in __tests__/hand-written.test.ts holds every
// table of the schema to it, and this module is what the gate reads.
//
// Two of the statements follow from the columns alone, so they are derived and
// compared statement for statement: the tenant fence (every table) and the
// updated_at trigger (a table with `updated_at`). The exclusion constraint
// depends on a business key the columns do not declare, so for an
// effective-dated table the gate checks that a constraint of the right shape
// is there, the shape taken from the helper itself, and names the helper that
// writes it.
//
// A file is read the way the migrator reads it: split at the breakpoints into
// statements, wherever the marker stands (drizzle-kit writes it at the end of
// an ALTER TABLE or CREATE INDEX line, a hand-written file on a line of its
// own), comments dropped, whitespace collapsed. A statement commented out is
// not there; a statement wrapped over several lines is.
import { getTableName } from "drizzle-orm"
import type { PgTable } from "drizzle-orm/pg-core"

import { columnNamed, qualifiedTable } from "../names"
import { excludeOverlapping } from "./exclude-overlapping"
import { tenantFence } from "./tenant-fence"
import { touchUpdatedAt } from "./touch-updated-at"

const HELPER = "handWrittenStatements"
/** drizzle-orm's migrator splits on this text wherever it stands, and so does this. */
const BREAKPOINT = "--> statement-breakpoint"
/** Where the constraint's key ends and its period begins, in the helper's spelling. */
const PERIOD_STARTS = ", daterange("

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

/** The statements every migration that creates this table must carry, derived from its columns. */
export function handWrittenStatements(table: PgTable): string[] {
  const statements = [...tenantFence(table)]
  if (columnNamed(table, "updated_at")) statements.push(...touchUpdatedAt(table))
  return statements
}

/** How the table's exclusion constraint begins and ends, whatever its key, in the helper's own spelling; undefined for a table without validity. */
export function overlapConstraintShape(table: PgTable): { prefix: string; suffix: string } | undefined {
  if (!columnNamed(table, "valid_from")) return undefined
  const [statement] = excludeOverlapping(table, [])
  const at = statement.indexOf(PERIOD_STARTS)
  return { prefix: statement.slice(0, at), suffix: statement.slice(at + PERIOD_STARTS.length - "daterange(".length) }
}

/** The statement drizzle-kit writes to create the table, as far as its name. */
export const createTableStatement = (table: PgTable): string => `CREATE TABLE ${qualifiedTable(table, HELPER)} (`

/** Whether this migration creates the table (a CREATE TABLE that is not commented out). */
export const createsTable = (table: PgTable, migration: string): boolean =>
  statementsOf(migration).some((statement) => statement.startsWith(createTableStatement(table)))

/**
 * What this migration text lacks for the table: each derived statement that is
 * not among its statements, and, for an effective-dated table without an
 * exclusion constraint of the right shape, the helper call that writes one.
 * Empty when the file is complete.
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
  return missing
}
