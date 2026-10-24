// The stop a ticket is answered by (O3c of #290) as drizzle-kit writes it:
// the booked route and pickup on the ticket, a pickup of that route through
// the project key the re-collection's stop reaches, both or neither, and one
// ticket per stop — six statements diffed from the ticket as 0033 left it
// (ticket-as-of.ts), since an applied file is never edited;
// resolution-rendering.test.ts maps today's table back (`CHANGED_LATER`).
// Then migration 0035, which is exactly those statements under its header:
// no table is new, so nothing is hand-written, and no ticket present names a
// booking, so nothing is guarded. No database.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { MIGRATIONS_FOLDER } from "../migrate"
import { userAccount } from "../schema/access"
import { agreement } from "../schema/agreements"
import { product } from "../schema/catalogue"
import { container } from "../schema/containers"
import { customer, property, sharedCollectionPoint } from "../schema/customers"
import { pickup, route } from "../schema/execution"
import { driver } from "../schema/fleet"
import { company, project } from "../schema/organisation"
import { ticket } from "../schema/resolution"
import { normalised, statementsOf } from "../sql/hand-written"
import { checksOf, ref } from "./rendering"
import { statementsBetween } from "./specimen"
import { ticketAsOf } from "./ticket-as-of"

const MIGRATION = "0035_ticket_stops.sql"

const referenced = { company, project, userAccount, route, pickup, container, property, sharedCollectionPoint, agreement, driver, customer, product }

/** The booked stop's two spellings beside the columns, which resolution-rendering.test.ts reads too. */
export const BOOKED_SHAPE = `(${ref("ticket", "booked_route_id")} is null) = (${ref("ticket", "booked_pickup_id")} is null)`

describe("the stop a ticket is answered by, as drizzle-kit writes it", () => {
  const generated = statementsBetween({ ...referenced, ticket: ticketAsOf("0033") }, { ...referenced, ticket })

  test("the booked route and pickup, a pickup of that route, both or neither, one ticket per stop", async () => {
    assert.deepEqual(await generated, [
      'ALTER TABLE "wms"."ticket" ADD COLUMN "booked_route_id" uuid;',
      'ALTER TABLE "wms"."ticket" ADD COLUMN "booked_pickup_id" uuid;',
      'ALTER TABLE "wms"."ticket" ADD CONSTRAINT "ticket_booked_route_id_booked_pickup_id_fk" FOREIGN KEY ("company_id","project_id","booked_route_id","booked_pickup_id") REFERENCES "wms"."pickup"("company_id","project_id","route_id","id") ON DELETE no action ON UPDATE no action;',
      `CREATE UNIQUE INDEX "ticket_booked_pickup_id_key" ON "wms"."ticket" USING btree ("company_id","booked_pickup_id") WHERE ${ref("ticket", "booked_pickup_id")} is not null;`,
      'CREATE INDEX "ticket_booked_route_id_idx" ON "wms"."ticket" USING btree ("company_id","booked_route_id");',
      `ALTER TABLE "wms"."ticket" ADD CONSTRAINT "ticket_booked_shape" CHECK (${BOOKED_SHAPE});`,
    ])
  })

  test("the shape is the table's", () => {
    assert.equal(checksOf(ticket).get("ticket_booked_shape"), BOOKED_SHAPE)
  })

  test("migration 0035 is exactly those statements", async () => {
    const statements = statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))
    assert.deepEqual(statements, (await generated).map(normalised))
  })
})
