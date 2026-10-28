// Tickets on the adapter (#182, slice 8 of #81, for #147): the cases of
// `operate.tickets` as the list, the details and the dialogs read them; the
// office's create and the patch of a case's own fields; the seven commands
// and the comment — every body held here against the contracts' own zod
// schemas, sent through the store's seams over a scripted `fetch`, the API's
// refusals coming back as its sentences. The status moves by command alone.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { Project } from "@waste/contracts/organisation"
import { StopEvidence, Ticket, TicketAssign, TicketComment, TicketComplete, TicketCreate, TicketDetail, TicketEvent, TicketEvidence, TicketHold, TicketPatch, TicketReject, TicketReopen, TicketReplyWithEvidence, TicketStart, TicketWait } from "@waste/contracts/tickets"

import { FIXTURE_COMPANY_ID, getModuleDefinition, type BusinessRecord } from "../../data/business-modules"
import { defaultFactColumns } from "../../data/business-view-kinds"
import { NO_ONE } from "../../data/properties"
import { replyWithEvidenceForm, ticketStopOptions } from "../../data/tickets"
import { problemSentence } from "../problem"
import { NOTHING_RESOLVED, type MappingContext, type Resolver } from "../records/adapter"
import { isServerBacked, SERVER_MODULE_KEYS } from "../records/modules"
import { projectAdapter } from "../records/organisation"
import { actOnRecord, commandRecord, loaded, loadModule, resolverOver, writeRecord, type ServerRecordsState } from "../records/server-records"
import {
  ASSIGN_TICKET,
  ASSIGNEE_ACCOUNT_KEY,
  COMMENT_ON_TICKET,
  commentOnTicket,
  evidenceOutcome,
  evidencePlace,
  evidenceProofLine,
  offersTicketCommand,
  REPLY_WITH_EVIDENCE,
  ticketAdapter,
  ticketDetail,
  ticketEvidence,
  TICKETS_MODULE,
  TICKET_NUMBER_FACT,
  TICKET_SLA_FACT,
  ticketOpened,
  ticketsModule,
} from "../records/tickets"
import { bodyOf, clientOver, json, problem, scripted } from "./scripted-fetch"

const NOW = new Date("2026-10-01T10:00:00Z")
const STAMPS = { createdAt: "2026-10-01T08:00:00.000Z", updatedAt: "2026-10-01T08:00:00.000Z" }
const fixturesOf = (workspaceId: "configure" | "operate", moduleId: string) => getModuleDefinition({ workspaceId, moduleId })?.records ?? []
const fixtures = fixturesOf("operate", "tickets")

