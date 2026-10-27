// Bulky-waste booking's words on the web (O11 of #290): the items a dialog
// holds, the days it offers, and a schedule's form as the bodies it becomes.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BulkySchedule } from "@waste/contracts/bulky"

import { mintedRecord } from "../containers"

import { agreementsOfCustomer, bookingRecordOf, dayOption, routesForBooking, itemsOf, itemsSentence, newScheduleForm, periodSentence, recurrenceSentence, scheduleCreateBodyOf, scheduleFormOf, schedulePatchBodyOf, shortDay, slotsSentence } from "../bulky"

const SCHEDULE: BulkySchedule = {
  id: "01a0d2a4-a280-7099-8000-000000000001",
  createdAt: "2027-01-01T08:00:00.000Z",
  updatedAt: "2027-01-01T08:00:00.000Z",
  projectId: "01a0d2a4-a280-7099-8000-000000000002",
  planningAreaId: "01a0d2a4-a280-7099-8000-000000000003",
  frequency: "weekly",
  serviceDays: ["tuesday"],
  weekRotation: null,
  holidayPolicy: "skip",
  slotsPerDay: 12,
  productId: "01a0d2a4-a280-7099-8000-000000000004",
  validFrom: "2027-01-01",
  validTo: null,
}

describe("a booking's items", () => {
  test("are the rows filled in, each with a description and a count from 1 to 100, empty rows left out", () => {
    assert.deepEqual(itemsOf([{ description: " Sofa ", quantity: "1" }, { description: "", quantity: "" }, { description: "Chair", quantity: "2" }]), [
      { description: "Sofa", quantity: 1 },
      { description: "Chair", quantity: 2 },
    ])
    assert.equal(itemsOf([{ description: "", quantity: "" }]), "List an item at least")
    assert.equal(itemsOf([{ description: "", quantity: "2" }]), "Say what each item is")
    assert.equal(itemsOf([{ description: "Sofa", quantity: "0" }]), "Give each item a count from 1 to 100")
    assert.equal(itemsSentence([{ description: "Sofa", quantity: 1 }, { description: "Chair", quantity: 2 }]), "Sofa · 2 × Chair")
  })
})

describe("a day the dialog offers", () => {
  test("names its weekday and its slots left, and a full one is said so and not offered", () => {
    assert.equal(shortDay("2027-03-09"), "Tue 9 Mar")
    assert.deepEqual(dayOption({ day: "2027-03-09", slots: 3, booked: 1, left: 2, planningAreaId: "a", scheduleId: "s" }), { value: "2027-03-09", label: "Tue 9 Mar · 2 of 3 left", disabled: false })
    assert.deepEqual(dayOption({ day: "2027-03-16", slots: 3, booked: 3, left: 0, planningAreaId: "a", scheduleId: "s" }), { value: "2027-03-16", label: "Tue 16 Mar · full", disabled: true })
  })
})

describe("a schedule's form", () => {
  test("becomes the create body, its last day in force the wire's first day out, a fortnight's rotation required", () => {
    const form = { ...newScheduleForm("2027-01-01"), planningAreaId: SCHEDULE.planningAreaId, serviceDays: ["tuesday" as const], slotsPerDay: "12", productId: SCHEDULE.productId, lastDay: "2027-06-30" }
    assert.deepEqual(scheduleCreateBodyOf(SCHEDULE.projectId, form), {
      projectId: SCHEDULE.projectId,
      planningAreaId: SCHEDULE.planningAreaId,
      frequency: "weekly",
      serviceDays: ["tuesday"],
      weekRotation: null,
      holidayPolicy: "skip",
      slotsPerDay: 12,
      productId: SCHEDULE.productId,
      validFrom: "2027-01-01",
      validTo: "2027-07-01",
    })
    assert.deepEqual(scheduleCreateBodyOf(SCHEDULE.projectId, { ...form, frequency: "every-2-weeks" }), { field: "weekRotation", message: "Pick the weeks an every-2-weeks schedule serves" })
    assert.deepEqual(scheduleCreateBodyOf(SCHEDULE.projectId, { ...form, slotsPerDay: "0" }), { field: "slotsPerDay", message: "Give the slots a day as a whole number from 1 to 1000" })
    assert.deepEqual(scheduleCreateBodyOf(SCHEDULE.projectId, { ...form, lastDay: "2026-12-31" }), { field: "lastDay", message: "The last day in force comes on or after the first" })
  })

  test("patches the slots, the product and the end that moved, and nothing where none did", () => {
    const form = scheduleFormOf(SCHEDULE)
    assert.equal(schedulePatchBodyOf(SCHEDULE, form), null)
    assert.deepEqual(schedulePatchBodyOf(SCHEDULE, { ...form, slotsPerDay: "8", lastDay: "2027-03-31" }), { slotsPerDay: 8, validTo: "2027-04-01" })
  })

  test("reads as its days, its slots and its period", () => {
    assert.equal(recurrenceSentence(SCHEDULE), "Every week on Tuesday")
    assert.equal(recurrenceSentence({ frequency: "every-2-weeks", serviceDays: ["thursday", "monday"], weekRotation: "odd" }), "Every 2 weeks on Monday, Thursday, odd weeks")
    assert.equal(slotsSentence(1), "1 slot a day")
    assert.equal(periodSentence({ validFrom: "2027-01-01", validTo: "2027-07-01" }), "2027-01-01 to 2027-06-30")
  })
})

describe("the pickers of a booking", () => {
  const row = (id: string, status: string, values: Record<string, string>) => mintedRecord({ id, name: id, status, recordKind: "Row", values })

  test("offer the customer's signed agreements alone", () => {
    const agreements = [row("agreement-1", "Active", { customerId: "customer-1" }), row("agreement-2", "Draft", { customerId: "customer-1" }), row("agreement-3", "Active", { customerId: "customer-2" })]
    assert.deepEqual(
      agreementsOfCustomer(agreements, "customer-1").map((record) => record.id),
      ["agreement-1"],
    )
    assert.deepEqual(agreementsOfCustomer(agreements, ""), [])
  })

  test("offer the routes of the booking's project running on its day, not started", () => {
    const booking = bookingRecordOf({ projectId: "project-1", customerId: "c", agreementId: "a", propertyId: "p", sharedCollectionPointId: "", wasteFractionId: "f", day: "2027-03-09", items: [{ description: "Sofa", quantity: 1 }], note: "" }, "Parkvej 18", 1)
    const routes = [
      row("route-1", "Planned", { projectId: "project-1", operatingDate: "2027-03-09", status: "planned" }),
      row("route-2", "Ready", { projectId: "project-1", operatingDate: "2027-03-09", status: "ready" }),
      row("route-3", "Active", { projectId: "project-1", operatingDate: "2027-03-09", status: "active" }),
      row("route-4", "Planned", { projectId: "project-1", operatingDate: "2027-03-10", status: "planned" }),
      row("route-5", "Planned", { projectId: "project-2", operatingDate: "2027-03-09", status: "planned" }),
    ]
    assert.deepEqual(
      routesForBooking(routes, booking).map((record) => record.id),
      ["route-1", "route-2"],
    )
  })
})
