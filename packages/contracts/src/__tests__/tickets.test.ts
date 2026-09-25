import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { TICKET_EVENT_SHAPES, ticketEventShape, ticketEventShapeIssue, type TicketEventRow } from "@waste/domain/resolution/event-shapes"
import { TICKET_EVENT_KINDS, TICKET_STATUSES, TICKET_VISIBILITIES, type TicketEventKind } from "@waste/domain/resolution/vocabulary"

import { DAY_WINDOW_ORDERED } from "../queries"
import {
  LABEL_IS_THE_NUMBER,
  labelMatches,
  PICKUP_WITH_ITS_ROUTE,
  pickupWithItsRoute,
  pickupWithItsRouteOnPatch,
  RECOLLECTION_ROUTE_WITH_RECOLLECTED,
  recollectionRouteWithRecollected,
  Ticket,
  TicketAssign,
  TicketComment,
  TicketComplete,
  TicketCreate,
  TicketDetail,
  TicketEvent,
  TicketEventListQuery,
  TicketHold,
  TicketLinks,
  TicketListQuery,
  TicketPatch,
  TicketReject,
  TicketReopen,
  TicketStart,
  TicketWait,
} from "../tickets"
import { refusal, refusesAnEmptyPatch, refusesWhatTheServerOwns } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const THIRD = "01a0d3a5-e5e0-7000-8000-000000000003"
const STAMPS = { createdAt: "2026-10-05T06:30:00.000Z", updatedAt: "2026-10-05T07:00:00.000Z" }
const WHEN = "2026-10-05T06:25:00.000Z"
const KEY = `${OTHER}/${ID}/${THIRD}.pdf`

const links = { routeId: OTHER, pickupId: THIRD, containerId: ID, propertyId: OTHER, sharedCollectionPointId: null, customerId: THIRD, agreementId: null, driverId: OTHER, parentTicketId: null }

const ticket = {
  id: ID,
  projectId: OTHER,
  number: 8831,
  label: "T-8831",
  kind: "missed-collection",
  status: "open",
  priority: "high",
  source: "office",
  subject: "Missed collection: BIN-82014 at Parkvej 18",
  description: "The driver could not collect this stop. Reason: inaccessible.",
  occurredAt: WHEN,
  dueAt: null,
  assigneeUserAccountId: THIRD,
  createdBy: OTHER,
  sourceEventId: null,
  links,
  resolution: null,
  recollectionRouteId: null,
  closedAt: null,
  ...STAMPS,
}

/** The columns the shape decides over, as a full row would carry them, on a completed ticket. */
const full = { body: "Re-collected on Friday", objectKey: KEY, visibility: "customer", resolution: "recollected" } as const

/** The one row of each kind that carries exactly what the kind requires and nothing it forbids, on an open ticket. */
const exemplar = (kind: TicketEventKind): TicketEventRow => {
  const shape = TICKET_EVENT_SHAPES[kind]
  return { status: "in-progress", body: shape.body === "none" ? null : full.body, objectKey: shape.objectKey === "none" ? null : full.objectKey, visibility: "internal", resolution: null }
}

/** A whole history row of the kind, on the wire: the exemplar's columns beside the ids and the stamp. */
const event = (kind: TicketEventKind, row: TicketEventRow = exemplar(kind)) => ({ id: THIRD, recordedAt: WHEN, projectId: OTHER, ticketId: ID, kind, assigneeUserAccountId: THIRD, sourceEventId: null, recordedBy: OTHER, ...row })

const alert = {
  id: OTHER,
  projectId: OTHER,
  kind: "route-exception",
  severity: "high",
  source: "manual",
  status: "new",
  title: "Route RC-1042 ended with a stop uncollected",
  details: "One failed pickup at Parkvej 18",
  detectedAt: WHEN,
  routeId: OTHER,
  vehicleId: null,
  driverId: null,
  containerId: null,
  ticketId: ID,
  raisedBy: OTHER,
  acknowledgedAt: null,
  acknowledgedBy: null,
  resolvedAt: null,
  resolvedBy: null,
  resolutionNote: null,
  ...STAMPS,
}

