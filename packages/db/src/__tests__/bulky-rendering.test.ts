// Bulky-waste booking (O11 of #290) as drizzle-kit writes it: the three new
// tables — an area's schedules, the bookings and their items — and the
// pickup's bulky collection, diffed from the pickup as 0038 left it
// (pickup-as-of.ts), since an applied file is never edited. Then migration
// 0053, which is exactly those statements, then what the three owe the file
// by migrations/README.md: each one's fence and trigger, the schedule's
// exclusion constraint over its area, and the audit trail of the three
// (`BULKY_AUDITED`). No database.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { MIGRATIONS_FOLDER } from "../migrate"
import { userAccount } from "../schema/access"
import { agreement, subscription } from "../schema/agreements"
import { bulkyBooking, bulkyBookingItem, bulkySchedule } from "../schema/bulky"
import { product, wasteFraction } from "../schema/catalogue"
import { container } from "../schema/containers"
import { customer, property, sharedCollectionPoint } from "../schema/customers"
import { route } from "../schema/execution"
import { company, project } from "../schema/organisation"
import { contaminantCode } from "../schema/pickup-exceptions"
import { warehouse } from "../schema/places"
import { planningArea } from "../schema/planning-areas"
import { auditTrail, BULKY_AUDITED } from "../sql/audit-trail"
import { excludeOverlapping } from "../sql/exclude-overlapping"
import { handWrittenStatements, normalised, statementsOf } from "../sql/hand-written"
import { checksOf, ref } from "./rendering"
import { pickupAsOf0038, pickupAsOf0053 } from "./pickup-as-of"
import { statementsBetween } from "./specimen"

const MIGRATION = "0053_bulky_booking.sql"

const referenced = { company, project, route, container, property, sharedCollectionPoint, wasteFraction, product, userAccount, customer, agreement, subscription, warehouse, planningArea, contaminantCode }
const created = { bulkyBooking, bulkyBookingItem, bulkySchedule }

/** What drizzle-kit writes for 0053: the three tables, and the pickup from its 0038 spelling to its 0053 one, since 0055 moved it on (O23 of #290). */
const generated = (): Promise<string[]> => statementsBetween({ ...referenced, pickup: pickupAsOf0038 }, { ...referenced, pickup: pickupAsOf0053, ...created })

/** What the three owe the file below drizzle-kit's statements: fence and trigger each, the schedule's exclusion constraint, then their audit trail. */
const handWritten = [...Object.values(created).flatMap((table) => handWrittenStatements(table)), ...excludeOverlapping(bulkySchedule, [bulkySchedule.planningAreaId]), ...BULKY_AUDITED.flatMap(auditTrail)]

const fileStatements = async (): Promise<string[]> => statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))

describe("the bulky booking as drizzle-kit writes it", () => {
  test("the pickup gains the booking it collects, the bulky service, an address-only stop that collects one, and one live stop per booking", async () => {
    const statements = await generated()
    for (const expected of [
      'ALTER TABLE "wms"."pickup" ADD COLUMN "bulky_booking_id" uuid;',
      'ALTER TABLE "wms"."pickup" DROP CONSTRAINT "pickup_service_one_of";',
      'ALTER TABLE "wms"."pickup" DROP CONSTRAINT "pickup_service_container_shape";',
      `ALTER TABLE "wms"."pickup" ADD CONSTRAINT "pickup_service_one_of" CHECK (${ref("pickup", "service")} in ('empty', 'deliver', 'remove', 'swap', 'repair', 'wash', 'bulky'));`,
      `ALTER TABLE "wms"."pickup" ADD CONSTRAINT "pickup_service_container_shape" CHECK (${ref("pickup", "service")} in ('empty', 'bulky') or ${ref("pickup", "container_id")} is not null);`,
      `ALTER TABLE "wms"."pickup" ADD CONSTRAINT "pickup_bulky_shape" CHECK ((${ref("pickup", "service")} = 'bulky') = (${ref("pickup", "bulky_booking_id")} is not null) and (${ref("pickup", "service")} <> 'bulky' or ${ref("pickup", "container_id")} is null));`,
      'ALTER TABLE "wms"."pickup" ADD CONSTRAINT "pickup_bulky_booking_id_fk" FOREIGN KEY ("company_id","project_id","bulky_booking_id") REFERENCES "wms"."bulky_booking"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;',
      `CREATE UNIQUE INDEX "pickup_bulky_booking_id_key" ON "wms"."pickup" USING btree ("company_id","bulky_booking_id") WHERE ${ref("pickup", "bulky_booking_id")} is not null and ${ref("pickup", "status")} in ('planned', 'completed');`,
      'CREATE INDEX "pickup_bulky_booking_id_idx" ON "wms"."pickup" USING btree ("company_id","bulky_booking_id");',
    ]) {
      assert.ok(statements.includes(expected), expected)
    }
  })

  test("a schedule recurs as a route scheme does, with its slots positive; a booking names one place and is cancelled by its instant and reason together", () => {
    const schedule = checksOf(bulkySchedule)
    assert.equal(schedule.get("bulky_schedule_week_rotation_shape"), `(${ref("bulky_schedule", "frequency")} = 'every-2-weeks') = (${ref("bulky_schedule", "week_rotation")} is not null)`)
    assert.equal(schedule.get("bulky_schedule_slots_per_day_positive"), `${ref("bulky_schedule", "slots_per_day")} > 0`)
    const booking = checksOf(bulkyBooking)
    assert.equal(
      booking.get("bulky_booking_cancel_shape"),
      `(${ref("bulky_booking", "cancelled_at")} is null) = (${ref("bulky_booking", "cancel_reason")} is null) and (${ref("bulky_booking", "cancelled_by")} is null or ${ref("bulky_booking", "cancelled_at")} is not null)`,
    )
    assert.ok(booking.has("bulky_booking_place_exactly_one"))
  })

  test("one schedule of an area is in force at a time: one exclusion constraint over the area and the period", () => {
    assert.deepEqual(excludeOverlapping(bulkySchedule, [bulkySchedule.planningAreaId]), [
      `ALTER TABLE "wms"."bulky_schedule" ADD CONSTRAINT "bulky_schedule_no_overlap" EXCLUDE USING gist ("company_id" WITH =, "planning_area_id" WITH =, daterange("valid_from", "valid_to", '[)') WITH &&);`,
    ])
  })
})

describe("migration 0053", () => {
  test("begins with exactly what drizzle-kit generates for it, whatever order its loader gave the tables", async () => {
    const statements = await fileStatements()
    const head = (await generated()).map(normalised).sort()
    assert.deepEqual([...statements.slice(0, head.length)].sort(), head)
  })

  test("and carries below them the three tables' fences and triggers, the schedule's exclusion constraint and the three audit trails, in that order", async () => {
    const statements = await fileStatements()
    const head = (await generated()).length
    assert.deepEqual(statements.slice(head), handWritten.map(normalised))
    assert.equal(BULKY_AUDITED.length, 3, "the schedules, the bookings and their items")
  })
})
