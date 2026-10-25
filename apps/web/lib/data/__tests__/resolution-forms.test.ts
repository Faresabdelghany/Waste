// The tickets' and the alerts' forms on the Pilot (Issue #182, for #147):
// every dialog names its fields by the keys the adapter reads, so what a
// person fills in is the body the contract accepts — held here through the
// adapters themselves — and the lists' categories read a row for the person
// looking, "Mine" for `/me`'s own tickets alone.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { AlertCreate, AlertLinkTicket, AlertResolve } from "@waste/contracts/alerts"
import type { Project } from "@waste/contracts/organisation"
import { TicketAssign, TicketComplete, TicketCreate, TicketHold, TicketReject, TicketReopen, TicketWait, type Ticket } from "@waste/contracts/tickets"

import { NOTHING_RESOLVED, type MappingContext } from "../../api/records/adapter"
import { alertAdapter, LINK_ALERT_TICKET, RESOLVE_ALERT } from "../../api/records/alerts"
import { projectAdapter } from "../../api/records/organisation"
import { loaded, resolverOver, type ServerRecordsState } from "../../api/records/server-records"
import { ASSIGNEE_ACCOUNT_KEY, ticketAdapter } from "../../api/records/tickets"
import { ALERT_COMMAND_FORMS, ALERT_FORM, ALERT_LIST_INITIAL, alertListReaders, createAlertRecord, ticketValuesOfAlert } from "../alerts"
import type { BusinessFormSchema, BusinessFormValues } from "../business-form-types"
import { FIXTURE_COMPANY_ID, type BusinessRecord } from "../business-modules"
import { NO_ONE } from "../properties"
import { createTicketRecord, MINE, opennessOf, recollectionStopOptions, TICKET_COMMAND_FORMS, TICKET_EDIT_FORM, TICKET_FORM, TICKET_LIST_INITIAL, ticketListReaders, updateTicketRecord } from "../tickets"