describe("Ticket", () => {
  test("carries its number under the label, its provenance, what it is about and the three closing columns; a consumer's ticket has no person and an event", () => {
    assert.deepEqual(Ticket.parse(ticket), ticket)
    const consumers = { ...ticket, source: "driver-app", createdBy: null, sourceEventId: THIRD, assigneeUserAccountId: null }
    assert.deepEqual(Ticket.parse(consumers), consumers)
    const completed = { ...ticket, status: "completed", resolution: "recollected", recollectionRouteId: THIRD, closedAt: "2026-10-06T09:00:00.000Z" }
    assert.deepEqual(Ticket.parse(completed), completed)
    assert.equal(Object.keys(TicketLinks.shape).length, 9)
  })

  test("holds the label to the number", () => {
    assert.deepEqual(refusal(Ticket.safeParse({ ...ticket, label: "T-8832" })), [{ path: "label", message: LABEL_IS_THE_NUMBER }])
    assert.deepEqual(refusal(Ticket.safeParse({ ...ticket, label: "RC-8831" })), [{ path: "label", message: LABEL_IS_THE_NUMBER }])
    assert.equal(labelMatches({ number: 7, label: "T-7" }), true)
    assert.equal(labelMatches({ number: 7, label: "T-8" }), false)
    // The label moves with the number, so the number's own rule is the one issue.
    assert.deepEqual(refusal(Ticket.safeParse({ ...ticket, number: 0, label: "T-0" })).map((issue) => issue.path), ["number"])
  })

  test("holds every enum to its vocabulary and the text to its shape", () => {
    for (const [field, value] of [
      ["kind", "deviation"],
      ["status", "created"],
      ["priority", "urgent"],
      ["source", "driver"],
      ["resolution", "rescheduled"],
    ] as const) {
      assert.deepEqual(refusal(Ticket.safeParse({ ...ticket, [field]: value })).map((issue) => issue.path), [field], field)
    }
    assert.deepEqual(refusal(Ticket.safeParse({ ...ticket, subject: "   " })).map((issue) => issue.path), ["subject"])
    assert.deepEqual(refusal(Ticket.safeParse({ ...ticket, links: { ...links, pickupId: "pickup-12" } })).map((issue) => issue.path), ["links.pickupId"])
  })

  test("TicketDetail is the ticket with its history in recording order and the alerts naming it", () => {
    const detail = { ...ticket, events: [event("created", { ...exemplar("created"), status: "open" }), event("comment")], alerts: [alert] }
    assert.deepEqual(TicketDetail.parse(detail), detail)
    assert.deepEqual(refusal(TicketDetail.safeParse({ ...detail, label: "T-1" })), [{ path: "label", message: LABEL_IS_THE_NUMBER }])
    assert.deepEqual(TicketDetail.parse({ ...detail, events: [], alerts: [] }), { ...detail, events: [], alerts: [] })
  })
})