const copenhagen: Project = { id: "01a0d2a4-a280-7002-8000-000000000001", ...STAMPS, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active", weekend: ["saturday", "sunday"], holidayList: "Danish public holidays", publicSlug: null, weightTolerancePercent: 5, paymentTermsDays: 30, paymentReferenceScheme: "none", holdForReview: false, branding: { brandColor: null, logoUrl: null, accessibilityStatementUrl: null } }
const projectRecord = projectAdapter.toRecord(copenhagen, { fixtures: fixturesOf("configure", "organization"), resolve: NOTHING_RESOLVED, companyRecordId: FIXTURE_COMPANY_ID, now: NOW })

const oliviaId = "01a0d2a4-a280-7004-8000-000000000001"
const routeId = "01a0d2a4-a280-7030-8000-000000000001"
const endedRouteId = "01a0d2a4-a280-7030-8000-000000000002"
const containerId = "01a0d2a4-a280-7020-8000-000000000001"
const customerId = "01a0d2a4-a280-7003-8000-000000000001"
const pickupId = "01a0d2a4-a280-7033-8000-000000000001"
const alertId = "01a0d2a4-a280-7041-8000-000000000001"
const propertyId = "01a0d2a4-a280-7006-8000-000000000001"
const driverId = "01a0d2a4-a280-7014-8000-000000000001"

/** A loaded row of another module, as its adapter would have made it: its web id, its name, its kind. */
const row = (id: string, name: string, recordKind: string, facts: Record<string, string> = {}): BusinessRecord => ({ ...projectRecord, id, name, recordKind, facts, submittedValues: {} })
const olivia = row(`user-${oliviaId}`, "Olivia Larsen", "User")
const rc1042 = row(`route-${routeId}`, "RC-1042", "Route")
const rc1040 = row(`route-${endedRouteId}`, "RC-1040", "Route")
const bin = row(`asset-${containerId}`, "BIN-82014", "Container")
// An organisation is `company-<uuid>`, as the registry's adapter makes it.
const housing = row(`company-${customerId}`, "Østerbro Housing", "Contact or Customer Organization")
const strandboulevarden = row(`property-${propertyId}`, "Strandboulevarden 52", "Property")
const serverIdsOf = (records: readonly BusinessRecord[], ids: readonly string[]) => new Map(records.map((record, index) => [record.id, ids[index]]))
const state: ServerRecordsState = new Map([
  ["configure.organization", loaded({ records: [projectRecord], serverIds: serverIdsOf([projectRecord], [copenhagen.id]) }, 1)],
  ["configure.access", loaded({ records: [olivia], serverIds: serverIdsOf([olivia], [oliviaId]) }, 1)],
  ["customers.contacts", loaded({ records: [housing], serverIds: serverIdsOf([housing], [customerId]) }, 1)],
  ["customers.properties", loaded({ records: [strandboulevarden], serverIds: serverIdsOf([strandboulevarden], [propertyId]) }, 1)],
  ["resources.containers", loaded({ records: [bin], serverIds: serverIdsOf([bin], [containerId]) }, 1)],
  ["route-studio.routes", loaded({ records: [rc1042, rc1040], serverIds: serverIdsOf([rc1042, rc1040], [routeId, endedRouteId]) }, 1)],
])
const resolve = resolverOver(state)
const context = (resolver: Resolver = resolve): MappingContext => ({ fixtures, resolve: resolver, companyRecordId: FIXTURE_COMPANY_ID, now: NOW })
const options = { fixtures, state, now: NOW }
const pageOf = (items: unknown[], nextCursor: string | null = null) => json({ items, nextCursor })

const NO_LINKS = { routeId: null, pickupId: null, containerId: null, propertyId: null, sharedCollectionPointId: null, customerId: null, agreementId: null, driverId: null, parentTicketId: null }

// A ticket the consumer opened from a failed stop: about the route, its pickup and the container.
const missed: Ticket = {
  id: "01a0d2a4-a280-7040-8000-000000000001",
  ...STAMPS,
  projectId: copenhagen.id,
  number: 1001,
  label: "T-1001",
  kind: "missed-collection",
  status: "open",
  priority: "high",
  source: "driver-app",
  subject: "Missed collection at Adelgade 12",
  description: "Gate locked, no answer at the door",
  occurredAt: "2026-10-01T05:31:00.000Z",
  dueAt: "2026-10-01T12:00:00.000Z",
  assigneeUserAccountId: null,
  teamId: null,
  createdBy: null,
  sourceEventId: "01a0d2a4-a280-7050-8000-000000000001",
  links: { ...NO_LINKS, routeId, pickupId, containerId },
  resolution: null,
  recollectionRouteId: null,
  recollectionPickupId: null,
  chargeProductId: null,
  closedAt: null,
  bookedRouteId: null,
  bookedPickupId: null,
}

const record = ticketAdapter.toRecord(missed, context())
const current = loaded({ records: [record], serverIds: new Map([[record.id, missed.id]]) }, 1)

describe("the tickets module", () => {
  test("is switched, after every module a ticket names a row of, and the alerts after it", () => {
    assert.ok(isServerBacked(TICKETS_MODULE.workspaceId, TICKETS_MODULE.moduleId))
    const at = SERVER_MODULE_KEYS.indexOf("operate.tickets")
    for (const named of ["configure.organization", "configure.access", "customers.contacts", "customers.properties", "customers.shared", "customers.agreements", "resources.containers", "fleet.drivers", "route-studio.routes", "route-studio.pickups"]) {
      assert.ok(at > SERVER_MODULE_KEYS.indexOf(named), `after ${named}`)
    }
    assert.ok(SERVER_MODULE_KEYS.indexOf("operate.exceptions") > at, "the alerts after the tickets they are linked to")
  })

  test("reads every ticket, page after page, each `ticket-<uuid>`: no fixture lends its id", async () => {
    const second: Ticket = { ...missed, id: "01a0d2a4-a280-7040-8000-000000000002", number: 1002, label: "T-1002" }
    const { fetch, calls } = scripted([() => pageOf([missed], "next"), () => pageOf([second])])
    const result = await loadModule(clientOver(fetch), ticketsModule, options)
    assert.deepEqual(
      calls.map((call) => call.url),
      ["http://api.test/tickets?limit=200", "http://api.test/tickets?limit=200&cursor=next"],
    )
    assert.deepEqual(
      result.records.map((ticket) => ticket.id),
      [`ticket-${missed.id}`, `ticket-${second.id}`],
    )
    assert.equal(result.serverIds.get(`ticket-${missed.id}`), missed.id)
  })
})

describe("a ticket", () => {
  test("the wire fixtures are the contracts' shapes", () => {
    assert.ok(Ticket.safeParse(missed).success)
  })

  test("its SLA is what its due date reads as at the list's clock: overdue, on track, met, breached or none (O4 of #290)", () => {
    const sla = (values: Partial<Ticket>) => ticketAdapter.toRecord({ ...missed, ...values }, context()).facts[TICKET_SLA_FACT]
    assert.equal(sla({}), "On track", "open, due at noon, read at ten")
    assert.equal(sla({ dueAt: "2026-10-01T09:59:00.000Z" }), "Overdue")
    assert.equal(sla({ status: "completed", resolution: "serviced", closedAt: "2026-10-01T11:00:00.000Z" }), "Met")
    assert.equal(sla({ status: "rejected", closedAt: "2026-10-01T12:30:00.000Z" }), "Breached")
    assert.equal(sla({ dueAt: null }), "No due date")
  })

  test("is the record the list and the details read: its subject the name, its label the number fact, the wire's facts alone", () => {
    assert.equal(record.id, `ticket-${missed.id}`)
    assert.equal(record.name, "Missed collection at Adelgade 12")
    assert.equal(record.context, "", "about a route, a stop and a container: no customer, no property")
    assert.equal(record.status, "Open")
    assert.equal(record.owner, "Unassigned")
    assert.equal(record.value, "Due 2026-10-01 14:00", "on the project's clock")
    assert.equal(record.description, "Gate locked, no answer at the door")
    assert.equal(record.recordKind, "Ticket")
    assert.deepEqual(record.projectIds, [projectRecord.id])
    assert.deepEqual(record.facts, {
      Number: "T-1001",
      Kind: "Missed collection",
      Priority: "High",
      Assignee: "Unassigned",
      Team: "No team",
      "Opened via": "Driver app",
      Occurred: "2026-10-01 07:31",
      Due: "2026-10-01 14:00",
      SLA: "On track",
      Project: "Copenhagen Central",
      Route: "RC-1042",
      Pickup: `pickup-${pickupId}`,
      Container: "BIN-82014",
    })
    assert.ok(!("Type" in record.facts), "no configured type: the wire has none")
    assert.ok(!("Source" in record.facts), "the wire's source is no fixture's Source")
    assert.deepEqual(record.submittedValues, {
      projectId: projectRecord.id,
      label: "T-1001",
      subject: missed.subject,
      description: missed.description,
      kind: "missed-collection",
      priority: "high",
      source: "driver-app",
      status: "open",
      occurredAt: "2026-10-01T07:31",
      dueAt: "2026-10-01T14:00",
      assigneeUserAccountId: "",
      [ASSIGNEE_ACCOUNT_KEY]: "",
      teamId: NO_ONE,
      routeId: rc1042.id,
      pickupId: `pickup-${pickupId}`,
      containerId: bin.id,
      propertyId: "",
      sharedCollectionPointId: "",
      customerId: "",
      agreementId: "",
      driverId: "",
      parentTicketId: "",
      resolution: "",
      recollectionRouteId: "",
      recollectionPickupId: "",
      bookedRouteId: "",
      bookedPickupId: "",
    })
  })

  test("says under Customer · property whom and where it is about, each once: never its number, the route, the stop, the container or the driver (#253)", () => {
    const reported = ticketAdapter.toRecord({ ...missed, links: { ...missed.links, propertyId, driverId } }, context())
    assert.equal(reported.context, "Strandboulevarden 52", "the consumer names the stop's property and no customer")
    assert.equal(reported.facts.Property, "Strandboulevarden 52")
    assert.equal(reported.facts.Container, "BIN-82014", "the container under its own fact, once")
    const named = ticketAdapter.toRecord({ ...missed, source: "office", links: { ...NO_LINKS, customerId, propertyId } }, context())
    assert.equal(named.context, "Østerbro Housing · Strandboulevarden 52")
    const unloaded = ticketAdapter.toRecord({ ...missed, links: { ...NO_LINKS, customerId, propertyId } }, context(NOTHING_RESOLVED))
    assert.equal(unloaded.context, `customer-${customerId} · property-${propertyId}`, "by id chip until their modules load")
  })

  test("carries no fact headed as the table's title column, so one column is headed Ticket (#253)", () => {
    const entityLabel = getModuleDefinition(TICKETS_MODULE)?.entityLabel ?? ""
    assert.equal(entityLabel, "Ticket")
    assert.ok(!(entityLabel in record.facts))
    assert.equal(record.facts[TICKET_NUMBER_FACT], "T-1001")
    const seeded = defaultFactColumns(TICKETS_MODULE.moduleId, [])
    for (const fact of [TICKET_NUMBER_FACT, "Route", "Container"]) assert.ok(seeded.includes(fact), `${fact} is a column the table opens with`)
    assert.ok(!seeded.includes(entityLabel))
  })

  test("names its links and its assignee by id chip until their modules load", () => {
    const assigned = ticketAdapter.toRecord({ ...missed, assigneeUserAccountId: oliviaId }, context(NOTHING_RESOLVED))
    assert.equal(assigned.facts.Route, `route-${routeId}`)
    assert.equal(assigned.facts.Container, `asset-${containerId}`)
    assert.equal(assigned.owner, `user-${oliviaId}`)
    assert.equal(assigned.submittedValues?.routeId, `route-${routeId}`)
    assert.equal(assigned.submittedValues?.assigneeUserAccountId, `user-${oliviaId}`)
    assert.equal(assigned.submittedValues?.[ASSIGNEE_ACCOUNT_KEY], oliviaId, "the server id \"Mine\" compares with")
  })

  test("says what it ended in: the resolution, the re-collection's route and when it closed", () => {
    const completed = ticketAdapter.toRecord({ ...missed, status: "completed", resolution: "recollected", recollectionRouteId: routeId, closedAt: "2026-10-01T09:00:00.000Z", assigneeUserAccountId: oliviaId }, context())
    assert.equal(completed.status, "Completed")
    assert.equal(completed.owner, "Olivia Larsen")
    assert.equal(completed.facts.Resolution, "Recollected")
    assert.equal(completed.facts["Re-collection route"], "RC-1042")
    assert.equal(completed.facts.Closed, "2026-10-01 11:00")
    assert.equal(completed.submittedValues?.recollectionRouteId, rc1042.id)
    // The stop the office added for it, where the completion named one (#111): by its id chip until the stops load.
    const onItsStop = ticketAdapter.toRecord({ ...missed, status: "completed", resolution: "recollected", recollectionRouteId: routeId, recollectionPickupId: pickupId, closedAt: "2026-10-01T09:00:00.000Z" }, context())
    assert.equal(onItsStop.facts["Re-collection stop"], `pickup-${pickupId}`)
    assert.equal(onItsStop.submittedValues?.recollectionPickupId, `pickup-${pickupId}`)
    assert.equal(completed.facts["Re-collection stop"], undefined)
  })

  test("is read back one ticket at a time, as its details read it: a stop booked from it names the stop on the row (O3c of #290)", async () => {
    const { fetch, calls } = scripted([() => json({ ...missed, kind: "overflow", bookedRouteId: routeId, bookedPickupId: pickupId, events: [] })])
    const read = await ticketAdapter.read?.(clientOver(fetch), missed.id)
    assert.equal(calls[0].url, `http://api.test/tickets/${missed.id}`)
    assert.equal(ticketAdapter.toRecord(read as typeof missed, context()).facts["Booked stop"], `pickup-${pickupId}`)
  })

  test("says which stop the office booked to answer it, its route by name and the stop by its id chip until the stops load (O3c of #290)", () => {
    const booked = ticketAdapter.toRecord({ ...missed, kind: "overflow", bookedRouteId: routeId, bookedPickupId: pickupId }, context())
    assert.deepEqual([booked.facts["Booked route"], booked.facts["Booked stop"]], ["RC-1042", `pickup-${pickupId}`])
    assert.deepEqual([booked.submittedValues?.bookedRouteId, booked.submittedValues?.bookedPickupId], [rc1042.id, `pickup-${pickupId}`])
    assert.equal(record.facts["Booked stop"], undefined, "a ticket no stop answers says nothing of one")
  })

  test("reads each status as the list and the details spell it", () => {
    const words = { open: "Open", "in-progress": "In progress", pending: "Pending", "on-hold": "On hold", completed: "Completed", rejected: "Rejected" } as const
    for (const [token, word] of Object.entries(words)) assert.equal(ticketAdapter.toRecord({ ...missed, status: token as Ticket["status"] }, context()).status, word)
  })
})

describe("the office's create", () => {
  const minted = (values: Record<string, string>): BusinessRecord => ({ ...record, id: "operate-ticket-1700000000000", name: values.subject ?? "", recordKind: "Ticket", projectIds: [projectRecord.id], submittedValues: { projectId: projectRecord.id, ...values } })
  const typedValues = { subject: "Overflowing glass bank", description: "Glass above the rim", kind: "overflow", priority: "critical", source: "phone", occurredAt: "2026-10-01T09:15", dueAt: "2026-10-01T16:00", assigneeUserAccountId: olivia.id, routeId: rc1042.id, containerId: bin.id, customerId: housing.id }

  test("is told by its number once the API has answered with it, as every other ticket toast names it; by its subject only while the row is not known (#283)", () => {
    assert.deepEqual(ticketOpened(record), { title: "Ticket opened", description: "T-1001 is open." })
    // The row the office made, before the API has numbered it: no number among its facts.
    assert.deepEqual(ticketOpened({ ...minted({ subject: "Overflowing glass bank" }), facts: {} }), { title: "Ticket opened", description: "Overflowing glass bank is open; its number follows from the API." })
  })

  test("is the contracts' TicketCreate, links and the assignee by server id, the times on the project's clock", () => {
    const body = ticketAdapter.toCreateBody?.(minted(typedValues), context())
    assert.deepEqual(body, {
      projectId: copenhagen.id,
      subject: "Overflowing glass bank",
      description: "Glass above the rim",
      kind: "overflow",
      priority: "critical",
      source: "phone",
      occurredAt: "2026-10-01T07:15:00.000Z",
      dueAt: "2026-10-01T14:00:00.000Z",
      assigneeUserAccountId: oliviaId,
      links: { routeId, containerId, customerId },
    })
    assert.ok(TicketCreate.safeParse(body).success)
  })

  test("carries the alert it answers, and leaves out what the form left blank", () => {
    const body = ticketAdapter.toCreateBody?.(minted({ subject: "Stale position", description: "No GPS for 14 minutes", kind: "other", alertId: `alert-${alertId}` }), context())
    assert.deepEqual(body, { projectId: copenhagen.id, subject: "Stale position", description: "No GPS for 14 minutes", kind: "other", alertId })
    assert.ok(TicketCreate.safeParse(body).success)
    const none = ticketAdapter.toCreateBody?.(minted({ ...typedValues, routeId: "none", customerId: "none", assigneeUserAccountId: "none" }), context()) as Record<string, unknown>
    assert.deepEqual(none.links, { containerId }, "a picker's None is no link")
    assert.equal(none.assigneeUserAccountId, undefined)
  })

  test("names a row made this session by its minted id, held to its kind: an alert raised a moment ago, a container just added", () => {
    // withCreated keeps the minted id for the session (server-records.ts): the alert's Open ticket names it so.
    const raised = row("operate-alert-1700000000000", "Stale position", "Alert")
    const added = row("resources-container-1700000000000", "BIN-90001", "Container")
    const withMinted: ServerRecordsState = new Map([
      ...state,
      ["operate.exceptions", loaded({ records: [raised], serverIds: new Map([[raised.id, alertId]]) }, 1)],
      ["resources.containers", loaded({ records: [bin, added], serverIds: new Map([[bin.id, containerId], [added.id, "01a0d2a4-a280-7020-8000-000000000002"]]) }, 1)],
    ])
    const body = ticketAdapter.toCreateBody?.(minted({ subject: "Stale position", description: "x", kind: "other", alertId: raised.id, containerId: added.id }), context(resolverOver(withMinted))) as Record<string, unknown>
    assert.equal(body.alertId, alertId)
    assert.deepEqual(body.links, { containerId: "01a0d2a4-a280-7020-8000-000000000002" })
    assert.deepEqual(ticketAdapter.toCreateBody?.(minted({ subject: "x", description: "x", kind: "other", alertId: added.id }), context(resolverOver(withMinted))), { path: "alertId", message: "Pick an alert the API holds" }, "a container's row is no alert")
  })

  test("may name the case it is a sub-ticket of, by server id and held to a ticket (7.10 of #290)", () => {
    const withParent: ServerRecordsState = new Map([...state, ["operate.tickets", current]])
    const body = ticketAdapter.toCreateBody?.(minted({ subject: "Replace the lock", description: "The gate's lock is broken", kind: "other", parentTicketId: record.id }), context(resolverOver(withParent)))
    assert.deepEqual(body, { projectId: copenhagen.id, subject: "Replace the lock", description: "The gate's lock is broken", kind: "other", links: { parentTicketId: missed.id } })
    assert.ok(TicketCreate.safeParse(body).success)
    assert.deepEqual(ticketAdapter.toCreateBody?.(minted({ subject: "x", description: "x", kind: "other", parentTicketId: bin.id }), context(resolverOver(withParent))), { path: "parentTicketId", message: "Pick a parent ticket the API holds" }, "a container's row is no ticket")
  })

  test("is refused here, naming the field, before the API sees a body it would refuse", () => {
    const create = ticketAdapter.toCreateBody
    assert.deepEqual(create?.(minted({ ...typedValues, subject: " " }), context()), { path: "subject", message: "A ticket needs a subject" })
    assert.deepEqual(create?.(minted({ ...typedValues, kind: "" }), context()), { path: "kind", message: "Pick the kind of case" })
    assert.deepEqual(create?.(minted({ ...typedValues, source: "driver-app" }), context()), { path: "source", message: "Pick where the case came from: office, phone, email, portal, import, integration" })
    assert.deepEqual(create?.(minted({ ...typedValues, routeId: "route-1042" }), context()), { path: "routeId", message: "Pick a route the API holds" })
    assert.deepEqual(create?.(minted({ ...typedValues, routeId: bin.id }), context()), { path: "routeId", message: "Pick a route the API holds" }, "a container's row is no route")
    assert.deepEqual(create?.(minted({ ...typedValues, assigneeUserAccountId: "user-somebody" }), context()), { path: "assigneeUserAccountId", message: "Pick an account the API holds" })
    assert.deepEqual(create?.(minted({ ...typedValues, dueAt: "tomorrow" }), context()), { path: "dueAt", message: "Give the time as a date and a time" })
  })

  test("posts to /tickets and the ticket the API answers replaces the minted row", async () => {
    const answered: Ticket = { ...missed, id: "01a0d2a4-a280-7040-8000-000000000003", number: 1003, label: "T-1003", source: "phone", kind: "overflow", subject: "Overflowing glass bank" }
    const { fetch, calls } = scripted([() => json(answered, 201, { location: `/tickets/${answered.id}` })])
    const outcome = await writeRecord(clientOver(fetch), ticketsModule, loaded({ records: [], serverIds: new Map() }, 1), minted(typedValues), options)
    assert.equal(calls[0].url, "http://api.test/tickets")
    assert.equal(calls[0].init.method, "POST")
    assert.ok(TicketCreate.safeParse(bodyOf(calls[0])).success)
    assert.equal(outcome.kind, "created")
    if (outcome.kind !== "created") return
    assert.equal(outcome.record.id, `ticket-${answered.id}`)
    assert.equal(outcome.record.facts[TICKET_NUMBER_FACT], "T-1003")
  })
})

describe("the patch of a case's own fields", () => {
  const edited = (values: Record<string, string>): BusinessRecord => ({ ...record, submittedValues: { ...record.submittedValues, ...values } })

  test("sends what moved of the subject, the description, the kind, the priority and the due, as the contracts' TicketPatch", () => {
    const body = ticketAdapter.toPatchBody(record, edited({ priority: "critical", kind: "access-issue" }), context())
    assert.deepEqual(body, { kind: "access-issue", priority: "critical" })
    assert.ok(TicketPatch.safeParse(body).success)
    const due = ticketAdapter.toPatchBody(record, edited({ dueAt: "2026-10-02T09:00" }), context())
    assert.deepEqual(due, { dueAt: "2026-10-02T07:00:00.000Z" })
    assert.ok(TicketPatch.safeParse(due).success)
    const cleared = ticketAdapter.toPatchBody(record, edited({ dueAt: "" }), context())
    assert.deepEqual(cleared, { dueAt: null }, "a cleared due is cleared")
    assert.ok(TicketPatch.safeParse(cleared).success)
    assert.equal(ticketAdapter.toPatchBody(record, edited({}), context()), null, "nothing moved, nothing sent")
  })

  test("never carries the status, the assignee, the source or the links", () => {
    assert.equal(ticketAdapter.toPatchBody(record, edited({ source: "email", routeId: "", assigneeUserAccountId: olivia.id, status: "completed" }), context()), null)
  })

  test("a status move is refused before the API sees it: the status moves by command", async () => {
    const { fetch, calls } = scripted([])
    const outcome = await writeRecord(clientOver(fetch), ticketsModule, current, { ...record, status: "Completed" }, options)
    assert.equal(outcome.kind, "refused")
    assert.equal(calls.length, 0)
  })

  test("goes out as PATCH and the answer replaces the row under its web id", async () => {
    const { fetch, calls } = scripted([() => json({ ...missed, priority: "critical" })])
    const outcome = await writeRecord(clientOver(fetch), ticketsModule, current, edited({ priority: "critical" }), options)
    assert.equal(calls[0].url, `http://api.test/tickets/${missed.id}`)
    assert.equal(calls[0].init.method, "PATCH")
    assert.deepEqual(bodyOf(calls[0]), { priority: "critical" })
    assert.equal(outcome.kind, "updated")
    if (outcome.kind !== "updated") return
    assert.equal(outcome.record.facts.Priority, "Critical")
  })
})

describe("the ticket's commands", () => {
  const commands = ticketAdapter.commands ?? {}
  const body = (name: string, input: Record<string, unknown>) => commands[name]?.toBody?.(input, record, context())

  test("assign names a User Account by server id, or nobody, with a note", () => {
    const assigned = body(ASSIGN_TICKET, { assigneeUserAccountId: olivia.id, note: "Taking it" })
    assert.deepEqual(assigned, { assigneeUserAccountId: oliviaId, note: "Taking it" })
    assert.ok(TicketAssign.safeParse(assigned).success)
    const unassigned = body(ASSIGN_TICKET, { assigneeUserAccountId: "" })
    assert.deepEqual(unassigned, { assigneeUserAccountId: null })
    assert.ok(TicketAssign.safeParse(unassigned).success)
    assert.deepEqual(body(ASSIGN_TICKET, { assigneeUserAccountId: "none" }), { assigneeUserAccountId: null }, "the picker's None is nobody")
    assert.deepEqual(body(ASSIGN_TICKET, { assigneeUserAccountId: housing.id }), { path: "assigneeUserAccountId", message: "Pick an account the API holds" })
  })

  test("start may say nothing; wait, hold, reject and reopen say why, or are refused here", () => {
    assert.deepEqual(body("start", {}), {})
    assert.ok(TicketStart.safeParse(body("start", {})).success)
    assert.deepEqual(body("start", { note: "On it" }), { note: "On it" })
    assert.deepEqual(body("wait", { note: "The gate code" }), { note: "The gate code" })
    assert.ok(TicketWait.safeParse(body("wait", { note: "The gate code" })).success)
    assert.deepEqual(body("wait", { note: " " }), { path: "note", message: "Say what the ticket waits for from the customer" })
    assert.ok(TicketHold.safeParse(body("hold", { note: "A truck" })).success)
    assert.deepEqual(body("hold", {}), { path: "note", message: "Say what the ticket is held for" })
    assert.deepEqual(body("reject", { reason: "Not ours" }), { reason: "Not ours" })
    assert.ok(TicketReject.safeParse(body("reject", { reason: "Not ours" })).success)
    assert.deepEqual(body("reject", {}), { path: "reason", message: "Say why the ticket is rejected" })
    assert.ok(TicketReopen.safeParse(body("reopen", { note: "Came back" })).success)
    assert.deepEqual(body("reopen", {}), { path: "note", message: "Say why the ticket is reopened" })
  })

  test("complete says what it ended in and how; recollected names a real route, picked, never typed", () => {
    const serviced = body("complete", { resolution: "serviced", note: "Emptied on the second pass", recollectionRouteId: rc1042.id })
    assert.deepEqual(serviced, { resolution: "serviced", note: "Emptied on the second pass" }, "a route rides with recollected alone")
    assert.ok(TicketComplete.safeParse(serviced).success)
    const recollected = body("complete", { resolution: "recollected", note: "On tomorrow's route", recollectionRouteId: rc1042.id })
    assert.deepEqual(recollected, { resolution: "recollected", note: "On tomorrow's route", recollectionRouteId: routeId })
    assert.ok(TicketComplete.safeParse(recollected).success)
    assert.deepEqual(body("complete", { resolution: "recollected", note: "x" }), { path: "recollectionRouteId", message: "Pick the route the re-collection rides on" })
    assert.deepEqual(body("complete", { resolution: "recollected", note: "x", recollectionRouteId: "RC-1042" }), { path: "recollectionRouteId", message: "Pick a route the API holds" })
    assert.deepEqual(body("complete", { note: "x" }), { path: "resolution", message: "Pick what the ticket ended in" })
    assert.deepEqual(body("complete", { resolution: "fixed", note: "x" }), { path: "resolution", message: "Pick what the ticket ended in: recollected, serviced, answered, no-action, duplicate" })
    assert.deepEqual(body("complete", { resolution: "answered" }), { path: "note", message: "Say how the case was resolved" })
  })

  test("complete · recollected may name the stop the office added on that route, by server id; None names the route alone (#111)", () => {
    const withStop = body("complete", { resolution: "recollected", note: "On the added stop", recollectionRouteId: rc1042.id, recollectionPickupId: `pickup-${pickupId}` })
    assert.deepEqual(withStop, { resolution: "recollected", note: "On the added stop", recollectionRouteId: routeId, recollectionPickupId: pickupId })
    assert.ok(TicketComplete.safeParse(withStop).success)
    assert.deepEqual(body("complete", { resolution: "recollected", note: "x", recollectionRouteId: rc1042.id, recollectionPickupId: NO_ONE }), { resolution: "recollected", note: "x", recollectionRouteId: routeId })
    assert.deepEqual(body("complete", { resolution: "recollected", note: "x", recollectionRouteId: rc1042.id, recollectionPickupId: "Stop 4" }), { path: "recollectionPickupId", message: "Pick a stop the API holds" })
    assert.deepEqual(body("complete", { resolution: "serviced", note: "x", recollectionRouteId: rc1042.id, recollectionPickupId: `pickup-${pickupId}` }), { resolution: "serviced", note: "x" }, "a stop rides with recollected alone, as its route does")
  })

  test("complete may name the product a re-collection's or a service's work is charged at, by server id; None leaves the kind's charge to stand in (#291 C3)", () => {
    const productId = "01a0d2a4-a280-700a-8000-000000000005"
    const bulky = { ...row(`product-${productId}`, "Bulky pickup", "Product"), submittedValues: { priceUnit: "job" } }
    const withProduct: ServerRecordsState = new Map([...state, ["commercial.products", loaded({ records: [bulky], serverIds: serverIdsOf([bulky], [productId]) }, 1)]])
    const complete = (input: Record<string, unknown>) => commands.complete?.toBody?.({ note: "Emptied again", ...input }, record, context(resolverOver(withProduct)))
    const serviced = complete({ resolution: "serviced", productId: bulky.id })
    assert.deepEqual(serviced, { resolution: "serviced", note: "Emptied again", productId })
    assert.ok(TicketComplete.safeParse(serviced).success)
    const recollected = complete({ resolution: "recollected", recollectionRouteId: rc1042.id, productId: bulky.id })
    assert.deepEqual(recollected, { resolution: "recollected", note: "Emptied again", recollectionRouteId: routeId, productId }, "beside the route the re-collection rides on")
    assert.deepEqual(complete({ resolution: "serviced", productId: NO_ONE }), { resolution: "serviced", note: "Emptied again" }, "None: the kind's charge stands in")
    assert.deepEqual(complete({ resolution: "answered", productId: bulky.id }), { resolution: "answered", note: "Emptied again" }, "a product rides with a resolution Finance charges for alone")
    assert.deepEqual(complete({ resolution: "serviced", productId: "Bulky pickup" }), { path: "productId", message: "Pick a product the API holds" })
  })

  test("complete · recollected refuses a loaded stop of another route — picked before the route was changed — at the stop", () => {
    const stop = { ...row(`pickup-${pickupId}`, "Stop 4 · Parkvej 18", "Pickup"), submittedValues: { routeId: rc1042.id } }
    const withStop: ServerRecordsState = new Map([...state, ["route-studio.pickups", loaded({ records: [stop], serverIds: serverIdsOf([stop], [pickupId]) }, 1)]])
    const complete = (recollectionRouteId: string) => commands.complete?.toBody?.({ resolution: "recollected", note: "x", recollectionRouteId, recollectionPickupId: stop.id }, record, context(resolverOver(withStop)))
    assert.deepEqual(complete(rc1042.id), { resolution: "recollected", note: "x", recollectionRouteId: routeId, recollectionPickupId: pickupId })
    assert.deepEqual(complete(rc1040.id), { path: "recollectionPickupId", message: "Pick a stop on the re-collection route" })
  })

  test("each posts its body to its path and the ticket the API answers replaces the row", async () => {
    const { fetch, calls } = scripted([() => json({ ...missed, status: "in-progress" }), () => json({ ...missed, assigneeUserAccountId: oliviaId })])
    const started = await commandRecord(clientOver(fetch), ticketsModule, current, record, "start", undefined, options)
    assert.equal(calls[0].url, `http://api.test/tickets/${missed.id}/start`)
    assert.equal(calls[0].init.method, "POST")
    assert.deepEqual(bodyOf(calls[0]), {}, "an empty object, never no body: the API reads JSON")
    assert.equal(started.kind, "done")
    if (started.kind === "done") assert.equal(started.record.status, "In progress")
    const assigned = await commandRecord(clientOver(fetch), ticketsModule, current, record, ASSIGN_TICKET, { assigneeUserAccountId: olivia.id }, options)
    assert.equal(calls[1].url, `http://api.test/tickets/${missed.id}/assign`)
    assert.equal(assigned.kind, "done")
    if (assigned.kind !== "done") return
    assert.equal(assigned.record.owner, "Olivia Larsen")
    assert.equal(assigned.record.id, record.id)
  })

  test("the API's 409 comes back as its sentence, under the ticket's name", async () => {
    const detail = "Ticket T-1001 is completed; reopen it first"
    const { fetch } = scripted([() => problem(409, detail)])
    const outcome = await commandRecord(clientOver(fetch), ticketsModule, current, record, "start", undefined, options)
    assert.equal(outcome.kind, "refused")
    if (outcome.kind !== "refused") return
    assert.equal(outcome.what, "Missed collection at Adelgade 12 was not started")
    assert.equal(problemSentence(outcome.problem), detail)
  })

  test("a re-collection on a route that has ended is the API's 409, its sentence as it comes", async () => {
    const detail = "Route RC-1040 is completed; a re-collection rides on a route that has not ended"
    const { fetch, calls } = scripted([() => problem(409, detail)])
    const outcome = await commandRecord(clientOver(fetch), ticketsModule, current, record, "complete", { resolution: "recollected", note: "x", recollectionRouteId: rc1040.id }, options)
    assert.deepEqual(bodyOf(calls[0]), { resolution: "recollected", note: "x", recollectionRouteId: endedRouteId })
    assert.equal(outcome.kind, "refused")
    if (outcome.kind === "refused") assert.equal(problemSentence(outcome.problem), detail)
  })

  test("are offered only where the machine moves the ticket — never where it stays, which writes nothing; assign while it is open", () => {
    const offered = (status: Ticket["status"]) => [ASSIGN_TICKET, "start", "wait", "hold", "complete", "reject", "reopen"].filter((name) => offersTicketCommand(status, name as never, "T-1001"))
    assert.deepEqual(offered("open"), [ASSIGN_TICKET, "start", "wait", "hold", "complete", "reject"], "no reopen on an open ticket")
    assert.deepEqual(offered("in-progress"), [ASSIGN_TICKET, "wait", "hold", "complete", "reject"], "no start on a ticket in progress")
    assert.deepEqual(offered("pending"), [ASSIGN_TICKET, "start", "hold", "complete", "reject"])
    assert.deepEqual(offered("on-hold"), [ASSIGN_TICKET, "start", "wait", "complete", "reject"])
    assert.deepEqual(offered("completed"), ["reopen"], "a closed ticket takes reopen alone")
    assert.deepEqual(offered("rejected"), ["reopen"])
  })
})

describe("the comment and the detail read", () => {
  const event: TicketEvent = { id: "01a0d2a4-a280-7042-8000-000000000001", recordedAt: "2026-10-01T09:00:00.000Z", projectId: copenhagen.id, ticketId: missed.id, kind: "comment", status: "open", assigneeUserAccountId: null, resolution: null, body: "Called the caretaker", visibility: "internal", objectKey: null, sourceEventId: null, recordedBy: oliviaId }

  test("a comment is appended, internal unless said, as the contracts' TicketComment; the row stays as it is", async () => {
    const comment = ticketAdapter.actions?.[COMMENT_ON_TICKET]
    const internal = comment?.toBody?.({ body: "Called the caretaker" }, record, context())
    assert.deepEqual(internal, { body: "Called the caretaker", visibility: "internal" })
    assert.ok(TicketComment.safeParse(internal).success)
    assert.deepEqual(comment?.toBody?.({ body: "We come back tomorrow", visibility: "customer" }, record, context()), { body: "We come back tomorrow", visibility: "customer" })
    assert.deepEqual(comment?.toBody?.({ body: " " }, record, context()), { path: "body", message: "Write the comment" })
    assert.deepEqual(comment?.toBody?.({ body: "x", visibility: "sms" }, record, context()), { path: "visibility", message: "A comment is internal, customer or service-provider" })

    const { fetch, calls } = scripted([() => json(event, 201)])
    const outcome = await actOnRecord<TicketEvent>(clientOver(fetch), ticketsModule, current, record, COMMENT_ON_TICKET, { body: "Called the caretaker" }, options)
    assert.equal(calls[0].url, `http://api.test/tickets/${missed.id}/comments`)
    assert.equal(calls[0].init.method, "POST")
    assert.equal(outcome.kind, "done")
    if (outcome.kind === "done") assert.ok(TicketEvent.safeParse(outcome.answer).success)
  })

  test("the typed wrapper sends the comment through the store's sendAction, by name", async () => {
    const sent: unknown[] = []
    await commentOnTicket(async (...args) => {
      sent.push(args)
      return { kind: "done", answer: event }
    }, record.id, { body: "x", visibility: "internal" })
    assert.deepEqual(sent, [["operate", "tickets", record.id, COMMENT_ON_TICKET, { body: "x", visibility: "internal" }, undefined]])
  })

  test("the ticket's own read gives its history in recording order and the alerts naming it", async () => {
    const detail: TicketDetail = { ...missed, events: [{ ...event, kind: "created", body: null }, event], alerts: [] }
    assert.ok(TicketDetail.safeParse(detail).success)
    const { fetch, calls } = scripted([() => json(detail)])
    assert.deepEqual(await ticketDetail(clientOver(fetch), missed.id), detail)
    assert.equal(calls[0].url, `http://api.test/tickets/${missed.id}`)
  })
})

describe("the stop's evidence (M6 of #293)", () => {
  const stop = { ...row(`pickup-${pickupId}`, "Stop 2 · Havnegade 4", "Pickup"), status: "Failed", submittedValues: { routeId: rc1042.id } }
  const withStop: ServerRecordsState = new Map([...state, ["route-studio.pickups", loaded({ records: [stop], serverIds: serverIdsOf([stop], [pickupId]) }, 1)]])
  const minted = (values: Record<string, string>): BusinessRecord => ({ ...record, id: "operate-ticket-1700000000000", name: values.subject ?? "", recordKind: "Ticket", projectIds: [projectRecord.id], submittedValues: { projectId: projectRecord.id, subject: "Bin not emptied", description: "Not emptied on Monday", kind: "missed-collection", ...values } })
  const evidence: StopEvidence = {
    pickupId,
    routeId,
    outcome: "failed",
    reason: "not-presented",
    service: "empty",
    corrected: false,
    at: "2026-10-05T05:12:00.000Z",
    location: { type: "Point", coordinates: [12.5683, 55.6761] },
    proofs: [{ id: "01a0d2a4-a280-7034-8000-000000000001", kind: "failure", source: "driver-app", occurredAt: "2026-10-05T05:12:00.000Z", reason: "not-presented", outcome: null, objectKey: null }],
    reply: "Our driver was at the address at 07:12 on Monday 5 October and recorded that the bin was not put out for collection.",
    answeredByRecord: true,
  }

  test("the office's create leaves the answer from the record to the API's default, and sends only its opt-out", () => {
    const body = (answerFromRecord: boolean) => ticketAdapter.toCreateBody?.({ ...minted({ routeId: rc1042.id, pickupId: stop.id }), submittedValues: { ...minted({ routeId: rc1042.id, pickupId: stop.id }).submittedValues, answerFromRecord } }, context(resolverOver(withStop))) as Record<string, unknown>
    assert.equal("answerFromRecord" in body(true), false, "the API's default is the answer")
    assert.equal(body(false).answerFromRecord, false)
    assert.ok(TicketCreate.safeParse(body(false)).success)
  })

  test("the office's create names the stop with its route, by server id, and refuses a stop without its route or of another", () => {
    const body = ticketAdapter.toCreateBody?.(minted({ routeId: rc1042.id, pickupId: stop.id }), context(resolverOver(withStop)))
    assert.deepEqual((body as { links: unknown }).links, { routeId, pickupId })
    assert.ok(TicketCreate.safeParse(body).success)
    assert.deepEqual(ticketAdapter.toCreateBody?.(minted({ pickupId: stop.id }), context(resolverOver(withStop))), { path: "pickupId", message: "Pick a stop on the ticket's route" })
    assert.deepEqual(ticketAdapter.toCreateBody?.(minted({ routeId: rc1040.id, pickupId: stop.id }), context(resolverOver(withStop))), { path: "pickupId", message: "Pick a stop on the ticket's route" }, "picked before the route was changed")
    assert.deepEqual((ticketAdapter.toCreateBody?.(minted({ routeId: rc1042.id, pickupId: NO_ONE }), context(resolverOver(withStop))) as { links: unknown }).links, { routeId }, "the picker's None is no stop")
  })

  test("the stop is picked among the route's, whatever their outcome, after None", () => {
    assert.deepEqual(ticketStopOptions([stop], undefined), [{ value: NO_ONE, label: "None" }], "only None until a route is picked")
    assert.deepEqual(ticketStopOptions([stop], rc1042.id), [{ value: NO_ONE, label: "None" }, { value: stop.id, label: "Stop 2 · Havnegade 4 · Failed" }], "a missed stop is what a complaint is about")
    assert.deepEqual(ticketStopOptions([stop], rc1040.id), [{ value: NO_ONE, label: "None" }])
  })

  test("a create the record answered comes back completed and is told so", () => {
    assert.deepEqual(ticketOpened({ ...record, status: "Completed" }), { title: "Ticket answered", description: "T-1001 was answered with the stop's record; the reply is on the customer's thread." })
  })

  test("is read whole from the ticket's evidence, and the details read its outcome and its place", async () => {
    assert.ok(StopEvidence.safeParse(evidence).success)
    const { fetch, calls } = scripted([() => json({ stop: evidence } satisfies TicketEvidence), () => json({ stop: null })])
    assert.deepEqual(await ticketEvidence(clientOver(fetch), missed.id), evidence)
    assert.equal(calls[0].url, `http://api.test/tickets/${missed.id}/evidence`)
    assert.equal(await ticketEvidence(clientOver(fetch), missed.id), null, "a ticket about no stop")
    assert.equal(evidenceOutcome(evidence), "Failed · Not presented")
    assert.equal(evidenceOutcome({ outcome: "completed", reason: null, corrected: false }), "Completed")
    assert.equal(evidenceOutcome({ outcome: "failed", reason: "not-presented", corrected: true }), "Failed · Not presented · corrected by the office")
    assert.equal(evidenceProofLine(evidence.proofs[0], "Europe/Copenhagen"), "2026-10-05 07:12 · Failure · Driver app · Not presented")
    assert.equal(evidencePlace(evidence.location), "55.67610, 12.56830", "latitude first, as a person reads a place")
    assert.equal(evidencePlace(null), "Not recorded")
  })

  test("the reply is a command: its note where said and whether it completes, and the ticket the API answers replaces the row", async () => {
    const reply = ticketAdapter.commands?.[REPLY_WITH_EVIDENCE]
    assert.deepEqual(reply?.toBody?.({}, record, context()), { complete: false })
    const said = reply?.toBody?.({ note: "Sorry for the trouble", complete: true }, record, context())
    assert.deepEqual(said, { note: "Sorry for the trouble", complete: true })
    assert.ok(TicketReplyWithEvidence.safeParse(said).success)
    const answered: TicketDetail = { ...missed, status: "completed", resolution: "answered", closedAt: "2026-10-05T10:00:00.000Z", events: [], alerts: [] }
    const { fetch, calls } = scripted([() => json(answered, 201)])
    const outcome = await commandRecord(clientOver(fetch), ticketsModule, current, record, REPLY_WITH_EVIDENCE, { complete: true }, options)
    assert.equal(calls[0].url, `http://api.test/tickets/${missed.id}/reply-with-evidence`)
    assert.deepEqual(bodyOf(calls[0]), { complete: true })
    assert.equal(outcome.kind, "done")
    if (outcome.kind === "done") assert.deepEqual([outcome.record.id, outcome.record.status], [record.id, "Completed"])
  })

  test("its dialog offers the completion on an open ticket alone; a closed one takes the reply", () => {
    const fieldsOf = (open: boolean) => replyWithEvidenceForm(open).sections.flatMap((section) => section.fields.map((field) => field.id))
    assert.deepEqual(fieldsOf(true), ["note", "complete"])
    assert.deepEqual(fieldsOf(false), ["note"])
  })
})
