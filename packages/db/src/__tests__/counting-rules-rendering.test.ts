// Counting rules (#547 of #544) as the migration writes them: a rule, its
// name the company's once, of a status, a period and a limit the domain
// allows, its fraction, container type, ticket type and team keys the
// database checks; and the ticket a rule opens, naming the rule, the period
// and the count together with the property, one per rule, property and
// period, a counting rule among the ticket's sources. Then the file:
// drizzle-kit's statements, then the rule's fence, trigger and audit trail.
// The file is found by its name, not its number. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { COUNTING_LIMIT_MAX } from "@waste/domain/resolution/counting-rules"
import { COUNTING_PERIODS, COUNTING_RULE_STATUSES, TICKET_SOURCES } from "@waste/domain/resolution/vocabulary"
import { generateMigration } from "drizzle-kit/api"

import { MIGRATIONS_FOLDER } from "../migrate"
import { countingRule, ticket } from "../schema/resolution"
import { auditTrail, COUNTING_RULES_AUDITED } from "../sql/audit-trail"
import { handWrittenStatements, normalised, statementsOf } from "../sql/hand-written"
import { checksOf, list, ref } from "./rendering"

async function migrationName(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_counting_rules\.sql$/.test(name))
  assert.ok(file !== undefined, "the counting rules' migration")
  return file
}

type Snapshot = Parameters<typeof generateMigration>[0]
const snapshot = async (n: string): Promise<Snapshot> => JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", `${n}_snapshot.json`), "utf8")) as Snapshot

/** What drizzle-kit writes for the migration, diffing the snapshot before against its own. */
async function generated(): Promise<string[]> {
  const own = (await migrationName()).slice(0, 4)
  return (await generateMigration(await snapshot(String(Number(own) - 1).padStart(4, "0")), await snapshot(own))).map(normalised)
}

describe("the counting rules as drizzle-kit writes them", () => {
  test("a rule is named once in its company, of a status, a period and a limit, its fraction, container type, ticket type and team the company's", async () => {
    const statements = await generated()
    assert.match(statements.find((statement) => statement.startsWith('CREATE TABLE "wms"."counting_rule"')) ?? "", /CONSTRAINT "counting_rule_name_key" UNIQUE\("company_id","name"\)/)
    for (const [column, table] of [
      ["waste_fraction_id", "waste_fraction"],
      ["container_type_id", "container_type"],
      ["ticket_type_id", "ticket_type"],
      ["team_id", "team"],
    ]) {
      assert.ok(statements.includes(normalised(`ALTER TABLE "wms"."counting_rule" ADD CONSTRAINT "counting_rule_${column}_fk" FOREIGN KEY ("company_id","${column}") REFERENCES "wms"."${table}"("company_id","id") ON DELETE no action ON UPDATE no action;`)), column)
    }
    const checks = checksOf(countingRule)
    assert.equal(checks.get("counting_rule_status_one_of"), `${ref("counting_rule", "status")} in (${list(...COUNTING_RULE_STATUSES)})`)
    assert.equal(checks.get("counting_rule_period_one_of"), `${ref("counting_rule", "period")} in (${list(...COUNTING_PERIODS)})`)
    assert.equal(checks.get("counting_rule_limit_range"), `${ref("counting_rule", "limit")} between 1 and ${COUNTING_LIMIT_MAX}`)
  })

  test("a rule's ticket names the rule, the period and the count together with its property, once per rule, property and period", async () => {
    const statements = await generated()
    assert.ok(statements.includes(normalised('ALTER TABLE "wms"."ticket" ADD CONSTRAINT "ticket_counting_rule_id_fk" FOREIGN KEY ("company_id","counting_rule_id") REFERENCES "wms"."counting_rule"("company_id","id") ON DELETE no action ON UPDATE no action;')))
    assert.ok(statements.includes(normalised('CREATE UNIQUE INDEX "ticket_counting_key" ON "wms"."ticket" USING btree ("company_id","counting_rule_id","property_id","counted_from") WHERE "wms"."ticket"."counting_rule_id" is not null;')))
    const checks = checksOf(ticket)
    const [rule, from, counted, property] = (["counting_rule_id", "counted_from", "counted", "property_id"] as const).map((column) => ref("ticket", column))
    assert.equal(checks.get("ticket_counting_shape"), `(${rule} is null) = (${from} is null) and (${rule} is null) = (${counted} is null) and (${rule} is null or ${property} is not null)`)
    assert.equal(checks.get("ticket_counted_positive"), `${counted} > 0`)
    assert.equal(checks.get("ticket_source_one_of"), `${ref("ticket", "source")} in (${list(...TICKET_SOURCES)})`)
    assert.equal(TICKET_SOURCES.at(-1), "counting-rule")
  })
})

describe("the counting rules' migration", () => {
  test("is drizzle-kit's statements, then the rule's fence, trigger and audit trail", async () => {
    const text = await readFile(join(MIGRATIONS_FOLDER, await migrationName()), "utf8")
    const statements = statementsOf(text)
    const drizzle = await generated()
    assert.deepEqual([...statements.slice(0, drizzle.length)].sort(), [...drizzle].sort())
    assert.deepEqual(statements.slice(drizzle.length), [...handWrittenStatements(countingRule), ...COUNTING_RULES_AUDITED.flatMap(auditTrail)].map(normalised))
    assert.match(text, /^-- Counting rules \(#547 of #544\)/)
  })

  test("the rules are audited under the templates' grant, each its own", () => {
    assert.deepEqual(
      COUNTING_RULES_AUDITED.map((entry) => [entry.table, entry.module, entry.parent]),
      [[countingRule, "configure.templates", undefined]],
    )
  })
})