describe("TicketCreate", () => {
  const body = { projectId: OTHER, subject: "Call the customer back", description: "About the container request", kind: "internal-task" }

  test("takes the case's own words and kind, defaulting the priority to none and the source to office, and may name what it is about, the assignee and an alert", () => {
    assert.deepEqual(TicketCreate.parse(body), { ...body, priority: "none", source: "office" })
    const whole = { ...body, priority: "high", source: "phone", occurredAt: WHEN, dueAt: "2026-10-07T12:00:00.000Z", assigneeUserAccountId: THIRD, links: { routeId: OTHER, pickupId: THIRD, customerId: ID }, alertId: OTHER }
    assert.deepEqual(TicketCreate.parse(whole), whole)
    assert.deepEqual(TicketCreate.parse({ ...body, dueAt: null, assigneeUserAccountId: null, links: {} }), { ...body, priority: "none", source: "office", dueAt: null, assigneeUserAccountId: null, links: {} })
  })

  test("refuses what the server owns by name: the id and the stamps, the number, the status, the closing, the creator and the event", () => {
    refusesWhatTheServerOwns(TicketCreate, body)
    for (const [key, value] of [
      ["number", 8831],
      ["label", "T-8831"],
      ["status", "open"],
      ["closedAt", WHEN],
      ["createdBy", OTHER],
      ["sourceEventId", OTHER],
      ["resolution", "answered"],
      ["recollectionRouteId", OTHER],
    ] as const) {
      const issues = refusal(TicketCreate.safeParse({ ...body, [key]: value }))
      assert.deepEqual(
        issues.map((issue) => issue.path),
        [""],
        key,
      )
      assert.match(issues[0].message, new RegExp(key))
    }
  })

  test("never comes from the driver's device or the dispatcher's cancellation: those are the consumer's", () => {
    for (const source of ["driver-app", "dispatch"]) assert.deepEqual(refusal(TicketCreate.safeParse({ ...body, source })).map((issue) => issue.path), ["source"], source)
    for (const source of ["office", "phone", "email", "portal", "import", "integration"]) assert.equal(TicketCreate.safeParse({ ...body, source }).success, true, source)
  })

  test("a pickup names its route", () => {
    assert.deepEqual(refusal(TicketCreate.safeParse({ ...body, links: { pickupId: THIRD } })), [{ path: "links.pickupId", message: PICKUP_WITH_ITS_ROUTE }])
    assert.deepEqual(refusal(TicketCreate.safeParse({ ...body, links: { pickupId: THIRD, routeId: null } })), [{ path: "links.pickupId", message: PICKUP_WITH_ITS_ROUTE }])
    assert.equal(TicketCreate.safeParse({ ...body, links: { pickupId: THIRD, routeId: OTHER } }).success, true)
    assert.equal(TicketCreate.safeParse({ ...body, links: { routeId: OTHER } }).success, true, "a route without a pickup is a ticket about the route")
    assert.equal(pickupWithItsRoute(undefined), true)
    assert.equal(pickupWithItsRoute({ pickupId: null }), true)
    assert.equal(pickupWithItsRoute({ pickupId: THIRD }), false)
    // A link the server owns nothing of but its shape: an unknown member is refused by name.
    assert.deepEqual(refusal(TicketCreate.safeParse({ ...body, links: { vehicleId: OTHER } })).map((issue) => issue.path), ["links"])
    assert.deepEqual(refusal(TicketCreate.safeParse({ ...body, links: { routeId: "route-1" } })).map((issue) => issue.path), ["links.routeId"])
  })

  test("holds the instants, the text and the kind to their shapes", () => {
    assert.deepEqual(refusal(TicketCreate.safeParse({ ...body, occurredAt: "2026-10-05 06:25" })).map((issue) => issue.path), ["occurredAt"])
    assert.deepEqual(refusal(TicketCreate.safeParse({ ...body, subject: "  " })).map((issue) => issue.path), ["subject"])
    assert.deepEqual(refusal(TicketCreate.safeParse({ ...body, kind: "task" })).map((issue) => issue.path), ["kind"])
    assert.deepEqual(refusal(TicketCreate.safeParse({ ...body, projectId: undefined })).map((issue) => issue.path), ["projectId"])
  })
})

