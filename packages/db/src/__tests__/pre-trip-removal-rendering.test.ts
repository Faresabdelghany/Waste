// The pre-trip inspection removed (O13 of #290 undone) as drizzle-kit writes
// it: the three tables 0075 created dropped (pre-trip-as-of.ts, since the
// schema holds them no more), and six checks respelt, which Postgres has no
// ALTER for — the receipt's kind without `pre-trip-check`, and a ticket's
// kind, read by a ticket's, an SLA's, a team default's, a ticket type's and a
// ticket charge's checks, without `vehicle-defect`. Then the migration, whose
// head is exactly the drops and the six checks dropped, whose tail is the six
// checks added again, and whose middle is hand-written: the receipts of the
// removed kind deleted, the tickets of the other re-labelled `other` with
// their company's default `other` type and kept, and that kind's types and
// configuration deleted — each statement pinned, and its place between the
// two halves, since a row holding a removed kind fails the new check. The
// file is found by its name, not its number, which it takes at its turn. No
// database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { DRIVER_COMMAND_KINDS } from "@waste/domain/execution/vocabulary"
import { DEFAULT_TICKET_TYPE_NAMES } from "@waste/domain/resolution/ticket-types"
import { TICKET_KINDS } from "@waste/domain/resolution/vocabulary"

import { MIGRATIONS_FOLDER } from "../migrate"
import { userAccount } from "../schema/access"
import { route } from "../schema/execution"
import { driver, vehicle } from "../schema/fleet"
import { vehicleType } from "../schema/fleet-types"
import { company, project } from "../schema/organisation"
import { ticket } from "../schema/resolution"
import { normalised, statementsOf } from "../sql/hand-written"
import { PRE_TRIP_TABLES_AS_OF_0075 } from "./pre-trip-as-of"
import { oneOfCheck } from "./rendering"
import { statementsBetween } from "./specimen"

/** What the three tables name, present on both sides of the diff. */
const referenced = { company, project, userAccount, route, vehicle, driver, vehicleType, ticket }

/** The six checks whose list lost a kind, in drizzle-kit's order: the table, the column, the name and today's list. */
const RESPELT = [
  ["driver_command", "kind", "driver_command_kind_one_of", DRIVER_COMMAND_KINDS],
  ["ticket", "kind", "ticket_kind_one_of", TICKET_KINDS],
  ["ticket_sla", "kind", "ticket_sla_kind_one_of", TICKET_KINDS],
  ["ticket_team_default", "kind", "ticket_team_default_kind_one_of", TICKET_KINDS],
  ["ticket_type", "kind", "ticket_type_kind_one_of", TICKET_KINDS],
  ["ticket_kind_product", "ticket_kind", "ticket_kind_product_ticket_kind_one_of", TICKET_KINDS],
] as const

const DROPPED_CHECKS = RESPELT.map(([table, , name]) => `ALTER TABLE "wms"."${table}" DROP CONSTRAINT "${name}";`)
const ADDED_CHECKS = RESPELT.map(([table, column, name, values]) => `ALTER TABLE "wms"."${table}" ADD ${oneOfCheck(table, column, ...values).replace(/^CONSTRAINT "[^"]+"/, `CONSTRAINT "${name}"`)};`)

/** The catch-all a removed ticket kind's tickets are re-labelled with: the list's last, `other`. */
const CATCH_ALL = TICKET_KINDS[TICKET_KINDS.length - 1]

/** The removed kind's ticket types, the set whose actions, fields and permissions go first, and the follow-up an action of another type may name. */
const DEFECT_TYPES = `(SELECT "id" FROM "wms"."ticket_type" WHERE "kind" = 'vehicle-defect')`

