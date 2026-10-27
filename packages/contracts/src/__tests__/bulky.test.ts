// Bulky-waste booking's wire (O11 of #290): a schedule recurs as a route
// scheme does and is patched in its slots, product and end alone; a booking
// names one place, its items within the cap; an availability read names one
// place and a bounded window; and the office's Add stop names a booking alone.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { BULKY_ITEMS_MAX, BULKY_WINDOW_DAYS_MAX, BulkyAvailabilityQuery, BulkyBookingCreate, BulkyBookingPatch, BulkyScheduleCreate, BulkySchedulePatch, ONE_PLACE, WINDOW_TOO_WIDE } from "../bulky"
import { A_BULKY_BOOKING, ONLY_A_BULKY_COLLECTION, PickupAdd, THE_BOOKING_ALONE } from "../pickups"
import { WEEK_ROTATION_WITH_FORTNIGHTLY } from "../route-schemes"

const ID = "01a0d2a4-a280-7001-8000-000000000001"
const OTHER = "01a0d2a4-a280-7001-8000-000000000002"
const issues = (result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) => result.error?.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) ?? []

const SCHEDULE = { projectId: ID, planningAreaId: OTHER, frequency: "weekly", serviceDays: ["tuesday"], slotsPerDay: 12, productId: ID, validFrom: "2027-01-01" }
const BOOKING = { customerId: ID, agreementId: OTHER, propertyId: ID, wasteFractionId: OTHER, day: "2027-03-09", items: [{ description: "Sofa", quantity: 1 }] }

describe("a bulky schedule", () => {
  test("is created with its area, recurrence, slots and product, skipping holidays unless told otherwise", () => {
    assert.deepEqual(BulkyScheduleCreate.parse(SCHEDULE), { ...SCHEDULE, holidayPolicy: "skip" })
  })

  test("takes a week rotation with every-2-weeks and with nothing else, a service day at least, and a slot at least", () => {
    assert.deepEqual(issues(BulkyScheduleCreate.safeParse({ ...SCHEDULE, weekRotation: "odd" })), [{ path: "weekRotation", message: WEEK_ROTATION_WITH_FORTNIGHTLY }])
    assert.equal(BulkyScheduleCreate.safeParse({ ...SCHEDULE, frequency: "every-2-weeks", weekRotation: "even" }).success, true)
    assert.equal(BulkyScheduleCreate.safeParse({ ...SCHEDULE, serviceDays: [] }).success, false)
    assert.equal(BulkyScheduleCreate.safeParse({ ...SCHEDULE, slotsPerDay: 0 }).success, false)
  })

  test("is patched in its slots, product and end alone, and something must change", () => {
    assert.equal(BulkySchedulePatch.safeParse({ slotsPerDay: 8 }).success, true)
    assert.equal(BulkySchedulePatch.safeParse({ frequency: "monthly" }).success, false, "the recurrence is the schedule's key")
    assert.equal(BulkySchedulePatch.safeParse({}).success, false)
  })
})

describe("a bulky booking", () => {
  test("names one place, the agreement, the fraction, the day and its items", () => {
    assert.deepEqual(BulkyBookingCreate.parse(BOOKING), BOOKING)
    assert.deepEqual(issues(BulkyBookingCreate.safeParse({ ...BOOKING, sharedCollectionPointId: OTHER })), [{ path: "propertyId", message: ONE_PLACE }])
    assert.deepEqual(issues(BulkyBookingCreate.safeParse({ ...BOOKING, propertyId: null })), [{ path: "propertyId", message: ONE_PLACE }])
  })

  test("lists an item at least and the cap at most, each with a description and a count", () => {
    assert.equal(BulkyBookingCreate.safeParse({ ...BOOKING, items: [] }).success, false)
    assert.equal(BulkyBookingCreate.safeParse({ ...BOOKING, items: Array.from({ length: BULKY_ITEMS_MAX + 1 }, () => ({ description: "Chair", quantity: 1 })) }).success, false)
    assert.equal(BulkyBookingCreate.safeParse({ ...BOOKING, items: [{ description: " ", quantity: 1 }] }).success, false)
    assert.equal(BulkyBookingCreate.safeParse({ ...BOOKING, items: [{ description: "Chair", quantity: 0 }] }).success, false)
  })

  test("names no area, schedule or product, which are the server's, and a patch moves the day, the items or the note", () => {
    assert.equal(BulkyBookingCreate.safeParse({ ...BOOKING, scheduleId: ID }).success, false)
    assert.equal(BulkyBookingPatch.safeParse({ day: "2027-03-16" }).success, true)
    assert.equal(BulkyBookingPatch.safeParse({ agreementId: ID }).success, false)
  })
})

describe("a bulky availability read", () => {
  test("names one place and a window of the cap at most", () => {
    assert.equal(BulkyAvailabilityQuery.safeParse({ propertyId: ID, from: "2027-03-01", to: "2027-03-31" }).success, true)
    assert.deepEqual(issues(BulkyAvailabilityQuery.safeParse({ from: "2027-03-01", to: "2027-03-31" })), [{ path: "propertyId", message: ONE_PLACE }])
    const last = new Date(Date.UTC(2027, 2, BULKY_WINDOW_DAYS_MAX + 1)).toISOString().slice(0, 10)
    assert.deepEqual(issues(BulkyAvailabilityQuery.safeParse({ propertyId: ID, from: "2027-03-01", to: last })), [{ path: "to", message: WINDOW_TOO_WIDE }])
  })
})

describe("the office's bulky collection", () => {
  test("names its booking alone: the booking says the place and the fraction", () => {
    assert.deepEqual(PickupAdd.parse({ service: "bulky", bulkyBookingId: ID }), { service: "bulky", bulkyBookingId: ID })
    assert.deepEqual(issues(PickupAdd.safeParse({ service: "bulky" })), [{ path: "bulkyBookingId", message: A_BULKY_BOOKING }])
    assert.deepEqual(issues(PickupAdd.safeParse({ service: "bulky", bulkyBookingId: ID, propertyId: OTHER, wasteFractionId: OTHER })), [
      { path: "propertyId", message: THE_BOOKING_ALONE },
      { path: "wasteFractionId", message: THE_BOOKING_ALONE },
    ])
    assert.deepEqual(issues(PickupAdd.safeParse({ containerId: OTHER, bulkyBookingId: ID })), [{ path: "bulkyBookingId", message: ONLY_A_BULKY_COLLECTION }])
  })
})
