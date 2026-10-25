// The Pickup Exceptions (M5 of #293) as drizzle-kit writes them: the four
// new tables — a company's contaminant codes and the fractions each applies
// to, a project's rules and their ladders — and the contaminant code on the
// pickup and on its proof, diffed from the two as 0032 and 0008 left them
// (pickup-as-of.ts, proof-as-of.ts), since an applied file is never edited.
// Then migration 0038, which is exactly those statements, then what the four
// owe the file by migrations/README.md: each one's fence and trigger, the
// rule's exclusion constraint over its `match_key`, and the audit trail of
// the four (`PICKUP_EXCEPTIONS_AUDITED`). No database.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { MIGRATIONS_FOLDER } from "../migrate"
import { userAccount } from "../schema/access"
import { product, wasteFraction } from "../schema/catalogue"
import { container } from "../schema/containers"
import { property, sharedCollectionPoint } from "../schema/customers"
import { pickup, proofOfService, route, session } from "../schema/execution"
import { company, project } from "../schema/organisation"
import { contaminantCode, contaminantCodeFraction, pickupExceptionRule, pickupExceptionRuleStep } from "../schema/pickup-exceptions"
import { auditTrail, PICKUP_EXCEPTIONS_AUDITED } from "../sql/audit-trail"
import { excludeOverlapping } from "../sql/exclude-overlapping"
import { handWrittenStatements, normalised, statementsOf } from "../sql/hand-written"
import { checksOf, list, ref } from "./rendering"
import { pickupAsOf0032 } from "./pickup-as-of"
import { proofAsOf0029 } from "./proof-as-of"
import { statementsBetween } from "./specimen"

const MIGRATION = "0038_pickup_exceptions.sql"

const referenced = { company, project, route, session, userAccount, container, property, sharedCollectionPoint, wasteFraction, product }
const created = { contaminantCode, contaminantCodeFraction, pickupExceptionRule, pickupExceptionRuleStep }

/** What drizzle-kit writes for 0038: the four tables, and the pickup and the proof from their earlier spellings to today's. */
const generated = (): Promise<string[]> => statementsBetween({ ...referenced, pickup: pickupAsOf0032, proofOfService: proofAsOf0029 }, { ...referenced, pickup, proofOfService, ...created })

/** What the four owe the file below drizzle-kit's statements: fence and trigger each, the rule's exclusion constraint, then their audit trail. */
const handWritten = [
  ...Object.values(created).flatMap((table) => handWrittenStatements(table)),
  ...excludeOverlapping(pickupExceptionRule, [pickupExceptionRule.projectId, pickupExceptionRule.matchKey]),
  ...PICKUP_EXCEPTIONS_AUDITED.flatMap(auditTrail),
]

const fileStatements = async (): Promise<string[]> => statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))

describe("the Pickup Exceptions as drizzle-kit writes them", () => {
  test("the pickup and its proof each gain the code, its key and its index, held to what the code tags", async () => {
    const statements = await generated()
    for (const expected of [
      'ALTER TABLE "wms"."pickup" ADD COLUMN "contaminant_code_id" uuid;',
      'ALTER TABLE "wms"."proof_of_service" ADD COLUMN "contaminant_code_id" uuid;',
      `ALTER TABLE "wms"."pickup" ADD CONSTRAINT "pickup_contaminant_code_shape" CHECK (${ref("pickup", "contaminant_code_id")} is null or ${ref("pickup", "reason")} = 'contamination' or ${ref("pickup", "status")} = 'completed');`,
      `ALTER TABLE "wms"."proof_of_service" ADD CONSTRAINT "proof_of_service_contaminant_code_shape" CHECK (${ref("proof_of_service", "contaminant_code_id")} is null or ${ref("proof_of_service", "kind")} in (${list("completion", "skip", "failure", "correction")}));`,
      'ALTER TABLE "wms"."pickup" ADD CONSTRAINT "pickup_contaminant_code_id_fk" FOREIGN KEY ("company_id","contaminant_code_id") REFERENCES "wms"."contaminant_code"("company_id","id") ON DELETE no action ON UPDATE no action;',
      'CREATE INDEX "pickup_contaminant_code_id_idx" ON "wms"."pickup" USING btree ("company_id","contaminant_code_id");',
      'CREATE INDEX "proof_of_service_contaminant_code_id_idx" ON "wms"."proof_of_service" USING btree ("company_id","contaminant_code_id");',
    ]) {
      assert.ok(statements.includes(expected), expected)
    }
  })

  test("a rule folds its outcome, reason and code into a NOT NULL match key, and its shapes render without parameters", () => {
    assert.equal(pickupExceptionRule.matchKey.notNull, true)
    const checks = checksOf(pickupExceptionRule)
    assert.equal(checks.get("pickup_exception_rule_reason_shape"), `${ref("pickup_exception_rule", "outcome")} <> 'completed' or ${ref("pickup_exception_rule", "reason")} is null`)
    assert.equal(
      checks.get("pickup_exception_rule_code_shape"),
      `${ref("pickup_exception_rule", "contaminant_code_id")} is null or ${ref("pickup_exception_rule", "reason")} is null or ${ref("pickup_exception_rule", "reason")} = 'contamination'`,
    )
    assert.equal(checks.get("pickup_exception_rule_reason_one_of"), `${ref("pickup_exception_rule", "reason")} in (${list("contamination", "not-presented", "inaccessible", "other")})`, "only the customer's reasons")
  })

  test("two rules alike are never in force at once: one exclusion constraint over the project, the match key and the period", () => {
    assert.deepEqual(excludeOverlapping(pickupExceptionRule, [pickupExceptionRule.projectId, pickupExceptionRule.matchKey]), [
      `ALTER TABLE "wms"."pickup_exception_rule" ADD CONSTRAINT "pickup_exception_rule_no_overlap" EXCLUDE USING gist ("company_id" WITH =, "project_id" WITH =, "match_key" WITH =, daterange("valid_from", "valid_to", '[)') WITH &&);`,
    ])
  })
})

describe("migration 0038", () => {
  test("begins with exactly what drizzle-kit generates for it, whatever order its loader gave the tables", async () => {
    const statements = await fileStatements()
    const head = (await generated()).map(normalised).sort()
    assert.deepEqual([...statements.slice(0, head.length)].sort(), head)
  })

  test("and carries below them the four tables' fences and triggers, the rule's exclusion constraint and the four audit trails, in that order", async () => {
    const statements = await fileStatements()
    const head = (await generated()).length
    assert.deepEqual(statements.slice(head), handWritten.map(normalised))
    assert.equal(PICKUP_EXCEPTIONS_AUDITED.length, 4, "the codes, their fractions, the rules and their steps")
  })
})