const NOW = new Date("2026-10-01T10:00:00Z")
const STAMPS = { createdAt: "2026-10-01T08:00:00.000Z", updatedAt: "2026-10-01T08:00:00.000Z" }
const copenhagen: Project = { id: "01a0d2a4-a280-7002-8000-000000000001", ...STAMPS, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active", weekend: ["saturday", "sunday"], holidayList: "Danish public holidays", publicSlug: null, weightTolerancePercent: 5, paymentTermsDays: 30, paymentReferenceScheme: "none", holdForReview: false }
const projectRecord = projectAdapter.toRecord(copenhagen, { fixtures: [], resolve: NOTHING_RESOLVED, companyRecordId: FIXTURE_COMPANY_ID, now: NOW })

const ids = {
  user: "01a0d2a4-a280-7004-8000-000000000001",
  route: "01a0d2a4-a280-7030-8000-000000000001",
  pickup: "01a0d2a4-a280-7033-8000-000000000001",
  container: "01a0d2a4-a280-7020-8000-000000000001",
  customer: "01a0d2a4-a280-7003-8000-000000000001",
  property: "01a0d2a4-a280-7021-8000-000000000001",
  point: "01a0d2a4-a280-7022-8000-000000000001",
  agreement: "01a0d2a4-a280-7023-8000-000000000001",
  driver: "01a0d2a4-a280-7014-8000-000000000001",
  vehicle: "01a0d2a4-a280-7013-8000-000000000001",
  ticket: "01a0d2a4-a280-7040-8000-000000000001",
  alert: "01a0d2a4-a280-7041-8000-000000000001",
  product: "01a0d2a4-a280-700a-8000-000000000005",
}
const row = (id: string, recordKind: string): BusinessRecord => ({ ...projectRecord, id, name: id, recordKind, facts: {}, submittedValues: {} })
const rows: Array<[string, BusinessRecord, string]> = [
  ["configure.organization", projectRecord, copenhagen.id],
  ["configure.access", row(`user-${ids.user}`, "User"), ids.user],
  ["route-studio.routes", row(`route-${ids.route}`, "Route"), ids.route],
  ["route-studio.pickups", row(`pickup-${ids.pickup}`, "Pickup"), ids.pickup],
  ["resources.containers", row(`asset-${ids.container}`, "Container"), ids.container],
  // An organisation is `company-<uuid>` as the registry's adapter makes it, and no tenant company.
  ["customers.contacts", row(`company-${ids.customer}`, "Contact or Customer Organization"), ids.customer],
  ["customers.properties", row(`property-${ids.property}`, "Property"), ids.property],
  ["customers.shared", row(`shared-point-${ids.point}`, "Shared collection point"), ids.point],
  ["customers.agreements", row(`agreement-${ids.agreement}`, "Agreement"), ids.agreement],
  ["fleet.drivers", row(`driver-${ids.driver}`, "Driver"), ids.driver],
  ["fleet.vehicles", row(`vehicle-${ids.vehicle}`, "Vehicle"), ids.vehicle],
  ["operate.tickets", row(`ticket-${ids.ticket}`, "Ticket"), ids.ticket],
  ["operate.exceptions", row(`alert-${ids.alert}`, "Alert"), ids.alert],
  ["commercial.products", row(`product-${ids.product}`, "Product"), ids.product],
]
const state: ServerRecordsState = new Map(rows.map(([key, record, serverId]) => [key, loaded({ records: [record], serverIds: new Map([[record.id, serverId]]) }, 1)]))
const context: MappingContext = { fixtures: [], resolve: resolverOver(state), companyRecordId: FIXTURE_COMPANY_ID, now: NOW }
const web = (key: string) => rows.find(([module]) => module === key)?.[1].id ?? ""

const fieldIdsOf = (schema: BusinessFormSchema) => schema.sections.flatMap((section) => section.fields.map((field) => field.id))

describe("New ticket", () => {
  const filled: BusinessFormValues = {
    projectId: projectRecord.id,
    subject: "Overflowing glass bank",
    description: "Glass above the rim",
    kind: "overflow",
    priority: "high",
    source: "email",
    occurredAt: "2026-10-01T09:15",
    dueAt: "2026-10-01T16:00",
    assigneeUserAccountId: web("configure.access"),
    routeId: web("route-studio.routes"),
    pickupId: web("route-studio.pickups"),
    answerFromRecord: false,
    containerId: web("resources.containers"),
    customerId: web("customers.contacts"),
    propertyId: web("customers.properties"),
    sharedCollectionPointId: web("customers.shared"),
    agreementId: web("customers.agreements"),
    driverId: web("fleet.drivers"),
  }

  test("names exactly the fields TicketCreate carries, and every one reaches the body", () => {
    assert.deepEqual(new Set(fieldIdsOf(TICKET_FORM)), new Set(Object.keys(filled)))
    const body = ticketAdapter.toCreateBody?.(createTicketRecord(filled, { now: 1 }), context) as Record<string, unknown>
    assert.ok(TicketCreate.safeParse(body).success, JSON.stringify(body))
    assert.deepEqual(body.links, { routeId: ids.route, pickupId: ids.pickup, containerId: ids.container, propertyId: ids.property, sharedCollectionPointId: ids.point, customerId: ids.customer, agreementId: ids.agreement, driverId: ids.driver })
    assert.equal(body.assigneeUserAccountId, ids.user)
    assert.equal(body.answerFromRecord, false, "the opt-out reaches the body")
  })

  test("with its required fields alone is a body too: the defaults are the API's", () => {
    const body = ticketAdapter.toCreateBody?.(createTicketRecord({ projectId: projectRecord.id, subject: "A task", description: "Check the gate", kind: "internal-task" }, { now: 1 }), context)
    assert.deepEqual(body, { projectId: copenhagen.id, subject: "A task", description: "Check the gate", kind: "internal-task" })
    assert.ok(TicketCreate.safeParse(body).success)
  })

  test("the edit names the case's own words and its patch is the contracts'", () => {
    assert.deepEqual(fieldIdsOf(TICKET_EDIT_FORM), ["subject", "description"])
  })
})

describe("the ticket's command dialogs", () => {
  const ticket: Ticket = { id: ids.ticket, ...STAMPS, projectId: copenhagen.id, number: 1001, label: "T-1001", kind: "other", status: "open", priority: "none", source: "office", subject: "A task", description: "Check the gate", occurredAt: STAMPS.createdAt, dueAt: null, assigneeUserAccountId: null, createdBy: null, sourceEventId: null, links: { routeId: null, pickupId: null, containerId: null, propertyId: null, sharedCollectionPointId: null, customerId: null, agreementId: null, driverId: null, parentTicketId: null }, resolution: null, recollectionRouteId: null, recollectionPickupId: null, chargeProductId: null, closedAt: null, bookedRouteId: null, bookedPickupId: null }
  const record = ticketAdapter.toRecord(ticket, context)
  const filled: Record<keyof typeof TICKET_COMMAND_FORMS, [BusinessFormValues, { safeParse: (body: unknown) => { success: boolean } }]> = {
    assign: [{ assigneeUserAccountId: web("configure.access"), note: "Taking it" }, TicketAssign],
    wait: [{ note: "The gate code" }, TicketWait],
    hold: [{ note: "A crane" }, TicketHold],
    complete: [{ resolution: "recollected", recollectionRouteId: web("route-studio.routes"), recollectionPickupId: web("route-studio.pickups"), productId: web("commercial.products"), note: "On tomorrow's route" }, TicketComplete],
    reject: [{ reason: "Not ours" }, TicketReject],
    reopen: [{ note: "Came back" }, TicketReopen],
  }

  for (const [name, [values, schema]] of Object.entries(filled)) {
    test(`${name}: its fields are the keys its body is made of, and the body is the contracts'`, () => {
      assert.deepEqual(new Set(fieldIdsOf(TICKET_COMMAND_FORMS[name as keyof typeof filled])), new Set(Object.keys(values)))
      const body = ticketAdapter.commands?.[name]?.toBody?.(values, record, context)
      assert.ok(schema.safeParse(body).success, JSON.stringify(body))
    })
  }

  test("the re-collection's stop is picked among the picked route's stops still to collect or collected, after None (#111)", () => {
    const stop = (id: string, routeId: string, status: string, shown: string): BusinessRecord => ({ ...row(`pickup-${id}`, "Pickup"), name: `Stop ${id}`, status: shown, submittedValues: { routeId, status } })
    const route = web("route-studio.routes")
    const wash: BusinessRecord = { ...stop("6", route, "planned", "Planned"), submittedValues: { routeId: route, status: "planned", service: "wash" } }
    const stops = [stop("1", route, "planned", "Planned"), stop("2", route, "collected", "Collected"), stop("3", route, "skipped", "Skipped"), stop("4", route, "failed", "Failed"), stop("5", "route-other", "planned", "Planned"), wash]
    assert.deepEqual(recollectionStopOptions(stops, route), [
      { value: NO_ONE, label: "None: the route alone" },
      { value: "pickup-1", label: "Stop 1" },
      { value: "pickup-2", label: "Stop 2 · Collected" },
    ], "a wash collects nothing, so it is no re-collection (O3 of #290)")
    assert.deepEqual(recollectionStopOptions(stops, undefined), [{ value: NO_ONE, label: "None: the route alone" }], "no stop before a route is picked")
    assert.deepEqual(recollectionStopOptions(stops, ""), [{ value: NO_ONE, label: "None: the route alone" }])
  })

  test("an edit keeps the row and puts its values over the typed ones", () => {
    const edited = updateTicketRecord(record, { subject: "The gate", description: "Locked" })
    assert.equal(edited.id, record.id)
    assert.equal(edited.name, "The gate")
    assert.deepEqual(ticketAdapter.toPatchBody(record, edited, context), { subject: "The gate", description: "Locked" })
  })
})

describe("Raise alert and the alert's dialogs", () => {
  const filled: BusinessFormValues = { projectId: projectRecord.id, title: "Stale position", details: "No GPS for 14 minutes", kind: "resource", severity: "high", detectedAt: "2026-10-01T09:45", routeId: web("route-studio.routes"), vehicleId: web("fleet.vehicles"), driverId: web("fleet.drivers"), containerId: web("resources.containers") }

  test("names exactly the fields AlertCreate carries, and the body is the contracts'", () => {
    assert.deepEqual(new Set(fieldIdsOf(ALERT_FORM)), new Set(Object.keys(filled)))
    const body = alertAdapter.toCreateBody?.(createAlertRecord(filled, { now: 1 }), context)
    assert.ok(AlertCreate.safeParse(body).success, JSON.stringify(body))
  })

  test("resolve and link-ticket are the contracts' bodies", () => {
    const alert = createAlertRecord(filled, { now: 1 })
    assert.deepEqual(fieldIdsOf(ALERT_COMMAND_FORMS.resolve), ["note"])
    assert.ok(AlertResolve.safeParse(alertAdapter.commands?.[RESOLVE_ALERT]?.toBody?.({ note: "Modem restarted" }, alert, context)).success)
    assert.deepEqual(fieldIdsOf(ALERT_COMMAND_FORMS["link-ticket"]), ["ticketId"])
    assert.ok(AlertLinkTicket.safeParse(alertAdapter.commands?.[LINK_ALERT_TICKET]?.toBody?.({ ticketId: web("operate.tickets") }, alert, context)).success)
  })

  test("Open ticket opens New ticket on the alert: its words, its severity as the priority, its links, and the alert it answers", () => {
    const alert: BusinessRecord = { ...createAlertRecord(filled, { now: 1 }), name: "Stale position", description: "No GPS for 14 minutes" }
    const values = ticketValuesOfAlert(alert)
    assert.deepEqual(values, { projectId: projectRecord.id, subject: "Stale position", description: "No GPS for 14 minutes", kind: "other", priority: "high", source: "office", routeId: web("route-studio.routes"), containerId: web("resources.containers"), driverId: web("fleet.drivers") })
    for (const key of Object.keys(values)) assert.ok(fieldIdsOf(TICKET_FORM).includes(key), `${key} is a field of New ticket`)
    const body = ticketAdapter.toCreateBody?.(createTicketRecord(values, { now: 2, extra: { alertId: web("operate.exceptions") } }), context) as Record<string, unknown>
    assert.ok(TicketCreate.safeParse(body).success, JSON.stringify(body))
    assert.equal(body.alertId, ids.alert)
    assert.deepEqual(body.links, { routeId: ids.route, containerId: ids.container, driverId: ids.driver })
  })
})

describe("the lists' categories", () => {
  const ticket = (status: string, assignee: string, facts: Record<string, string> = {}): BusinessRecord => ({ ...row("ticket-x", "Ticket"), status, facts: { Kind: "Overflow", Priority: "High", Assignee: "Olivia Larsen", "Opened via": "Driver app", ...facts }, submittedValues: { status: status.toLowerCase().replace(/ /g, "-"), [ASSIGNEE_ACCOUNT_KEY]: assignee } })

  test("a ticket reads as open or closed, its status, kind, priority, assignee and where it came from", () => {
    const readers = ticketListReaders(null)
    const open = ticket("On hold", ids.user)
    assert.deepEqual(readers.openness?.(open), ["Open"])
    assert.deepEqual(readers.openness?.(ticket("Completed", "")), ["Closed"])
    assert.deepEqual(readers.openness?.(ticket("Rejected", "")), ["Closed"])
    assert.deepEqual(readers.statuses?.(open), ["On hold"])
    assert.deepEqual(readers.kinds?.(open), ["Overflow"])
    assert.deepEqual(readers.priorities?.(open), ["High"])
    assert.deepEqual(readers.sources?.(open), ["Driver app"])
    assert.deepEqual(readers.assignees?.(open), ["Olivia Larsen"], "no Mine for nobody signed in")
    assert.deepEqual(readers.sla?.(ticket("Open", "", { SLA: "Overdue" })), ["Overdue"])
    assert.deepEqual(readers.sla?.(open), [], "a row the API has not answered yet has no SLA to read")
  })

  test("openness reads the row's own status: a row the API has not answered yet reads as it shows, and the fixtures' Created is open", () => {
    const shown = (status: string): BusinessRecord => ({ ...row("ticket-8831", "Ticket"), status, submittedValues: undefined })
    assert.deepEqual(["In progress", "Pending", "Created", "Open"].map((status) => opennessOf(shown(status))), ["Open", "Open", "Open", "Open"])
    assert.deepEqual(["Completed", "Rejected"].map((status) => opennessOf(shown(status))), ["Closed", "Closed"])
    assert.equal(opennessOf(createTicketRecord({ subject: "Just opened" }, { now: 1 })), "Open", "a ticket made this session, before the API's answer")
  })

  test("Mine is the viewer's own tickets, and only theirs", () => {
    assert.deepEqual(ticketListReaders(ids.user).assignees?.(ticket("Open", ids.user)), ["Olivia Larsen", MINE])
    assert.deepEqual(ticketListReaders(ids.user).assignees?.(ticket("Open", "", { Assignee: "Unassigned" })), ["Unassigned"])
    assert.deepEqual(ticketListReaders("01a0d2a4-a280-7004-8000-000000000002").assignees?.(ticket("Open", ids.user)), ["Olivia Larsen"])
  })

  test("the tickets open on the open ones, the alerts on new and acknowledged, each on a category it reads", () => {
    assert.deepEqual(TICKET_LIST_INITIAL, { openness: ["Open"] })
    assert.ok(Object.keys(TICKET_LIST_INITIAL).every((key) => key in ticketListReaders(null)))
    assert.deepEqual(ALERT_LIST_INITIAL, { statuses: ["New", "Acknowledged"] })
    assert.ok(Object.keys(ALERT_LIST_INITIAL).every((key) => key in alertListReaders()))
    const alert = { ...row("alert-x", "Alert"), status: "New", facts: { Severity: "High", Kind: "Resource" } }
    assert.deepEqual(alertListReaders().severities?.(alert), ["High"])
    assert.deepEqual(alertListReaders().kinds?.(alert), ["Resource"])
  })
})
