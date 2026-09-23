// What a table's migration file has to say beyond what drizzle-kit generated
// for it, and whether it says it. migrations/README.md lays out the rule: the
// hand-written statements of a table go into the file that created it, below
// drizzle-kit's, each after a `--> statement-breakpoint` line, spelled exactly
// as the helpers spell them. The gate in __tests__/hand-written.test.ts holds
// every table of the schema to it, and this module is what the gate reads.
//
// Two of the statements follow from the columns alone, so they are derived and
// compared verbatim: the tenant fence (every table) and the updated_at trigger
// (a table with `updated_at`). The exclusion constraint depends on a business
// key the columns do not declare, so for an effective-dated table the gate
// checks that a constraint of the right shape is there, and names the helper
// that writes it.
import { getTableName } from "drizzle-orm"
import type { PgTable } from "drizzle-orm/pg-core"

import { columnNamed, qualifiedTable, quoted, tableObjectName } from "../names"
import { NO_OVERLAP } from "./exclude-overlapping"
import { tenantFence } from "./tenant-fence"
import { touchUpdatedAt } from "./touch-updated-at"

const HELPER = "handWrittenStatements"

/** The statements every migration that creates this table must carry, derived from its columns. */
export function handWrittenStatements(table: PgTable): string[] {
  const statements = [...tenantFence(table)]
  if (columnNamed(table, "updated_at")) statements.push(...touchUpdatedAt(table))
  return statements
}

/** How the table's exclusion constraint begins and ends, whatever its key; undefined for a table without validity. */
export function overlapConstraintShape(table: PgTable): { prefix: string; suffix: string } | undefined {
  if (!columnNamed(table, "valid_from")) return undefined
  const target = qualifiedTable(table, HELPER)
  return {
    prefix: `ALTER TABLE ${target} ADD CONSTRAINT ${quoted(tableObjectName(table, NO_OVERLAP, HELPER))} EXCLUDE USING gist (${quoted("company_id")} WITH =`,
    suffix: `daterange(${quoted("valid_from")}, ${quoted("valid_to")}, '[)') WITH &&);`,
  }
}

/** The statement drizzle-kit writes to create the table, as far as its name. */
export const createTableStatement = (table: PgTable): string => `CREATE TABLE ${qualifiedTable(table, HELPER)} (`

/**
 * What this migration text lacks for the table: each derived statement that is
 * not in it verbatim, and, for an effective-dated table without an exclusion
 * constraint of the right shape, the helper call that writes one. Empty when
 * the file is complete.
 */
export function missingHandWritten(table: PgTable, migration: string): string[] {
  const missing = handWrittenStatements(table).filter((statement) => !migration.includes(statement))
  const shape = overlapConstraintShape(table)
  if (shape) {
    const present = migration
      .split("\n")
      .some((line) => line.trimStart().startsWith(shape.prefix) && line.trimEnd().endsWith(shape.suffix))
    if (!present) {
      missing.push(`-- excludeOverlapping(${getTableName(table)}, [...its business key]) writes the exclusion constraint: ${shape.prefix}, ... ${shape.suffix}`)
    }
  }
  return missing
}
