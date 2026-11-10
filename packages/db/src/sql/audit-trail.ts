// The audit trail (#291, slice 9): one trigger per audited table, in the
// migration that creates the table, calling the trigger function migration
// 0019 created (`wms.audit_row()`, which writes `audit_event`; schema/audit.ts
// says what a row of the log is). Which tables are audited, under which
// module, as a set of which parent, is each table's own declaration
// (schema/policies.ts), gathered as `AUDITED` and `EXEMPT` in
// table-policies.ts; __tests__/audit-trail.test.ts holds the schema and the
// migrated database to them, and what the function writes.
//
// The function itself is 0019's own text. That file's comment names it here as
// `AUDIT_ROW_FUNCTION`, the constant it was copied from, which went once 0019
// merged (migrations/README.md: a merged file is its hash's). What holds it now:
// the fingerprint (its definition's digest), audit-trail.test.ts's fresh
// database (what a row of the log holds), and the same file's check that the
// function reads the actor and the reason under the setting names `actAs`
// writes (`ACTOR_SETTING`, `REASON_SETTING`, src/tenant.ts).
import { getTableName } from "drizzle-orm"

import { columnName, qualifiedTable, quoted, tableObjectName } from "../names"
import { literal } from "../schema/checks"
import { AUDITED, type Audited } from "../table-policies"

const HELPER = "auditTrail"
/** The suffix of an audited table's trigger. */
export const AUDIT_TRAIL = "audit_trail"

/** The audited tables by name, for a test that reads a migrated database's triggers. */
export const AUDITED_TABLE_NAMES: ReadonlySet<string> = new Set(AUDITED.map((entry) => getTableName(entry.table)))

/** The triggers a table of a migrated database carries, as `pg_trigger` names them in order: the audit trail where the table is audited, then the touch where it has `updated_at`. */
export const triggersOf = (name: string, touched = true): string[] => [...(AUDITED_TABLE_NAMES.has(name) ? [`${name}_${AUDIT_TRAIL}`] : []), ...(touched ? [`${name}_touch_updated_at`] : [])]

/** What an audited table's trigger is given: the parent it is a set of, and the columns whose moves are no history. */
type TriggerArguments = Pick<Audited, "table" | "parent" | "ignored">

/** The statement that adds the audit trigger to this table, for the migration that creates the table. */
export function auditTrail(entry: TriggerArguments): string[] {
  const target = qualifiedTable(entry.table, HELPER)
  const args = [entry.parent === undefined ? "" : getTableName(entry.parent.table), entry.parent === undefined ? "" : columnName(entry.parent.column), ...entry.ignored.map(columnName)]
  return [
    `CREATE TRIGGER ${quoted(tableObjectName(entry.table, AUDIT_TRAIL, HELPER))} AFTER INSERT OR UPDATE OR DELETE ON ${target} FOR EACH ROW EXECUTE FUNCTION wms.audit_row(${args.map(literal).join(", ")});`,
  ]
}

/** The statements that give an audited table's trigger new arguments, for a later migration: the trigger dropped and added again, in the migration's one transaction. */
export function replaceAuditTrail(entry: TriggerArguments): string[] {
  return [`DROP TRIGGER ${quoted(tableObjectName(entry.table, AUDIT_TRAIL, HELPER))} ON ${qualifiedTable(entry.table, HELPER)};`, ...auditTrail(entry)]
}
