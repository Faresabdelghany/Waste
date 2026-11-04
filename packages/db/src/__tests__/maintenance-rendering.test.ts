// Vehicle maintenance plans (O20 of #290) as drizzle-kit writes them: a
// vehicle's plans, keyed into the vehicle and keyed in turn through it, so a
// Maintenance Order names a plan of its own vehicle; the plan's interval rule
// and the order's closing shape as checks; and the alert's rule check
// respelt with `maintenance-due`, which Postgres has no ALTER for. Then the
// migration, whose head is exactly those statements and whose tail is each
// table's fence, trigger and audit trail. The file is found by its name, not
// its number, which it takes at its turn. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { ALERT_RULES } from "@waste/domain/resolution/vocabulary"

import { MIGRATIONS_FOLDER } from "../migrate"
import { maintenanceOrder, vehicleMaintenancePlan } from "../schema/maintenance"
import { auditTrail, MAINTENANCE_AUDITED } from "../sql/audit-trail"
import { normalised, statementsOf } from "../sql/hand-written"
import { tenantFence } from "../sql/tenant-fence"
import { touchUpdatedAt } from "../sql/touch-updated-at"
import { checksOf, list, ref } from "./rendering"
import { statementsFor } from "./specimen"

/** What drizzle-kit wrote into the alert: its rule's check, dropped and added again with the new rule. */
const ALTERED = [
  'ALTER TABLE "wms"."alert" DROP CONSTRAINT "alert_rule_one_of";',
  `ALTER TABLE "wms"."alert" ADD CONSTRAINT "alert_rule_one_of" CHECK (${ref("alert", "rule")} in (${list(...ALERT_RULES)}));`,
]

/** What the file owes below drizzle-kit's statements: the two fences, the two triggers, the two audit trails. */
const handWritten = (): string[] => [...tenantFence(maintenanceOrder), ...tenantFence(vehicleMaintenancePlan), ...touchUpdatedAt(maintenanceOrder), ...touchUpdatedAt(vehicleMaintenancePlan), ...MAINTENANCE_AUDITED.flatMap(auditTrail)]

async function migration(): Promise<{ text: string; statements: string[] }> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_maintenance\.sql$/.test(name))
  assert.ok(file !== undefined, "the maintenance migration")
  const text = await readFile(join(MIGRATIONS_FOLDER, file), "utf8")
  return { text, statements: statementsOf(text) }
}

describe("vehicle maintenance as drizzle-kit writes it", () => {
  test("the migration's head is exactly drizzle-kit's statements: the two tables, an order's plan of its own vehicle, and the alert's rule respelt", async () => {
    const { statements } = await migration()
    const generated = [...(await statementsFor({ vehicleMaintenancePlan, maintenanceOrder })), ...ALTERED].map(normalised)
    assert.deepEqual([...statements.slice(0, generated.length)].sort(), [...generated].sort())
    assert.ok(
      generated.includes(
        normalised('ALTER TABLE "wms"."maintenance_order" ADD CONSTRAINT "maintenance_order_vehicle_id_plan_id_fk" FOREIGN KEY ("company_id","project_id","vehicle_id","plan_id") REFERENCES "wms"."vehicle_maintenance_plan"("company_id","project_id","vehicle_id","id") ON DELETE no action ON UPDATE no action;'),
      ),
      "a plan of the order's own vehicle",
    )
  })

  test("and its tail is each table's fence, trigger and audit trail, and nothing else", async () => {
    const { text, statements } = await migration()
    const tail = handWritten().map(normalised)
    assert.deepEqual(statements.slice(statements.length - tail.length), tail)
    assert.equal(statements.length, (await statementsFor({ vehicleMaintenancePlan, maintenanceOrder })).length + ALTERED.length + tail.length, "nothing else in the file")
    assert.match(text, /^-- Vehicle maintenance plans \(O20 of #290\)/)
    assert.equal(ALERT_RULES.at(-1), "maintenance-due")
  })
})

describe("the checks", () => {
  test("a plan has an interval, and a distance or hours interval its reading; an order's columns follow its status", () => {
    const plan = (name: string) => ref("vehicle_maintenance_plan", name)
    assert.equal(checksOf(vehicleMaintenancePlan).get("vehicle_maintenance_plan_shape"), `(${plan("interval_days")} is not null or ${plan("interval_km")} is not null or ${plan("interval_hours")} is not null) and (${plan("interval_km")} is null or ${plan("last_done_km")} is not null) and (${plan("interval_hours")} is null or ${plan("last_done_hours")} is not null)`)
    const order = (name: string) => ref("maintenance_order", name)
    assert.equal(checksOf(maintenanceOrder).get("maintenance_order_closing_shape"), `(${order("status")} = 'open') = (${order("closed_at")} is null) and (${order("status")} = 'completed') = (${order("completed_on")} is not null) and (${order("status")} = 'completed' or (${order("odometer_km")} is null and ${order("engine_hours")} is null))`)
  })
})
