// Pre-trip inspection (O13 of #290) as drizzle-kit writes it: a vehicle
// type's checklist items, the checks a driver appends — a ledger keyed into
// the route, the vehicle and the driver through their project — and the
// defects a check finds, keyed into the check, the vehicle and the ticket;
// and four checks respelt, which Postgres has no ALTER for: the receipt's
// kind grown by `pre-trip-check`, and a ticket's kind, read by a ticket's, an
// SLA's and a ticket charge's checks, grown by `vehicle-defect`. Then the
// migration, whose head is exactly those statements and whose tail is what
// the tables owe the file. The file is found by its name, not its number,
// which it takes at its turn. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { DRIVER_COMMAND_KINDS } from "@waste/domain/execution/vocabulary"
import { TICKET_KINDS } from "@waste/domain/resolution/vocabulary"

import { MIGRATIONS_FOLDER } from "../migrate"
import { preTripCheck, preTripChecklistItem, vehicleDefect } from "../schema/pre-trip"
import { appendOnly } from "../sql/append-only"
import { auditTrail, PRE_TRIP_AUDITED } from "../sql/audit-trail"
import { normalised, statementsOf } from "../sql/hand-written"
import { tenantFence } from "../sql/tenant-fence"
import { touchUpdatedAt } from "../sql/touch-updated-at"
import { checksOf, oneOfCheck, ref } from "./rendering"
import { statementsFor } from "./specimen"

/** A check respelt: dropped and added again with its new list. */
const respelt = (table: string, column: string, name: string, values: readonly string[]): string[] => [
  `ALTER TABLE "wms"."${table}" DROP CONSTRAINT "${name}";`,
  `ALTER TABLE "wms"."${table}" ADD ${oneOfCheck(table, column, ...values).replace(/^CONSTRAINT "[^"]+"/, `CONSTRAINT "${name}"`)};`,
]

/** What drizzle-kit wrote into the tables already applied: the four checks respelt. */
const ALTERED = [
  ...respelt("driver_command", "kind", "driver_command_kind_one_of", DRIVER_COMMAND_KINDS),
  ...respelt("ticket", "kind", "ticket_kind_one_of", TICKET_KINDS),
  ...respelt("ticket_sla", "kind", "ticket_sla_kind_one_of", TICKET_KINDS),
  ...respelt("ticket_kind_product", "ticket_kind", "ticket_kind_product_ticket_kind_one_of", TICKET_KINDS),
]

/** What the file owes below drizzle-kit's statements: the three fences, the ledger's revoke, the two triggers, the two audit trails. */
const handWritten = (): string[] => [
  ...tenantFence(preTripCheck),
  ...tenantFence(preTripChecklistItem),
  ...tenantFence(vehicleDefect),
  ...appendOnly(preTripCheck),
  ...touchUpdatedAt(preTripChecklistItem),
  ...touchUpdatedAt(vehicleDefect),
  ...PRE_TRIP_AUDITED.flatMap(auditTrail),
]

/** The migration, by its name: it takes its number at its turn. */
async function migration(): Promise<{ text: string; statements: string[] }> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_pre_trip\.sql$/.test(name))
  assert.ok(file !== undefined, "the pre-trip migration")
  const text = await readFile(join(MIGRATIONS_FOLDER, file), "utf8")
  return { text, statements: statementsOf(text) }
}

describe("pre-trip inspection as drizzle-kit writes it", () => {
  test("the migration's head is exactly drizzle-kit's statements: the three tables with their keys and indexes, and the four checks respelt", async () => {
    const { statements } = await migration()
    const generated = [...(await statementsFor({ preTripCheck, preTripChecklistItem, vehicleDefect })), ...ALTERED].map(normalised)
    // The same statements, whatever order drizzle-kit's loader gave them.
    assert.deepEqual([...statements.slice(0, generated.length)].sort(), [...generated].sort())
    assert.ok(generated.includes(normalised('ALTER TABLE "wms"."pre_trip_check" ADD CONSTRAINT "pre_trip_check_vehicle_id_fk" FOREIGN KEY ("company_id","project_id","vehicle_id") REFERENCES "wms"."vehicle"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;')), "a vehicle of the check's project")
    assert.ok(generated.includes(normalised('CREATE INDEX "pre_trip_check_vehicle_id_idx" ON "wms"."pre_trip_check" USING btree ("company_id","vehicle_id","occurred_at");')), "a vehicle's checks in order")
    assert.ok(generated.includes(normalised('ALTER TABLE "wms"."vehicle_defect" ADD CONSTRAINT "vehicle_defect_ticket_id_fk" FOREIGN KEY ("company_id","project_id","ticket_id") REFERENCES "wms"."ticket"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;')), "the ticket of the defect's project")
  })

  test("and its tail is what the tables owe it, in that order, and nothing else", async () => {
    const { text, statements } = await migration()
    const tail = handWritten().map(normalised)
    assert.deepEqual(statements.slice(statements.length - tail.length), tail)
    assert.equal(statements.length, (await statementsFor({ preTripCheck, preTripChecklistItem, vehicleDefect })).length + ALTERED.length + tail.length, "nothing else in the file")
    assert.ok(tail.includes(normalised('REVOKE UPDATE, DELETE ON "wms"."pre_trip_check" FROM wms_api;')))
    assert.match(text, /^-- Pre-trip inspection \(O13 of #290\)/)
  })

  test("the receipt's kinds grew by pre-trip-check, and a ticket's by vehicle-defect", () => {
    assert.equal(DRIVER_COMMAND_KINDS.at(-1), "pre-trip-check")
    assert.ok((TICKET_KINDS as readonly string[]).includes("vehicle-defect"))
  })
})

describe("the checks of the three tables", () => {
  test("an item's place is positive; a check's readings are not negative; a defect is resolved exactly when it says when", () => {
    assert.equal(checksOf(preTripChecklistItem).get("pre_trip_checklist_item_position_positive"), `${ref("pre_trip_checklist_item", "position")} > 0`)
    const check = (name: string) => ref("pre_trip_check", name)
    assert.equal(checksOf(preTripCheck).get("pre_trip_check_readings_range"), `${check("defect_count")} >= 0 and (${check("odometer_km")} is null or ${check("odometer_km")} >= 0) and (${check("engine_hours")} is null or ${check("engine_hours")} >= 0)`)
    assert.equal(checksOf(vehicleDefect).get("vehicle_defect_resolution_shape"), `(${ref("vehicle_defect", "status")} = 'resolved') = (${ref("vehicle_defect", "resolved_at")} is not null)`)
  })
})
