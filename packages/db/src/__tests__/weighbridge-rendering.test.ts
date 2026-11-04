// A weighbridge's tickets (O27 of #290) as drizzle-kit writes them: one table,
// keyed into its station and its sender through the company and into its
// vehicle, its route and its Unload through its project, unique by the
// station's ticket number, with the Unload's weights sentence and the status
// shape. Then the migration, whose head is exactly that table and whose tail
// is what it owes the file: its fence, its trigger and its audit trail. The
// file is found by its name, not its number, which it takes at its turn. No
// database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { MIGRATIONS_FOLDER } from "../migrate"
import { weighbridgeTicket } from "../schema/weighbridge"
import { auditTrail, WEIGHBRIDGE_AUDITED } from "../sql/audit-trail"
import { normalised, statementsOf } from "../sql/hand-written"
import { tenantFence } from "../sql/tenant-fence"
import { touchUpdatedAt } from "../sql/touch-updated-at"
import { checksOf, ref } from "./rendering"
import { statementsFor } from "./specimen"

/** What the file owes below drizzle-kit's statements: the fence, the trigger, the audit trail. */
const handWritten = (): string[] => [...tenantFence(weighbridgeTicket), ...touchUpdatedAt(weighbridgeTicket), ...WEIGHBRIDGE_AUDITED.flatMap(auditTrail)]

/** The migration, by its name: it takes its number at its turn. */
async function migration(): Promise<{ text: string; statements: string[] }> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_weighbridge_tickets\.sql$/.test(name))
  assert.ok(file !== undefined, "the weighbridge's migration")
  const text = await readFile(join(MIGRATIONS_FOLDER, file), "utf8")
  return { text, statements: statementsOf(text) }
}

describe("a weighbridge's tickets as drizzle-kit writes them", () => {
  test("the migration's head is exactly the table with its keys and indexes", async () => {
    const { statements } = await migration()
    const generated = (await statementsFor({ weighbridgeTicket })).map(normalised)
    assert.deepEqual([...statements.slice(0, generated.length)].sort(), [...generated].sort())
    assert.ok(generated.includes(normalised('ALTER TABLE "wms"."weighbridge_ticket" ADD CONSTRAINT "weighbridge_ticket_unload_id_fk" FOREIGN KEY ("company_id","project_id","unload_id") REFERENCES "wms"."unload"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;')), "the Unload of the ticket's project")
    assert.ok(generated.includes(normalised('ALTER TABLE "wms"."weighbridge_ticket" ADD CONSTRAINT "weighbridge_ticket_vehicle_id_fk" FOREIGN KEY ("company_id","project_id","vehicle_id") REFERENCES "wms"."vehicle"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;')), "a vehicle of the ticket's project")
    assert.ok(generated.includes(normalised('CREATE INDEX "weighbridge_ticket_status_idx" ON "wms"."weighbridge_ticket" USING btree ("company_id","status","id");')), "the office's queue")
  })

  test("and its tail is what the table owes it, in that order, and nothing else", async () => {
    const { text, statements } = await migration()
    const tail = handWritten().map(normalised)
    assert.deepEqual(statements.slice(statements.length - tail.length), tail)
    assert.equal(statements.length, (await statementsFor({ weighbridgeTicket })).length + tail.length, "nothing else in the file")
    assert.match(text, /^-- A weighbridge's tickets \(O27 of #290, row 8\.8\)/)
  })
})

describe("the table's checks", () => {
  const column = (name: string) => ref("weighbridge_ticket", name)

  test("the weights are an Unload's sentence; matched is a route and its Unload in a project, dismissed says why, unmatched what it waits for", () => {
    assert.equal(checksOf(weighbridgeTicket).get("weighbridge_ticket_weights_shape"), `(${column("gross_kg")} is null) = (${column("tare_kg")} is null) and (${column("gross_kg")} is null or ${column("net_kg")} = ${column("gross_kg")} - ${column("tare_kg")})`)
    assert.equal(
      checksOf(weighbridgeTicket).get("weighbridge_ticket_status_shape"),
      `(${column("status")} = 'matched') = (${column("route_id")} is not null and ${column("unload_id")} is not null and ${column("project_id")} is not null) and (${column("status")} = 'dismissed') = (${column("dismissed_note")} is not null) and (${column("status")} <> 'unmatched' or ${column("unmatched_reason")} is not null)`,
    )
  })
})