describe("TicketPatch", () => {
  test("moves the case's own fields, each optional, and refuses an empty patch", () => {
    refusesAnEmptyPatch(TicketPatch)
    assert.deepEqual(TicketPatch.parse({ priority: "critical" }), { priority: "critical" })
    assert.deepEqual(TicketPatch.parse({ dueAt: null, links: { customerId: null, agreementId: OTHER } }), { dueAt: null, links: { customerId: null, agreementId: OTHER } })
    assert.deepEqual(TicketPatch.parse({ subject: "New subject", description: "New words", kind: "complaint" }), { subject: "New subject", description: "New words", kind: "complaint" })
  })

  test("never the status, the assignee, the source, the project, the number, the resolution or the stamps", () => {
    for (const [key, value] of [
      ["status", "completed"],
      ["assigneeUserAccountId", OTHER],
      ["source", "phone"],
      ["projectId", OTHER],
      ["number", 1],
      ["label", "T-1"],
      ["resolution", "answered"],
      ["recollectionRouteId", OTHER],
      ["closedAt", WHEN],
      ["occurredAt", WHEN],
      ["createdBy", OTHER],
      ["sourceEventId", OTHER],
      ["updatedAt", WHEN],
    ] as const) {
      // A field the patch takes stands beside the refused one, so the strict object's refusal is the one issue and not "nothing to change" as well.
      const issues = refusal(TicketPatch.safeParse({ priority: "low", [key]: value }))
      assert.deepEqual(
        issues.map((issue) => issue.path),
        [""],
        key,
      )
      assert.match(issues[0].message, new RegExp(key))
    }
  })

  test("holds the pickup rule where both halves are in the body, and leaves a pickup moved alone to the route against the stored row", () => {
    assert.deepEqual(refusal(TicketPatch.safeParse({ links: { pickupId: THIRD, routeId: null } })), [{ path: "links.pickupId", message: PICKUP_WITH_ITS_ROUTE }])
    assert.equal(TicketPatch.safeParse({ links: { pickupId: THIRD } }).success, true, "the stored route holds it")
    assert.equal(TicketPatch.safeParse({ links: { pickupId: THIRD, routeId: OTHER } }).success, true)
    assert.equal(TicketPatch.safeParse({ links: { pickupId: null, routeId: null } }).success, true, "both cleared")
    assert.equal(pickupWithItsRouteOnPatch({ pickupId: THIRD }), true)
    assert.equal(pickupWithItsRouteOnPatch({ pickupId: THIRD, routeId: null }), false)
    assert.equal(pickupWithItsRouteOnPatch(undefined), true)
  })
})