/** The hand-written middle, in its order: the receipts deleted; the tickets kept under the catch-all and its company's default type, made first where missing; then the kind's types with their sets, and its configuration, deleted. */
const CLEARED = [
  `DELETE FROM "wms"."driver_command" WHERE "kind" = 'pre-trip-check';`,
  `INSERT INTO "wms"."ticket_type" ("company_id", "kind", "name", "is_default") SELECT DISTINCT t."company_id", '${CATCH_ALL}', '${DEFAULT_TICKET_TYPE_NAMES[CATCH_ALL]}', true FROM "wms"."ticket" AS t WHERE t."kind" = 'vehicle-defect' ON CONFLICT DO NOTHING;`,
  `UPDATE "wms"."ticket" AS t SET "kind" = '${CATCH_ALL}', "ticket_type_id" = y."id" FROM "wms"."ticket_type" AS y WHERE y."company_id" = t."company_id" AND y."kind" = '${CATCH_ALL}' AND y."is_default" AND t."kind" = 'vehicle-defect';`,
  `DELETE FROM "wms"."ticket_type_action" WHERE "ticket_type_id" IN ${DEFECT_TYPES} OR "follow_up_type_id" IN ${DEFECT_TYPES};`,
  `DELETE FROM "wms"."ticket_type_field" WHERE "ticket_type_id" IN ${DEFECT_TYPES};`,
  `DELETE FROM "wms"."ticket_type_permission" WHERE "ticket_type_id" IN ${DEFECT_TYPES};`,
  `DELETE FROM "wms"."ticket_type" WHERE "kind" = 'vehicle-defect';`,
  `DELETE FROM "wms"."ticket_sla" WHERE "kind" = 'vehicle-defect';`,
  `DELETE FROM "wms"."ticket_team_default" WHERE "kind" = 'vehicle-defect';`,
  `DELETE FROM "wms"."ticket_kind_product" WHERE "ticket_kind" = 'vehicle-defect';`,
].map(normalised)

/** The three tables 0075 created. */
const TABLES = ["pre_trip_check", "pre_trip_checklist_item", "vehicle_defect"] as const

/** What drizzle-kit writes for the three tables gone. */
const dropped = () => statementsBetween({ ...referenced, ...PRE_TRIP_TABLES_AS_OF_0075 }, referenced)

/** What the CLI writes before each drop besides, and `drizzle-kit/api` does not: row-level security switched off, which the drop takes with the table anyway. */
const DISABLED = TABLES.map((table) => `ALTER TABLE "wms"."${table}" DISABLE ROW LEVEL SECURITY;`)

/** The migration, by its name: it takes its number at its turn. */
async function migration(): Promise<{ text: string; statements: string[] }> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_pre_trip_removal\.sql$/.test(name))
  assert.ok(file !== undefined, "the pre-trip removal's migration")
  const text = await readFile(join(MIGRATIONS_FOLDER, file), "utf8")
  return { text, statements: statementsOf(text) }
}

describe("the pre-trip inspection removed as drizzle-kit writes it", () => {
  test("the three tables are dropped whole, their keys and policies with them", async () => {
    assert.deepEqual(
      [...(await dropped())].sort(),
      TABLES.map((table) => `DROP TABLE "wms"."${table}" CASCADE;`),
      "nothing but the drops",
    )
  })

  test("the migration's head is the drops and the five checks dropped; its tail the five checks added again; between them no row is left holding a removed kind, and no ticket is deleted", async () => {
    const { statements } = await migration()
    const head = [...DISABLED, ...(await dropped()), ...DROPPED_CHECKS].map(normalised)
    // The same statements, whatever order drizzle-kit's loader gave them.
    assert.deepEqual([...statements.slice(0, head.length)].sort(), [...head].sort())
    assert.deepEqual(statements.slice(head.length, head.length + CLEARED.length), CLEARED)
    assert.deepEqual(statements.slice(head.length + CLEARED.length), ADDED_CHECKS.map(normalised), "the checks added last, once nothing holds a removed kind, and nothing else in the file")
    assert.equal(statements.filter((statement) => /^DELETE FROM "wms"\."ticket"/.test(statement)).length, 0, "a ticket is the office's: re-labelled, never deleted")
  })

  test("the header says what went, what is deleted and what is re-labelled", async () => {
    const { text } = await migration()
    assert.match(text, /^-- Pre-trip inspection removed \(O13 of #290 undone/)
    for (const said of ["`pre_trip_checklist_item`", "`pre_trip_check`", "`vehicle_defect`", "`pre-trip-check`", "`vehicle-defect`", "`driver_command`", "re-labelled `other`"]) assert.ok(text.includes(said), said)
  })

  test("the lists lost exactly the two kinds", () => {
    assert.equal((DRIVER_COMMAND_KINDS as readonly string[]).includes("pre-trip-check"), false)
    assert.equal((TICKET_KINDS as readonly string[]).includes("vehicle-defect"), false)
    assert.ok(ADDED_CHECKS[0].includes("'record-positions', 'record-fill'"), "record-fill follows record-positions again")
    assert.ok(ADDED_CHECKS[1].includes("'internal-task', 'other'"), "other follows internal-task again")
    assert.equal(CATCH_ALL, "other", "the catch-all the tickets are kept under")
  })
})
