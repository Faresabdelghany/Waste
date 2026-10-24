// Book a stop on a ticket (O3c of #290): the route, then Add stop's fields
// with only the services the ticket's kind answers, opened on what the ticket
// is about; the input is Add stop's, naming the ticket.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { PickupAdd } from "@waste/contracts/pickups"

import { NOTHING_RESOLVED, type MappingContext } from "../../api/records/adapter"
import { addedStopBody } from "../../api/records/routes"
import { FIXTURE_COMPANY_ID, type BusinessRecord } from "../business-modules"
import type { BusinessFormSchema } from "../business-form-types"
import { bookableRoutes, bookAStopWaits, bookStopForm, bookStopInput, bookStopValues, NO_ROUTE_TO_BOOK_ON, offersBookAStop } from "../ticket-stops"

const fieldsOf = (schema: BusinessFormSchema) => schema.sections.flatMap((section) => section.fields)
const fieldOf = (schema: BusinessFormSchema, id: string) => fieldsOf(schema).find((field) => field.id === id)
const ROUTES = [{ value: "route-1", label: "RC-1042 · 2026-10-05" }]
const context: MappingContext = { fixtures: [], resolve: NOTHING_RESOLVED, companyRecordId: FIXTURE_COMPANY_ID, now: new Date("2026-10-05T10:00:00Z") }

const ticket = (kind: string, links: Record<string, string> = {}): Pick<BusinessRecord, "submittedValues"> => ({ submittedValues: { kind, status: "open", containerId: "", propertyId: "", sharedCollectionPointId: "", ...links } })

describe("Book a stop", () => {
  test("is offered on an open container request, overflow or container defect, and on no other ticket", () => {
    assert.deepEqual(["container-request", "overflow", "container-defect", "complaint", "missed-collection"].map((kind) => offersBookAStop(kind, "open")), [true, true, true, false, false])
    assert.equal(offersBookAStop("overflow", "completed"), false)
  })

  test("asks for the route first, then Add stop's fields, with only the services the ticket's kind answers", () => {
    const defect = bookStopForm("container-defect", ROUTES)
    assert.equal(fieldsOf(defect)[0].id, "routeId")
    assert.deepEqual(fieldOf(defect, "routeId")?.options, ROUTES)
    assert.equal(fieldOf(defect, "routeId")?.required, true)
    assert.deepEqual(fieldOf(defect, "service")?.options?.map((option) => option.value), ["swap", "repair"])
    assert.deepEqual(fieldOf(defect, "stopAt")?.options?.map((option) => option.value), ["container"], "every work order is of a container")
    assert.deepEqual(fieldOf(bookStopForm("container-request", ROUTES), "service")?.options?.map((option) => option.value), ["deliver"])
    const overflow = bookStopForm("overflow", ROUTES)
    assert.deepEqual(fieldOf(overflow, "service")?.options?.map((option) => option.value), ["empty"])
    assert.deepEqual(fieldOf(overflow, "stopAt")?.options?.map((option) => option.value), ["container", "property", "shared-point"], "an emptying may be at an address")
    assert.equal(defect.title, "Book a stop")
    assert.equal(fieldOf(bookStopForm("overflow", []), "routeId")?.description, NO_ROUTE_TO_BOOK_ON, "no route to book on says so")
  })

  test("says why it waits: the routes still being read, or a role that reads none", () => {
    assert.equal(bookAStopWaits({ status: "ready" }), undefined)
    assert.equal(bookAStopWaits({ status: "loading" }), "Reading the routes a stop may be booked on…")
    assert.equal(bookAStopWaits({ status: "not-granted" }), "Your role does not see the routes a stop is booked on.")
    assert.equal(bookAStopWaits(null), "Your role does not see the routes a stop is booked on.")
  })

  test("opens on what the ticket is about: a defect's container, an overflow's container or else its place; a request's container is the one delivered, picked", () => {
    assert.deepEqual(bookStopValues(ticket("container-defect", { containerId: "asset-1", propertyId: "property-1" })), { service: "repair", stopAt: "container", containerId: "asset-1" })
    assert.deepEqual(bookStopValues(ticket("overflow", { containerId: "asset-1" })), { service: "empty", stopAt: "container", containerId: "asset-1" })
    assert.deepEqual(bookStopValues(ticket("overflow", { propertyId: "property-1" })), { service: "empty", stopAt: "property", propertyId: "property-1" })
    assert.deepEqual(bookStopValues(ticket("overflow", { sharedCollectionPointId: "shared-point-1" })), { service: "empty", stopAt: "shared-point", sharedCollectionPointId: "shared-point-1" })
    assert.deepEqual(bookStopValues(ticket("container-request", { containerId: "asset-1", propertyId: "property-1" })), { service: "deliver", stopAt: "container" })
  })

  test("sends Add stop's input to the route picked, naming the ticket: the body the contract takes", () => {
    const bin = "01a0d2a4-a280-7015-8000-000000000009"
    const ticketId = "01a0d2a4-a280-7040-8000-000000000001"
    const { routeId, input } = bookStopInput({ routeId: "route-1", service: "repair", stopAt: "container", containerId: `asset-${bin}` }, `ticket-${ticketId}`)
    assert.equal(routeId, "route-1")
    const body = addedStopBody(input, context)
    assert.deepEqual(body, { service: "repair", containerId: bin, ticketId })
    assert.ok(PickupAdd.safeParse(body).success)
  })

  test("offers the ticket's project's routes that have not started, by label and day", () => {
    const route = (id: string, status: string, projectId: string, operatingDate: string) => ({ id, name: `RC-${id}`, status, projectIds: [projectId], submittedValues: { operatingDate } }) as unknown as BusinessRecord
    const routes = [route("1", "Planned", "project-a", "2026-10-06"), route("2", "Ready", "project-a", "2026-10-05"), route("3", "Active", "project-a", "2026-10-05"), route("4", "Planned", "project-b", "2026-10-05")]
    assert.deepEqual(bookableRoutes(routes, "project-a"), [
      { value: "2", label: "RC-2 · 2026-10-05" },
      { value: "1", label: "RC-1 · 2026-10-06" },
    ])
  })
})
