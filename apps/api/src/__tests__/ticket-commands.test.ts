// The ticket endpoints (Issue #109): assign, the machine status by status and
// command by command, complete, reject and reopen, and the history, over the
// setup ticket-suite.ts shares with tickets.test.ts and
// ticket-evidence.test.ts.
import assert from "node:assert/strict"
import { before, describe, test } from "node:test"

import { RECOLLECTION_ROUTE_WITH_RECOLLECTED, Ticket, TicketEvent } from "@waste/contracts/tickets"
import { type Database } from "@waste/db/client"
import { TICKET_COMMAND_TARGETS, TICKET_COMMANDS } from "@waste/domain/resolution/transitions"
import { isClosedTicketStatus, TICKET_STATUSES } from "@waste/domain/resolution/vocabulary"

import { type Call } from "./calls"
import { seedRoute, type ExecutionFixtures, type SeededRoute } from "./execution-fixtures"
import { type FleetFixtures } from "./scheme-fixtures"
import { testId, type Tenant } from "./tenant"
import { database, EventPage, NOON, owner, ticketCalls, ticketSuite } from "./ticket-suite"

describe("the ticket endpoints", { skip: database.skip || owner.skip }, () => {
  const suite = ticketSuite()
  let pool: Database
  let a: Tenant
  let fleet: FleetFixtures
  let ex: ExecutionFixtures
  let olivia: Call
  let viewer: Call
  let lars: Call
  let ungranted: Call
  let harbors: Ticket
  let theirs: Ticket
  let harborRoute: SeededRoute

  before(() => {
    ;({ pool, a, fleet, ex, olivia, viewer, lars, ungranted, harbors, theirs, harborRoute } = suite.current)
  })

  const { refused, opened, read, command, commanded, history, eventsAbout, bodyFor, inStatus } = ticketCalls(() => suite.current)

  describe("POST /tickets/:id/assign", () => {
    test("moves the assignee with an assigned event carrying the note, clears with null, and answers the same assignee without a write", async () => {
      const fresh = await opened()
      const assigned = await commanded(fresh.id, "assign", { assigneeUserAccountId: a.users.viewer.id, note: "Vera knows the street" })
      assert.deepEqual([assigned.assigneeUserAccountId, assigned.status], [a.users.viewer.id, "open"])
      const again = await commanded(fresh.id, "assign", { assigneeUserAccountId: a.users.viewer.id, note: "Again" })
      assert.deepEqual(again, assigned, "idempotent: the same row")
      const cleared = await commanded(fresh.id, "assign", { assigneeUserAccountId: null })
      assert.equal(cleared.assigneeUserAccountId, null)
      assert.deepEqual((await history(fresh.id)).map((event) => [event.kind, event.status, event.assigneeUserAccountId, event.body]), [
        ["created", "open", null, null],
        ["assigned", "open", a.users.viewer.id, "Vera knows the street"],
        ["assigned", "open", null, null],
      ], "one event per move, none for the repeat")
      const outbox = await eventsAbout(fresh.id)
      assert.deepEqual(outbox.map((event) => event.kind), ["ticket-opened", "ticket-assigned"], "the assignment to Vera is the staff notices' news (O16 of #290); the repeat and the clearing are nobody's")
      assert.deepEqual(Ticket.parse(outbox[1].payload), assigned, "the payload is the ticket as answered")
    })

    test("holds the account to the company and the project (400), and a closed ticket refuses whatever the body says (409)", async () => {
      const fresh = await opened()
      assert.deepEqual((await refused(await command(fresh.id, "assign", { assigneeUserAccountId: testId() }), 400)).errors, [{ path: "assigneeUserAccountId", message: "Not a user account of this company" }])
      assert.deepEqual((await refused(await command(fresh.id, "assign", { assigneeUserAccountId: a.users.deactivated.id }), 400)).errors, [{ path: "assigneeUserAccountId", message: "Not a user account of this company" }])
      assert.deepEqual((await refused(await command(fresh.id, "assign", { assigneeUserAccountId: a.users.lars.id }), 400)).errors, [{ path: "assigneeUserAccountId", message: "Not a user account working in this project" }])
      assert.deepEqual((await refused(await command(harbors.id, "assign", { assigneeUserAccountId: a.users.viewer.id }), 400)).errors, [{ path: "assigneeUserAccountId", message: "Not a user account working in this project" }])
      assert.deepEqual((await refused(await command(fresh.id, "assign", {}), 400)).errors?.map((error) => error.path), ["assigneeUserAccountId"])
      const done = await inStatus("completed")
      assert.equal((await refused(await command(done.id, "assign", { assigneeUserAccountId: testId() }), 409)).detail, `Ticket ${done.label} is completed; reopen it first`, "the ticket's own state is judged before the body")
      await refused(await command(theirs.id, "assign", { assigneeUserAccountId: null }), 404)
      await refused(await command(harbors.id, "assign", { assigneeUserAccountId: null }, viewer), 404)
      assert.match((await refused(await command(harbors.id, "assign", { assigneeUserAccountId: null }, ungranted), 403)).detail ?? "", /edit on operate\.tickets/)
      assert.equal((await read(fresh.id)).assigneeUserAccountId, null, "untouched")
    })
  })

  describe("the machine, status by status and command by command", () => {
    for (const status of TICKET_STATUSES) {
      test(`a ${status} ticket under every command: a move writes the row and one event, a stay writes nothing, a closed ticket refuses in the machine's words`, async () => {
        for (const verb of TICKET_COMMANDS) {
          const before = await inStatus(status)
          const eventsBefore = (await history(before.id)).length
          const response = await command(before.id, verb, bodyFor[verb])
          const expected = isClosedTicketStatus(status) ? (verb === "reopen" ? "open" : "refuse") : verb === "reopen" || TICKET_COMMAND_TARGETS[verb] === status ? "stay" : TICKET_COMMAND_TARGETS[verb]
          const where = `${verb} on ${status}`
          if (expected === "refuse") {
            assert.equal((await refused(response, 409)).detail, `Ticket ${before.label} is ${status}; reopen it first`, where)
            assert.equal((await history(before.id)).length, eventsBefore, `${where}: nothing appended`)
          } else if (expected === "stay") {
            assert.equal(response.status, 200, `${where}: ${JSON.stringify(await response.clone().json())}`)
            assert.deepEqual(Ticket.parse(await response.json()), before, `${where}: the row as it stands, the stamp included`)
            assert.equal((await history(before.id)).length, eventsBefore, `${where}: nothing appended`)
          } else {
            assert.equal(response.status, 200, `${where}: ${JSON.stringify(await response.clone().json())}`)
            const after = Ticket.parse(await response.json())
            assert.equal(after.status, expected, where)
            const events = await history(before.id)
            assert.equal(events.length, eventsBefore + 1, `${where}: exactly one event`)
            const last = events[events.length - 1]
            assert.deepEqual([last.kind, last.status, last.assigneeUserAccountId, last.recordedBy], ["status-changed", expected, after.assigneeUserAccountId, a.users.olivia.id], `${where}: the snapshot after the event`)
            const note = (bodyFor[verb] as { note?: string; reason?: string }).note ?? (bodyFor[verb] as { reason?: string }).reason ?? null
            assert.equal(last.body, note, `${where}: the body's note`)
          }
        }
      })
    }
  })

  describe("POST /tickets/:id/complete", () => {
    test("completes with the resolution, the closing instant and the event carrying both, writes ticket-completed, and takes a re-collection route that has not ended", async () => {
      const fresh = await opened({ answerFromRecord: false, links: { routeId: ex.routes.completed.id, pickupId: ex.routes.completed.pickupIds[1] } })
      await commanded(fresh.id, "start", {})
      const done = await commanded(fresh.id, "complete", { resolution: "recollected", note: "Re-collected on Tuesday's route", recollectionRouteId: ex.routes.ready.id })
      assert.deepEqual([done.status, done.resolution, done.recollectionRouteId, done.closedAt], ["completed", "recollected", ex.routes.ready.id, NOON.toISOString()])
      const events = await history(fresh.id)
      assert.deepEqual(events.map((event) => [event.kind, event.status, event.resolution, event.body]), [
        ["created", "open", null, null],
        ["status-changed", "in-progress", null, null],
        ["status-changed", "completed", "recollected", "Re-collected on Tuesday's route"],
      ])
      const outbox = await eventsAbout(fresh.id)
      assert.deepEqual(outbox.map((event) => event.kind), ["ticket-opened", "ticket-completed"], "opened and completed, and nothing for the start")
      assert.deepEqual([outbox[1].aggregateKind, outbox[1].projectId, outbox[1].occurredAt.toISOString()], ["ticket", fresh.projectId, NOON.toISOString()])
      assert.deepEqual(Ticket.parse(outbox[1].payload), done, "the payload is the ticket as answered, resolution included")
      const again = await refused(await command(fresh.id, "complete", { resolution: "no-action", note: "Twice" }), 409)
      assert.equal(again.detail, `Ticket ${done.label} is completed; reopen it first`, "not idempotent: a second resolution is a change a person meant")
      assert.equal((await eventsAbout(fresh.id)).length, 2)
      const plain = await commanded((await opened()).id, "complete", { resolution: "answered", note: "Told the customer the collection day" })
      assert.deepEqual([plain.resolution, plain.recollectionRouteId], ["answered", null])
    })

    test("holds the re-collection route to recollected and to the project (400), then to a route that has not ended (409)", async () => {
      const fresh = await opened()
      const withServiced = await refused(await command(fresh.id, "complete", { resolution: "serviced", note: "x", recollectionRouteId: ex.routes.ready.id }), 400)
      assert.deepEqual(withServiced.errors, [{ path: "recollectionRouteId", message: RECOLLECTION_ROUTE_WITH_RECOLLECTED }])
      const elsewhere = await refused(await command(fresh.id, "complete", { resolution: "recollected", note: "x", recollectionRouteId: harborRoute.id }), 400)
      assert.deepEqual(elsewhere.errors, [{ path: "recollectionRouteId", message: "Not a route of this project" }])
      assert.deepEqual((await refused(await command(fresh.id, "complete", { resolution: "recollected", note: "x", recollectionRouteId: testId() }), 400)).errors?.map((error) => error.path), ["recollectionRouteId"])
      const ended = await refused(await command(fresh.id, "complete", { resolution: "recollected", note: "x", recollectionRouteId: ex.routes.completed.id }), 409)
      assert.equal(ended.detail, `Route ${ex.routes.completed.label} is completed; a re-collection rides on a route that has not ended`)
      const cancelled = await seedRoute(pool, a, fleet, ex, { status: "cancelled" })
      const gone = await refused(await command(fresh.id, "complete", { resolution: "recollected", note: "x", recollectionRouteId: cancelled.id }), 409)
      assert.equal(gone.detail, `Route ${cancelled.label} is cancelled; a re-collection rides on a route that has not ended`)
      assert.deepEqual((await refused(await command(fresh.id, "complete", { resolution: "recollected" }), 400)).errors?.map((error) => error.path), ["note"])
      assert.deepEqual((await refused(await command(fresh.id, "complete", { note: "x" }), 400)).errors?.map((error) => error.path), ["resolution"])
      assert.equal((await read(fresh.id)).status, "open", "no refused body wrote anything")
      assert.equal((await eventsAbout(fresh.id)).length, 1, "and nothing was published")
      const active = await seedRoute(pool, a, fleet, ex, { status: "active", plannedDriverId: fleet.drivers.mads.id, plannedVehicleId: fleet.vehicles.wh24.id })
      assert.equal((await commanded(fresh.id, "complete", { resolution: "recollected", note: "x", recollectionRouteId: active.id })).recollectionRouteId, active.id, "a route running today may still take a re-collection")
      await refused(await command(theirs.id, "complete", bodyFor.complete), 404)
      await refused(await command(harbors.id, "complete", bodyFor.complete, viewer), 404)
      assert.match((await refused(await command(harbors.id, "complete", bodyFor.complete, ungranted), 403)).detail ?? "", /edit on operate\.tickets/)
    })
  })

  describe("POST /tickets/:id/reject and /reopen", () => {
    test("rejects with the reason as the event's body and the closing instant, writes ticket-rejected, and a reopen clears the closing while the history keeps it", async () => {
      const fresh = await opened()
      const gone = await commanded(fresh.id, "reject", { reason: "The address is served by another company" })
      assert.deepEqual([gone.status, gone.resolution, gone.closedAt], ["rejected", null, NOON.toISOString()], "a rejected ticket has a reason and no resolution")
      const outbox = await eventsAbout(fresh.id)
      assert.deepEqual(outbox.map((event) => event.kind), ["ticket-opened", "ticket-rejected"])
      assert.deepEqual(Ticket.parse(outbox[1].payload), gone)
      assert.equal((await refused(await command(fresh.id, "reject", { reason: "Twice" }), 409)).detail, `Ticket ${gone.label} is rejected; reopen it first`)
      assert.deepEqual((await refused(await command(fresh.id, "reject", {}), 400)).errors?.map((error) => error.path), ["reason"])

      const back = await commanded(fresh.id, "reopen", { note: "The customer sent the agreement" })
      assert.deepEqual([back.status, back.resolution, back.recollectionRouteId, back.closedAt], ["open", null, null, null])
      assert.equal((await commanded(fresh.id, "reopen", { note: "Once more" })).updatedAt, back.updatedAt, "reopening an open ticket writes nothing")
      assert.deepEqual((await history(fresh.id)).map((event) => [event.kind, event.status, event.resolution, event.body]), [
        ["created", "open", null, null],
        ["status-changed", "rejected", null, "The address is served by another company"],
        ["status-changed", "open", null, "The customer sent the agreement"],
      ], "the closing stands in the history")
      assert.equal((await eventsAbout(fresh.id)).length, 2, "a reopen is nobody else's news")

      const recollected = await commanded((await opened()).id, "complete", { resolution: "recollected", note: "Done", recollectionRouteId: ex.routes.ready.id })
      const reopened = await commanded(recollected.id, "reopen", { note: "Missed again" })
      assert.deepEqual([reopened.status, reopened.resolution, reopened.recollectionRouteId, reopened.closedAt], ["open", null, null, null], "the three closing columns are cleared")
      assert.deepEqual((await history(recollected.id)).map((event) => [event.status, event.resolution]), [["open", null], ["completed", "recollected"], ["open", null]])
      assert.deepEqual((await refused(await command(recollected.id, "reopen", {}), 400)).errors?.map((error) => error.path), ["note"])
      await refused(await command(theirs.id, "reopen", bodyFor.reopen), 404)
      assert.match((await refused(await command(harbors.id, "reopen", bodyFor.reopen, ungranted), 403)).detail ?? "", /edit on operate\.tickets/)
    })
  })

  describe("GET /tickets/:id/events", () => {
    test("pages the history oldest first, by kind and by visibility, and answers 404 outside the caller's scope", async () => {
      const fresh = await opened()
      await commanded(fresh.id, "start", {})
      const comment = async (values: unknown) => {
        const response = await olivia(`/tickets/${fresh.id}/comments`, { method: "POST", body: values })
        assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
        return TicketEvent.parse(await response.json())
      }
      const internal = await comment({ body: "Called the yard" })
      const theirsToRead = await comment({ body: "We will re-collect on Tuesday", visibility: "customer" })
      const all = await history(fresh.id)
      assert.deepEqual(all.map((event) => event.kind), ["created", "status-changed", "comment", "comment"])
      assert.deepEqual((await history(fresh.id, "?kind=comment")).map((event) => event.id), [internal.id, theirsToRead.id])
      assert.deepEqual((await history(fresh.id, "?visibility=customer")).map((event) => [event.id, event.body]), [[theirsToRead.id, "We will re-collect on Tuesday"]], "the portal's thread leaves every internal row out")
      assert.equal((await history(fresh.id, "?visibility=internal")).length, 3)
      const first = EventPage.parse(await (await olivia(`/tickets/${fresh.id}/events?limit=2`)).json())
      assert.equal(first.items.length, 2)
      assert.ok(first.nextCursor !== null)
      assert.deepEqual((await history(fresh.id, `?limit=2&cursor=${first.nextCursor}`)).map((event) => event.id), [internal.id, theirsToRead.id])
      await refused(await olivia(`/tickets/${theirs.id}/events`), 404)
      await refused(await viewer(`/tickets/${harbors.id}/events`), 404)
      await refused(await lars(`/tickets/${harbors.id}/events`), 404)
      assert.match((await refused(await ungranted(`/tickets/${harbors.id}/events`), 403)).detail ?? "", /view on operate\.tickets/)
    })
  })
})
