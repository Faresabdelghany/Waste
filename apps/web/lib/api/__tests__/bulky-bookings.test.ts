// Bulky Bookings on the adapter (O11 of #290): a booking becomes a record of
// `operate.bulky-bookings` — named by its place and day, its items in one
// line, its stop's route, the wire status and the server id beside the
// form's values for its commands — and the row the booking dialog makes
// becomes the body the API's contracts accept, held here against their zod
// schemas. A patch moves the day, the items and the note alone; Route names
// a route the store holds.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { BulkyBookingCreate, BulkyBookingPatch, type BulkyBooking } from "@waste/contracts/bulky"

import { COMMAND_SURFACES } from "@/components/waste/commands/command-surfaces"

import { BULKY_BOOKINGS_MODULE, BULKY_ITEMS_KEY, bookingMoves, bookingRecordOf } from "../../data/bulky"
import { FIXTURE_COMPANY_ID, getModuleDefinition, type BusinessRecord } from "../../data/business-modules"
import { NOTHING_RESOLVED, isLocalRefusal, type MappingContext } from "../records/adapter"
import { BULKY_BOOKING_COMMANDS, bulkyBookingAdapter, itemsOfRecord, ROUTE_BOOKING, toBulkyBookingCreateBody, toBulkyBookingPatchBody, toBulkyBookingRecord } from "../records/bulky-bookings"
import { isServerBacked } from "../records/modules"

const NOW = new Date("2027-03-01T12:00:00Z")
const STAMPS = { createdAt: "2027-03-01T09:00:00.000Z", updatedAt: "2027-03-01T09:30:00.000Z" }
const id = (n: number) => `01a0d2a4-a280-7050-8000-0000000000${String(n).padStart(2, "0")}`

const booked: BulkyBooking = {
  id: id(1),
  ...STAMPS,
  projectId: id(2),
  customerId: id(3),
  agreementId: id(4),
  propertyId: id(5),
  sharedCollectionPointId: null,
  wasteFractionId: id(6),
  day: "2027-03-09",
  items: [
    { description: "Sofa", quantity: 1 },
    { description: "Chair", quantity: 2 },
  ],
  note: "Behind the gate",
  status: "booked",
  planningAreaId: id(7),
  scheduleId: id(8),
  productId: id(9),
  stop: null,
  bookedBy: id(10),
  cancelledAt: null,
  cancelledBy: null,
  cancelReason: null,
}
const routed: BulkyBooking = { ...booked, status: "routed", stop: { pickupId: id(11), routeId: id(12), status: "planned" } }

const context: MappingContext = { fixtures: getModuleDefinition(BULKY_BOOKINGS_MODULE)?.records ?? [], resolve: NOTHING_RESOLVED, companyRecordId: FIXTURE_COMPANY_ID, now: NOW }

describe("a bulky booking as a record", () => {
  test("is the module's on the API, `bulky-booking-<uuid>`, named by its place and day, its items in one line", () => {
    assert.ok(isServerBacked("operate", "bulky-bookings"))
    const record = toBulkyBookingRecord(booked, context)
    assert.equal(record.id, `bulky-booking-${booked.id}`)
    assert.equal(record.name, `Bulky collection · property-${id(5)} · Tue 9 Mar`)
    assert.deepEqual([record.status, record.value, record.description], ["Booked", "2027-03-09", "Sofa · 2 × Chair"])
    assert.deepEqual(itemsOfRecord(record), booked.items)
    assert.ok(bulkyBookingAdapter.owns(record))
    assert.ok(bulkyBookingAdapter.owns({ ...record, id: "bulky-bookings-bulky-booking-1793088183182" }), "a row the dialog has just made, by its recordKind")
    assert.ok(bookingMoves(record))
    const routedRecord = toBulkyBookingRecord(routed, context)
    assert.deepEqual([routedRecord.status, routedRecord.facts?.Route, bookingMoves(routedRecord)], ["Routed", `route-${id(12)}`, false])
    const surface = COMMAND_SURFACES["operate.bulky-bookings"]
    assert.ok(typeof surface.primary === "function" && surface.rowActions !== undefined, "its own dialog, moved by its commands")
  })
})

describe("the row the booking dialog makes", () => {
  const made = bookingRecordOf(
    {
      projectId: `project-${id(2)}`,
      customerId: `customer-${id(3)}`,
      agreementId: `agreement-${id(4)}`,
      propertyId: `property-${id(5)}`,
      sharedCollectionPointId: "",
      wasteFractionId: `fraction-${id(6)}`,
      day: "2027-03-09",
      items: booked.items,
      note: " Behind the gate ",
    },
    "Parkvej 18",
    1_793_088_183_182,
  )

  test("becomes the create body the contracts take, every id the server's", () => {
    const body = toBulkyBookingCreateBody(made, context)
    assert.ok(!isLocalRefusal(body))
    assert.deepEqual(BulkyBookingCreate.parse(body), { customerId: id(3), agreementId: id(4), propertyId: id(5), wasteFractionId: id(6), day: "2027-03-09", items: booked.items, note: "Behind the gate" })
    assert.equal(made.name, "Bulky collection · Parkvej 18 · Tue 9 Mar")
  })

  test("is refused locally without a place or with no item, before the API sees it", () => {
    const placeless: BusinessRecord = { ...made, submittedValues: { ...made.submittedValues, propertyId: "" } }
    assert.deepEqual(toBulkyBookingCreateBody(placeless, context), { path: "propertyId", message: "Pick the property or the shared point, one of the two" })
    const itemless: BusinessRecord = { ...made, submittedValues: { ...made.submittedValues, [BULKY_ITEMS_KEY]: "[]" } }
    assert.deepEqual(toBulkyBookingCreateBody(itemless, context), { path: "items", message: "List an item at least" })
  })
})

describe("a booking changed", () => {
  const record = toBulkyBookingRecord(booked, context)
  const after = (values: Record<string, string>): BusinessRecord => ({ ...record, submittedValues: { ...record.submittedValues, ...values } })

  test("patches the day, the items and the note that moved, and nothing where none did", () => {
    assert.equal(toBulkyBookingPatchBody(record, record), null)
    const body = toBulkyBookingPatchBody(record, after({ day: "2027-03-16", [BULKY_ITEMS_KEY]: JSON.stringify([{ description: "Fridge", quantity: 1 }]) }))
    assert.deepEqual(BulkyBookingPatch.parse(body), { day: "2027-03-16", items: [{ description: "Fridge", quantity: 1 }] })
  })

  test("keeps its customer, place, agreement and fraction: another is another booking", () => {
    const moved = toBulkyBookingPatchBody(record, after({ agreementId: `agreement-${id(20)}` }))
    assert.ok(isLocalRefusal(moved) && moved.path === "agreementId")
  })

  test("is routed onto a route the store holds, by the server's id", () => {
    const toBody = BULKY_BOOKING_COMMANDS[ROUTE_BOOKING].toBody
    assert.deepEqual(toBody?.({ routeId: "route-unknown" }, record, context), { path: "routeId", message: "Pick a route of the booking's day" })
    const resolving: MappingContext = { ...context, resolve: { ...NOTHING_RESOLVED, serverIdOf: (webId) => (webId === "route-held" ? id(12) : undefined) } }
    assert.deepEqual(toBody?.({ routeId: "route-held" }, record, resolving), { routeId: id(12) })
    assert.deepEqual(BULKY_BOOKING_COMMANDS[ROUTE_BOOKING].touches, ["route-studio.routes", "route-studio.pickups"])
  })
})
