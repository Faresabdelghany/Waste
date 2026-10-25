// The ticket_booking ledger (#422) as drizzle-kit writes it: every stop a
// ticket booked, the ticket and the stop of its project, one ticket per stop,
// a ticket's bookings in order. The migration is exactly drizzle-kit's
// statements, then the backfill of each ticket's current booking
// (src/sql/ticket-booking.ts), then the ledger's fence and revoke, and no
// trigger (EXEMPT in the audit trail). The file is found by its name, not its
// number, which it takes at its turn. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { MIGRATIONS_FOLDER } from "../migrate"
import { pickup } from "../schema/execution"
import { company, project } from "../schema/organisation"
import { ticket, ticketBooking } from "../schema/resolution"
import { AUDITED_TABLE_NAMES } from "../sql/audit-trail"
import { handWrittenStatements, normalised, statementsOf } from "../sql/hand-written"
import { ticketBookingBackfill } from "../sql/ticket-booking"
import { columns, COMPANY, companyFk, foreignKey, ID, index, PROJECT, projectFk, projectFkTo } from "./rendering"
import { statementsBetween } from "./specimen"

const RECORDED = '"recorded_at" timestamp with time zone DEFAULT now() NOT NULL'

const referenced = { company, project, ticket, pickup }

const generated = () => statementsBetween(referenced, { ...referenced, ticketBooking })

/** The migration, by its name: it takes its number at its turn. */
async function migration(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_ticket_booking\.sql$/.test(name))
  assert.ok(file !== undefined, "the ticket booking's migration")
  return readFile(join(MIGRATIONS_FOLDER, file), "utf8")
}

describe("the ticket_booking ledger as drizzle-kit writes it", () => {
  test("every column, key and index: the ticket and the stop of its project, one ticket per stop, a ticket's bookings in order", async () => {
    assert.deepEqual((await generated()).sort(), [
      ['CREATE TABLE "wms"."ticket_booking" (', [ID, COMPANY, PROJECT, RECORDED, '"ticket_id" uuid NOT NULL', '"route_id" uuid NOT NULL', '"pickup_id" uuid NOT NULL'].map((line) => `\t${line}`).join(",\n"), ");", ""].join("\n"),
      companyFk("ticket_booking"),
      projectFk("ticket_booking"),
      projectFkTo("ticket_booking", "ticket_id", "ticket"),
      foreignKey("ticket_booking", "ticket_booking_route_id_pickup_id_fk", ["company_id", "project_id", "route_id", "pickup_id"], "pickup", ["company_id", "project_id", "route_id", "id"]),
      `CREATE UNIQUE INDEX "ticket_booking_pickup_id_key" ON "wms"."ticket_booking" USING btree (${columns("company_id", "pickup_id")});`,
      index("ticket_booking", "ticket_booking_ticket_id_idx", "company_id", "ticket_id", "id"),
      index("ticket_booking", "ticket_booking_project_id_idx", "company_id", "project_id"),
    ].sort())
  })

  test("the migration is exactly drizzle-kit's statements, the backfill, then the ledger's fence and revoke, and no trigger", async () => {
    const text = await migration()
    assert.deepEqual(statementsOf(text), [...(await generated()), ticketBookingBackfill(), ...handWrittenStatements(ticketBooking)].map(normalised))
    assert.doesNotMatch(text, /CREATE TRIGGER/)
    assert.ok(!AUDITED_TABLE_NAMES.has("ticket_booking"), "a ledger: its rows are its own history")
  })

  test("its header says plainly that a booking replaced before it is not recorded", async () => {
    assert.match(await migration(), /^-- A booking a rebooking replaced before it is not recorded/m)
  })

  test("the backfill gives each ticket booked for a stop one row, from the ticket's own columns", () => {
    assert.match(ticketBookingBackfill(), /SELECT t\."company_id", t\."project_id", t\."id", t\."booked_route_id", t\."booked_pickup_id" FROM "wms"\."ticket" AS t WHERE t\."booked_pickup_id" IS NOT NULL;$/)
  })
})