describe("the seven commands and the comment", () => {
  test("assign takes an account or null for nobody, with a note if any", () => {
    assert.deepEqual(TicketAssign.parse({ assigneeUserAccountId: THIRD }), { assigneeUserAccountId: THIRD })
    assert.deepEqual(TicketAssign.parse({ assigneeUserAccountId: null, note: "Back to the queue" }), { assigneeUserAccountId: null, note: "Back to the queue" })
    assert.deepEqual(refusal(TicketAssign.safeParse({})).map((issue) => issue.path), ["assigneeUserAccountId"])
    assert.deepEqual(refusal(TicketAssign.safeParse({ assigneeUserAccountId: THIRD, status: "in-progress" })).map((issue) => issue.path), [""])
  })

  test("start takes a note if any; wait and hold say what they wait for; reject gives a reason; reopen says why", () => {
    assert.deepEqual(TicketStart.parse({}), {})
    assert.deepEqual(TicketStart.parse({ note: "On it" }), { note: "On it" })
    assert.deepEqual(TicketWait.parse({ note: "Asked the customer for a photo" }), { note: "Asked the customer for a photo" })
    assert.deepEqual(refusal(TicketWait.safeParse({})).map((issue) => issue.path), ["note"])
    assert.deepEqual(refusal(TicketHold.safeParse({ note: " " })).map((issue) => issue.path), ["note"])
    assert.deepEqual(TicketReject.parse({ reason: "Not our container" }), { reason: "Not our container" })
    assert.deepEqual(refusal(TicketReject.safeParse({ note: "Not our container" })).map((issue) => issue.path).sort(), ["", "reason"])
    assert.deepEqual(TicketReopen.parse({ note: "The customer called again" }), { note: "The customer called again" })
    assert.deepEqual(refusal(TicketReopen.safeParse({})).map((issue) => issue.path), ["note"])
  })

  test("complete takes the resolution and the note, and the re-collection's route with recollected alone", () => {
    assert.deepEqual(TicketComplete.parse({ resolution: "answered", note: "Explained the schedule" }), { resolution: "answered", note: "Explained the schedule" })
    assert.deepEqual(TicketComplete.parse({ resolution: "recollected", note: "On Friday's route", recollectionRouteId: OTHER }), { resolution: "recollected", note: "On Friday's route", recollectionRouteId: OTHER })
    assert.equal(TicketComplete.safeParse({ resolution: "recollected", note: "Arranged by phone" }).success, true, "recollected without a route is allowed: the extra pickup is Execution's deferred change")
    assert.deepEqual(refusal(TicketComplete.safeParse({ resolution: "serviced", note: "Delivered", recollectionRouteId: OTHER })), [{ path: "recollectionRouteId", message: RECOLLECTION_ROUTE_WITH_RECOLLECTED }])
    assert.deepEqual(refusal(TicketComplete.safeParse({ resolution: "answered" })).map((issue) => issue.path), ["note"])
    assert.deepEqual(refusal(TicketComplete.safeParse({ resolution: "rescheduled", note: "x" })).map((issue) => issue.path), ["resolution"])
    assert.equal(recollectionRouteWithRecollected({ resolution: "recollected", recollectionRouteId: OTHER }), true)
    assert.equal(recollectionRouteWithRecollected({ resolution: "no-action", recollectionRouteId: OTHER }), false)
    assert.equal(recollectionRouteWithRecollected({ resolution: "no-action" }), true)
  })

  test("a comment carries a body, is internal unless said, and may attach a pdf", () => {
    assert.deepEqual(TicketComment.parse({ body: "Called the customer" }), { body: "Called the customer", visibility: "internal" })
    assert.deepEqual(TicketComment.parse({ body: "We will re-collect on Friday", visibility: "customer", objectKey: KEY }), { body: "We will re-collect on Friday", visibility: "customer", objectKey: KEY })
    assert.deepEqual(refusal(TicketComment.safeParse({ body: "x", objectKey: `${OTHER}/${ID}/${THIRD}.gif` })).map((issue) => issue.path), ["objectKey"])
    assert.deepEqual(refusal(TicketComment.safeParse({ body: "x", visibility: "public" })).map((issue) => issue.path), ["visibility"])
    assert.deepEqual(refusal(TicketComment.safeParse({ visibility: "customer" })).map((issue) => issue.path), ["body"])
    assert.deepEqual(refusal(TicketComment.safeParse({ body: "x", kind: "comment" })).map((issue) => issue.path), [""])
  })
})

