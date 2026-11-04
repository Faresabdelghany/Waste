// Bulky-waste booking (O11 of #290): a schedule's days are its occurrences —
// skipped ones dropped, shifted ones on the day they moved to — clipped to its
// half-open period, each with its slots left; a day is bookable after today
// with a slot left; and a booking's status is its stamp and its stop.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { PRODUCT_UNITS } from "../../registry/vocabulary"
import { bulkyBookingStatus, bulkyDays, bulkyQuantity, dayFull, isBulkyProductUnit, notABulkyDay, notAfterToday, onlyABookedBooking, refuseBulkyDay, type BulkySchedule } from "../bulky"
import { NO_HOLIDAYS, type SchemeCalendar } from "../../route-schemes/occurrences"

const SCHEDULE: BulkySchedule = { frequency: "weekly", serviceDays: ["tuesday"], weekRotation: null, holidayPolicy: "skip", validFrom: "2027-03-01", validTo: null, slotsPerDay: 3 }
const CALENDAR: SchemeCalendar = { holidays: NO_HOLIDAYS, weekend: ["saturday", "sunday"] }

describe("a bulky schedule's days", () => {
  test("are its weekdays in the window, each with its slots and how many are left", () => {
    const days = bulkyDays(SCHEDULE, CALENDAR, { from: "2027-03-01", to: "2027-03-16" }, new Map([["2027-03-09", 2], ["2027-03-16", 5]]))
    assert.deepEqual(days, [
      { day: "2027-03-02", slots: 3, booked: 0, left: 3 },
      { day: "2027-03-09", slots: 3, booked: 2, left: 1 },
      { day: "2027-03-16", slots: 3, booked: 5, left: 0 },
    ])
  })

  test("are clipped to the period: none before it starts, none from its first day out of force", () => {
    const days = bulkyDays({ ...SCHEDULE, validFrom: "2027-03-05", validTo: "2027-03-16" }, CALENDAR, { from: "2027-03-01", to: "2027-03-31" }, new Map())
    assert.deepEqual(
      days.map((row) => row.day),
      ["2027-03-09"],
    )
  })

  test("drop a holiday under skip, and offer it on the day it moved to under a shift", () => {
    const calendar: SchemeCalendar = { holidays: new Map([["2027-03-09", "Holiday"]]), weekend: ["saturday", "sunday"] }
    const window = { from: "2027-03-01", to: "2027-03-16" }
    assert.deepEqual(
      bulkyDays(SCHEDULE, calendar, window, new Map()).map((row) => row.day),
      ["2027-03-02", "2027-03-16"],
    )
    assert.deepEqual(
      bulkyDays({ ...SCHEDULE, holidayPolicy: "shift-next" }, calendar, window, new Map()).map((row) => row.day),
      ["2027-03-02", "2027-03-10", "2027-03-16"],
    )
  })

  test("offer a day a shift carried into the window from a date outside it", () => {
    const calendar: SchemeCalendar = { holidays: new Map([["2027-03-09", "Holiday"]]), weekend: ["saturday", "sunday"] }
    assert.deepEqual(
      bulkyDays({ ...SCHEDULE, holidayPolicy: "shift-next" }, calendar, { from: "2027-03-10", to: "2027-03-10" }, new Map()).map((row) => row.day),
      ["2027-03-10"],
    )
  })

  test("serve an every-2-weeks rotation on its parity alone", () => {
    const odd = bulkyDays({ ...SCHEDULE, frequency: "every-2-weeks", weekRotation: "odd" }, CALENDAR, { from: "2027-03-01", to: "2027-03-31" }, new Map())
    const even = bulkyDays({ ...SCHEDULE, frequency: "every-2-weeks", weekRotation: "even" }, CALENDAR, { from: "2027-03-01", to: "2027-03-31" }, new Map())
    assert.equal(odd.length + even.length, 5)
    assert.ok(odd.length > 0 && even.length > 0)
  })
})

describe("a day a booking may take", () => {
  const days = bulkyDays(SCHEDULE, CALENDAR, { from: "2027-03-01", to: "2027-03-16" }, new Map([["2027-03-16", 3]]))

  test("comes after today, is one of the schedule's, and has a slot left, judged in that order", () => {
    assert.equal(refuseBulkyDay(days, "2027-03-09", "2027-03-03"), undefined)
    assert.equal(refuseBulkyDay(days, "2027-03-02", "2027-03-02"), notAfterToday("2027-03-02"))
    assert.equal(refuseBulkyDay(days, "2027-03-10", "2027-03-03"), notABulkyDay("2027-03-10"))
    assert.equal(refuseBulkyDay(days, "2027-03-16", "2027-03-03"), dayFull("2027-03-16"))
  })
})

describe("a booking's status", () => {
  test("is cancelled by its stamp, routed by a planned stop, collected by a completed one, and booked otherwise", () => {
    assert.equal(bulkyBookingStatus({ cancelledAt: "2027-03-01T10:00:00Z", stopStatus: null }), "cancelled")
    assert.equal(bulkyBookingStatus({ cancelledAt: null, stopStatus: "planned" }), "routed")
    assert.equal(bulkyBookingStatus({ cancelledAt: null, stopStatus: "completed" }), "collected")
    assert.equal(bulkyBookingStatus({ cancelledAt: null, stopStatus: null }), "booked")
  })

  test("refuses a command in a sentence that says what to do", () => {
    assert.equal(onlyABookedBooking("routed", "cancel"), "The booking is routed already; take its stop off the route before it can be cancelled")
    assert.equal(onlyABookedBooking("collected", "change"), "The booking is collected; only a booked one can be changed")
  })
})

describe("what a collected booking is charged (#449)", () => {
  test("a product sold by the item is charged the items' count, the sum of the lines; one sold by the job is the booking once", () => {
    const items = [{ quantity: 1 }, { quantity: 2 }, { quantity: 4 }]
    assert.equal(bulkyQuantity("item", items), 7)
    assert.equal(bulkyQuantity("job", items), 1)
  })

  test("a bulky collection is charged at a product sold by the job or by the item, and by no other unit", () => {
    assert.deepEqual(PRODUCT_UNITS.filter(isBulkyProductUnit), ["job", "item"])
  })
})
