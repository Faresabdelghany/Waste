// Ticket automation (#546 of #544) as the migration writes it: a type's
// actions, one place per trigger once, each of a trigger, a kind and the
// parameters its kind carries (one CASE built from the domain's
// `ACTION_PARAMETERS`), a team, a person and a follow-up type keys the
// database checks. Then the file: drizzle-kit's statements, then the table's
// fence, trigger and audit trail. The file is found by its name, not its
// number. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { ACTION_PARAMETERS } from "@waste/domain/resolution/automation"
import { TICKET_ACTION_COMMANDS, TICKET_ACTION_KINDS, TICKET_ACTION_TRIGGERS, TICKET_MESSAGE_RECIPIENTS } from "@waste/domain/resolution/vocabulary"
import { generateMigration } from "drizzle-kit/api"

import { MIGRATIONS_FOLDER } from "../migrate"
import { ticketType, ticketTypeAction } from "../schema/resolution"
import { auditTrail, TICKET_AUTOMATION_AUDITED } from "../sql/audit-trail"
import { handWrittenStatements, normalised, statementsOf } from "../sql/hand-written"
import { checksOf, list, ref } from "./rendering"

async function migrationName(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_ticket_automation\.sql$/.test(name))
  assert.ok(file !== undefined, "the ticket automation's migration")
  return file
}

type Snapshot = Parameters<typeof generateMigration>[0]
const snapshot = async (n: string): Promise<Snapshot> => JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", `${n}_snapshot.json`), "utf8")) as Snapshot

/** What drizzle-kit writes for the migration, diffing the snapshot before against its own. */
async function generated(): Promise<string[]> {
  const own = (await migrationName()).slice(0, 4)
  return (await generateMigration(await snapshot(String(Number(own) - 1).padStart(4, "0")), await snapshot(own))).map(normalised)
}

describe("the ticket automation as drizzle-kit writes it", () => {
  test("an action is its type's, one place per trigger once, of a trigger, a kind, and a team, a person and a follow-up type of the company", async () => {
    const statements = await generated()
    assert.match(statements.find((statement) => statement.startsWith('CREATE TABLE "wms"."ticket_type_action"')) ?? "", /CONSTRAINT "ticket_type_action_ticket_type_id_trigger_position_key" UNIQUE\("company_id","ticket_type_id","trigger","position"\)/)
    for (const [column, table] of [
      ["team_id", "team"],
      ["user_account_id", "user_account"],
      ["follow_up_type_id", "ticket_type"],
    ]) {
      assert.ok(statements.includes(normalised(`ALTER TABLE "wms"."ticket_type_action" ADD CONSTRAINT "ticket_type_action_${column}_fk" FOREIGN KEY ("company_id","${column}") REFERENCES "wms"."${table}"("company_id","id") ON DELETE no action ON UPDATE no action;`)), column)
    }
    const checks = checksOf(ticketTypeAction)
    assert.equal(checks.get("ticket_type_action_trigger_one_of"), `${ref("ticket_type_action", "trigger")} in (${list(...TICKET_ACTION_TRIGGERS)})`)
    assert.equal(checks.get("ticket_type_action_kind_one_of"), `${ref("ticket_type_action", "kind")} in (${list(...TICKET_ACTION_KINDS)})`)
    assert.equal(checks.get("ticket_type_action_command_one_of"), `${ref("ticket_type_action", "command")} in (${list(...TICKET_ACTION_COMMANDS)})`)
    assert.equal(checks.get("ticket_type_action_recipient_one_of"), `${ref("ticket_type_action", "recipient")} in (${list(...TICKET_MESSAGE_RECIPIENTS)})`)
  })

  test("the kind CASE carries each kind's parameters and forbids the rest, a completion's resolution with it", () => {
    const shape = checksOf(ticketTypeAction).get("ticket_type_action_kind_shape") ?? ""
    for (const kind of TICKET_ACTION_KINDS) assert.ok(shape.includes(`when '${kind}' then`), kind)
    assert.ok(shape.includes(`${ref("ticket_type_action", "team_id")} is not null`))
    assert.ok(shape.includes(`(${ref("ticket_type_action", "command")} = 'complete') = (${ref("ticket_type_action", "resolution")} is not null)`))
    assert.ok(shape.endsWith("else false end"))
    assert.deepEqual(ACTION_PARAMETERS["send-message"], ["messageTemplateName", "recipient"])
  })
})

describe("the ticket automation's migration", () => {
  test("is drizzle-kit's statements, then the table's fence, trigger and audit trail", async () => {
    const text = await readFile(join(MIGRATIONS_FOLDER, await migrationName()), "utf8")
    const statements = statementsOf(text)
    const drizzle = await generated()
    assert.deepEqual([...statements.slice(0, drizzle.length)].sort(), [...drizzle].sort())
    assert.deepEqual(statements.slice(drizzle.length), [...handWrittenStatements(ticketTypeAction), ...TICKET_AUTOMATION_AUDITED.flatMap(auditTrail)].map(normalised))
    assert.match(text, /^-- Ticket automation \(#546 of #544\)/)
  })

  test("the actions are audited under the templates' grant, a set of their type", () => {
    assert.deepEqual(
      TICKET_AUTOMATION_AUDITED.map((entry) => [entry.table, entry.module, entry.parent]),
      [[ticketTypeAction, "configure.templates", { table: ticketType, column: ticketTypeAction.ticketTypeId }]],
    )
  })
})