describe("TicketEvent", () => {
  test("is a ledger row — an id and recordedAt, never updatedAt — that parses whole for every kind's exemplar", () => {
    for (const kind of TICKET_EVENT_KINDS) assert.deepEqual(TicketEvent.parse(event(kind)), event(kind), kind)
    assert.equal("updatedAt" in TicketEvent.shape, false)
    assert.equal("createdAt" in TicketEvent.shape, false)
    const consumers = event("comment", { ...exemplar("comment"), body: "Rejected command: Pickup 1 is already completed", objectKey: null })
    assert.deepEqual(TicketEvent.parse({ ...consumers, recordedBy: null, sourceEventId: THIRD }), { ...consumers, recordedBy: null, sourceEventId: THIRD })
  })

  test("runs the domain's table as its refine: a row that disagrees with its kind does not parse, and the sentence names the column at kind", () => {
    let disagreements = 0
    for (const kind of TICKET_EVENT_KINDS) {
      const variations: TicketEventRow[] = []
      for (const column of ["body", "objectKey"] as const) variations.push({ ...exemplar(kind), [column]: full[column] }, { ...exemplar(kind), [column]: null })
      for (const visibility of TICKET_VISIBILITIES) variations.push({ ...exemplar(kind), visibility })
      for (const status of TICKET_STATUSES) variations.push({ ...exemplar(kind), status, resolution: full.resolution }, { ...exemplar(kind), status, resolution: null })
      for (const row of variations) {
        const expected = ticketEventShape(kind, row)
        const result = TicketEvent.safeParse(event(kind, row))
        assert.equal(result.success, expected, `${kind}: ${JSON.stringify(row)}`)
        if (!expected) {
          disagreements += 1
          assert.deepEqual(refusal(result), [{ path: "kind", message: ticketEventShapeIssue(kind, row) }])
        }
      }
    }
    assert.ok(disagreements > 20, `${disagreements} disagreements refused`)
    assert.deepEqual(refusal(TicketEvent.safeParse(event("created", { ...exemplar("created"), body: "x" }))), [{ path: "kind", message: "A created event carries no body" }])
    assert.deepEqual(refusal(TicketEvent.safeParse(event("status-changed", { ...exemplar("status-changed"), status: "completed" }))), [{ path: "kind", message: "A status-changed event carries a resolution exactly when its status is completed" }])
    assert.deepEqual(refusal(TicketEvent.safeParse(event("assigned", { ...exemplar("assigned"), visibility: "customer" }))), [{ path: "kind", message: "A assigned event is internal" }])
  })

  test("holds the attachment key to its shape and the enums to their vocabularies", () => {
    assert.deepEqual(refusal(TicketEvent.safeParse(event("comment", { ...exemplar("comment"), objectKey: "letter.pdf" }))).map((issue) => issue.path), ["objectKey"])
    assert.deepEqual(refusal(TicketEvent.safeParse({ ...event("comment"), kind: "message" })).map((issue) => issue.path), ["kind"])
    assert.deepEqual(refusal(TicketEvent.safeParse({ ...event("comment"), status: "created" })).map((issue) => issue.path), ["status"])
    assert.deepEqual(refusal(TicketEvent.safeParse(event("status-changed", { ...exemplar("status-changed"), status: "completed", resolution: "rescheduled" }))).map((issue) => issue.path), ["resolution"])
  })
})

describe("the list queries", () => {
  test("TicketListQuery pages by project, status or open, kind, priority, source, assignee, the six links, and a window over occurredAt", () => {
    assert.deepEqual(TicketListQuery.parse({}), { limit: 50 })
    assert.deepEqual(TicketListQuery.parse({ open: "true", status: "pending", customerId: ID, from: "2026-10-01", to: "2026-10-31" }), { limit: 50, open: true, status: "pending", customerId: ID, from: "2026-10-01", to: "2026-10-31" })
    assert.deepEqual(TicketListQuery.parse({ open: "false" }).open, false)
    for (const wrong of ["yes", "TRUE", "1", ""]) assert.deepEqual(refusal(TicketListQuery.safeParse({ open: wrong })).map((issue) => issue.path), ["open"], wrong)
    assert.deepEqual(refusal(TicketListQuery.safeParse({ from: "2026-10-31", to: "2026-10-01" })), [{ path: "to", message: DAY_WINDOW_ORDERED }])
    assert.equal(TicketListQuery.safeParse({ from: "2026-10-05", to: "2026-10-05" }).success, true, "a window of one day")
    assert.deepEqual(refusal(TicketListQuery.safeParse({ kind: "deviation" })).map((issue) => issue.path), ["kind"])
    for (const field of ["assigneeUserAccountId", "propertyId", "routeId", "pickupId", "containerId", "driverId", "projectId"]) {
      assert.equal(TicketListQuery.safeParse({ [field]: OTHER }).success, true, field)
      assert.deepEqual(refusal(TicketListQuery.safeParse({ [field]: "x" })).map((issue) => issue.path), [field], field)
    }
  })

  test("TicketEventListQuery pages one ticket's history by kind and by who may read it", () => {
    assert.deepEqual(TicketEventListQuery.parse({}), { limit: 50 })
    assert.deepEqual(TicketEventListQuery.parse({ kind: "comment", visibility: "customer", limit: "20" }), { limit: 20, kind: "comment", visibility: "customer" })
    assert.deepEqual(refusal(TicketEventListQuery.safeParse({ visibility: "public" })).map((issue) => issue.path), ["visibility"])
    assert.equal("projectId" in TicketEventListQuery.shape, false, "a ticket's history is the ticket's, not a project's")
  })
})
