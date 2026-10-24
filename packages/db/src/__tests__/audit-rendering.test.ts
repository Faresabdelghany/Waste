// The audit log (#291, slice 9) as drizzle-kit writes it: one ledger, keyed to
// its company by the schema's one cascading key, with an index for the
// history of a row and a partial one for a set's under its parent. Then
// migration 0019, which has to begin with exactly those statements and carry
// below them what the helpers write — the fence and the revoke of a ledger,
// the trigger function once, and one trigger per audited table in the audit
// list's order — and nothing else. No database.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { AUDIT_ACTIONS } from "@waste/domain/audit/vocabulary"

import { MIGRATIONS_FOLDER } from "../migrate"
import { auditEvent } from "../schema/audit"
import { AUDIT_ROW_FUNCTION, AUDITED_AT_0019, auditTrail } from "../sql/audit-trail"
import { handWrittenStatements, normalised, statementsOf } from "../sql/hand-written"
import { COMPANY, columns, ID, oneOfCheck, ref } from "./rendering"
import { statementsFor } from "./specimen"

const MIGRATION = "0019_audit_log.sql"


const expected = [
  [
    'CREATE TABLE "wms"."audit_event" (',
    [
      ID,
      COMPANY,
      '"recorded_at" timestamp with time zone DEFAULT now() NOT NULL',
      '"project_id" uuid',
      '"table_name" text NOT NULL',
      '"row_id" uuid NOT NULL',
      '"parent_table" text',
      '"parent_id" uuid',
      '"action" text NOT NULL',
      '"changed" jsonb NOT NULL',
      '"actor_user_account_id" uuid',
      '"reason" text',
      '"transaction_id" bigint NOT NULL',
      oneOfCheck("audit_event", "action", ...AUDIT_ACTIONS),
    ]
      .map((line) => `\t${line}`)
      .join(",\n"),
    ");",
    "",
  ].join("\n"),
  'ALTER TABLE "wms"."audit_event" ADD CONSTRAINT "audit_event_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE cascade ON UPDATE no action;',
  `CREATE INDEX "audit_event_row_idx" ON "wms"."audit_event" USING btree (${columns("company_id", "table_name", "row_id", "id")});`,
  `CREATE INDEX "audit_event_parent_idx" ON "wms"."audit_event" USING btree (${columns("company_id", "parent_table", "parent_id", "id")}) WHERE ${ref("audit_event", "parent_id")} is not null;`,
]

const fileStatements = async (): Promise<string[]> => statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))

describe("the audit log as drizzle-kit writes it", () => {
  test("one ledger: the row, its parent, what moved, who and why, one transaction's id; the tenant's key cascades, and nothing else keys it", async () => {
    assert.deepEqual(await statementsFor({ auditEvent }), expected)
  })
})

describe("migration 0019", () => {
  test("is exactly that, then the ledger's fence and revoke, the trigger function and one trigger per audited table", async () => {
    const statements = await fileStatements()
    assert.deepEqual(statements, [...expected, ...handWrittenStatements(auditEvent), AUDIT_ROW_FUNCTION, ...AUDITED_AT_0019.flatMap(auditTrail)].map(normalised))
    assert.equal(statements.filter((statement) => statement.startsWith("CREATE TRIGGER")).length, AUDITED_AT_0019.length)
  })

  test("the company passes its three document counters as ignored, and a set its parent; a table of neither passes nothing", () => {
    const triggerOf = (name: string) => AUDITED_AT_0019.flatMap(auditTrail).find((statement) => statement.startsWith(`CREATE TRIGGER "${name}_audit_trail"`)) ?? ""
    assert.match(triggerOf("company"), /wms\.audit_row\('', '', 'next_route_number', 'next_ticket_number', 'next_invoice_number'\);$/)
    assert.match(triggerOf("role_grant"), /wms\.audit_row\('role', 'role_id'\);$/)
    assert.match(triggerOf("customer"), /wms\.audit_row\('', ''\);$/)
  })
})
