// Planning a ticket in a route (#546 of #544, part 2) as the migration writes
// it: an action's vehicle, keyed with its project since a vehicle is a
// project's and a type the company's, the two named together or not at all,
// and the days ahead the domain allows; the kind's list and its CASE take
// `plan-in-route`. Then the file: drizzle-kit's statements alone. The file is
// found by its name, not its number. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { PLAN_DAYS_AHEAD_MAX } from "@waste/domain/resolution/automation"
import { generateMigration } from "drizzle-kit/api"

import { MIGRATIONS_FOLDER } from "../migrate"
import { ticketTypeAction } from "../schema/resolution"
import { normalised, statementsOf } from "../sql/hand-written"
import { checksOf, ref } from "./rendering"

async function migrationName(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_ticket_planning\.sql$/.test(name))
  assert.ok(file !== undefined, "the ticket planning's migration")
  return file
}

type Snapshot = Parameters<typeof generateMigration>[0]
const snapshot = async (n: string): Promise<Snapshot> => JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", `${n}_snapshot.json`), "utf8")) as Snapshot

/** What drizzle-kit writes for the migration, diffing the snapshot before against its own. */
async function generated(): Promise<string[]> {
  const own = (await migrationName()).slice(0, 4)
  return (await generateMigration(await snapshot(String(Number(own) - 1).padStart(4, "0")), await snapshot(own))).map(normalised)
}

describe("the ticket planning as drizzle-kit writes it", () => {
  test("an action's vehicle is keyed with its project, both or neither, and its days ahead are the domain's", async () => {
    const statements = await generated()
    assert.ok(
      statements.includes(
        normalised(
          'ALTER TABLE "wms"."ticket_type_action" ADD CONSTRAINT "ticket_type_action_vehicle_project_id_vehicle_id_fk" FOREIGN KEY ("company_id","vehicle_project_id","vehicle_id") REFERENCES "wms"."vehicle"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;',
        ),
      ),
    )
    const checks = checksOf(ticketTypeAction)
    assert.equal(checks.get("ticket_type_action_vehicle_shape"), `(${ref("ticket_type_action", "vehicle_id")} is null) = (${ref("ticket_type_action", "vehicle_project_id")} is null)`)
    assert.equal(checks.get("ticket_type_action_days_ahead_range"), `${ref("ticket_type_action", "days_ahead")} between 0 and ${PLAN_DAYS_AHEAD_MAX}`)
    const shape = checks.get("ticket_type_action_kind_shape") ?? ""
    assert.ok(shape.includes(`when 'plan-in-route' then`))
    assert.ok(shape.includes(`${ref("ticket_type_action", "vehicle_id")} is not null and ${ref("ticket_type_action", "days_ahead")} is not null`))
  })
})

describe("the ticket planning's migration", () => {
  test("is drizzle-kit's statements alone", async () => {
    const text = await readFile(join(MIGRATIONS_FOLDER, await migrationName()), "utf8")
    assert.deepEqual([...statementsOf(text)].sort(), [...(await generated())].sort())
    assert.match(text, /^-- Planning a ticket in a route \(#546 of #544, part 2\)/)
  })
})
