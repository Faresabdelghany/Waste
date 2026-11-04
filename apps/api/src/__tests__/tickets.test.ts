// The ticket endpoints (Issue #109): the list, the create, the read and the
// patch. The commands and the history are ticket-commands.test.ts, the stop's
// evidence and the comments ticket-evidence.test.ts, over the setup
// ticket-suite.ts shares.
import assert from "node:assert/strict"
import { before, describe, test } from "node:test"

import { PICKUP_WITH_ITS_ROUTE, Ticket } from "@waste/contracts/tickets"
import { RECORDED_AFTER_IT_HAPPENED } from "@waste/domain/execution/commands"

import { createApp } from "../app"
import { type Call } from "./calls"
import { nextMillisecond } from "./clock"
import { type ExecutionFixtures, type SeededRoute } from "./execution-fixtures"
import { type FleetFixtures } from "./scheme-fixtures"
import { testId, type Tenant } from "./tenant"
import { database, NOON, owner, ticketCalls, ticketSuite } from "./ticket-suite"

describe("the ticket endpoints", { skip: database.skip || owner.skip }, () => {
  const suite = ticketSuite()
  let a: Tenant
  let b: Tenant
  let fleet: FleetFixtures
  let ex: ExecutionFixtures
  let app: ReturnType<typeof createApp>
  let olivia: Call
  let viewer: Call
  let lars: Call
  let other: Call
  let ungranted: Call
  let harbors: Ticket
  let theirs: Ticket
  let harborRoute: SeededRoute
  let portal: { anna: string; bo: string; annas: string; bos: string }
  let registry: { agreement: string; point: string }

  before(() => {
    ;({ a, b, fleet, ex, app, olivia, viewer, lars, other, ungranted, harbors, theirs, harborRoute, portal, registry } = suite.current)
  })

  const { refused, open, opened, read, page, commanded, patch, patched, history, eventsAbout, inStatus, seedAlert } = ticketCalls(() => suite.current)

  describe("GET /tickets", () => {
    test("lists the caller's projects' tickets in id order, filters them, pages them, and shows nothing to a foreman or across companies", async () => {
      // The stop it names was recorded `not-presented`, which would answer the case as it opens (M6): this test is about the list, so the case stays open.
      const first = await opened({ priority: "high", source: "phone", occurredAt: "2026-10-04T23:30:00Z", assigneeUserAccountId: a.users.olivia.id, answerFromRecord: false, links: { routeId: ex.routes.completed.id, pickupId: ex.routes.completed.pickupIds[1], containerId: ex.containers.bin2.id, propertyId: ex.properties.havnegade.id, driverId: fleet.drivers.mads.id } })
      const second = await opened({ kind: "overflow" })
      const everything = await page(olivia)
      const ids = everything.items.map((row) => row.id)
      assert.ok(ids.indexOf(harbors.id) < ids.indexOf(first.id) && ids.indexOf(first.id) < ids.indexOf(second.id), "the order they were made in")
      assert.ok(!ids.includes(theirs.id), "and no other company's")

      const filtered = async (query: string, call = olivia) => (await page(call, `?limit=200${query}`)).items.map((row) => row.id)
      assert.deepEqual(await filtered(`&projectId=${a.projects.harbor.id}`), [harbors.id])
      assert.ok((await filtered(`&status=open`)).includes(second.id))
      assert.ok((await filtered(`&kind=overflow`)).includes(second.id))
      assert.ok(!(await filtered(`&kind=overflow`)).includes(first.id))
      assert.deepEqual(await filtered(`&priority=high&source=phone`), [first.id])
      assert.ok((await filtered(`&assigneeUserAccountId=${a.users.olivia.id}`)).includes(first.id))
      assert.deepEqual(await filtered(`&routeId=${ex.routes.completed.id}`), [first.id])
      assert.deepEqual(await filtered(`&pickupId=${ex.routes.completed.pickupIds[1]}`), [first.id])
      assert.deepEqual(await filtered(`&containerId=${ex.containers.bin2.id}`), [first.id])
      assert.deepEqual(await filtered(`&propertyId=${ex.properties.havnegade.id}`), [first.id])
      assert.deepEqual(await filtered(`&driverId=${fleet.drivers.mads.id}`), [first.id])
      assert.deepEqual(await filtered(`&from=2026-10-04&to=2026-10-04`), [first.id], "the one that happened the evening before, on the UTC calendar")
      assert.ok(!(await filtered(`&from=2026-10-05&to=2026-10-05`)).includes(first.id))
      assert.ok((await filtered(`&from=2026-10-05&to=2026-10-05`)).includes(second.id), "noon on the 5th is inside the 5th")
      assert.deepEqual(await filtered(`&from=2026-10-06`), [])

      const completed = await inStatus("completed")
      const rejected = await inStatus("rejected")
      const closed = await filtered("&open=false")
      assert.ok(closed.includes(completed.id) && closed.includes(rejected.id) && !closed.includes(second.id))
      const stillOpen = await filtered("&open=true")
      assert.ok(stillOpen.includes(second.id) && !stillOpen.includes(completed.id))
      assert.deepEqual(await filtered(`&open=true&status=completed`), [], "the two combine")

      const one = await page(olivia, "?limit=1")
      assert.equal(one.items.length, 1)
      assert.ok(one.nextCursor !== null)
      const next = await page(olivia, `?limit=1&cursor=${one.nextCursor}`)
      assert.notEqual(next.items[0].id, one.items[0].id)

      const copenhagenOnly = await page(viewer)
      assert.ok(copenhagenOnly.items.some((row) => row.id === second.id))
      assert.ok(!copenhagenOnly.items.some((row) => row.id === harbors.id), "the viewer works in Copenhagen only")
      assert.deepEqual(await page(lars), { items: [], nextCursor: null }, "a provider's manager works in no project and lists nothing")
    })

    test("is the portal's read with customerId: the tickets naming the customer or a property they are a party to, one row each, and nothing of another customer's", async () => {
      const named = await opened({ links: { customerId: portal.anna } })
      const atAnnas = await opened({ links: { propertyId: portal.annas } })
      const atBos = await opened({ links: { propertyId: portal.bos } })
      await opened({ subject: "About nothing" })
      const visible = async (customerId: string) => (await page(olivia, `?limit=200&customerId=${customerId}`)).items.map((row) => row.id)
      assert.deepEqual(await visible(portal.anna), [named.id, atAnnas.id], "Anna holds two roles at Rosenvej 4 and sees its ticket once")
      assert.deepEqual(await visible(portal.bo), [atBos.id])
      assert.deepEqual((await page(olivia, `?limit=200&customerId=${portal.anna}&projectId=${a.projects.harbor.id}`)).items, [], "the two filters combine")
      const stranger = await refused(await olivia(`/tickets?customerId=${testId()}`), 400)
      assert.deepEqual(stranger.errors, [{ path: "customerId", message: "Not a customer of this company" }])
      const readable = await history(atAnnas.id, "?visibility=customer")
      assert.deepEqual(readable, [], "the created row is the office's")
    })

    test("refuses a project out of reach, a backwards window, a bad cursor, and a role without view", async () => {
      const project = await refused(await viewer(`/tickets?projectId=${a.projects.harbor.id}`), 400)
      assert.deepEqual(project.errors, [{ path: "projectId", message: "Not a project this account works in" }])
      assert.deepEqual((await refused(await olivia("/tickets?from=2026-10-06&to=2026-10-05"), 400)).errors?.map((error) => error.path), ["to"])
      assert.deepEqual((await refused(await olivia("/tickets?cursor=nope"), 400)).errors?.map((error) => error.path), ["cursor"])
      assert.deepEqual((await refused(await olivia("/tickets?open=yes"), 400)).errors?.map((error) => error.path), ["open"])
      assert.match((await refused(await ungranted("/tickets"), 403)).detail ?? "", /view on operate\.tickets/)
      assert.equal((await app.request("/tickets")).status, 401)
    })
  })

  describe("POST /tickets", () => {
    test("opens the ticket with the next number, the defaults and the request's clock, appends the created row, writes ticket-opened, and answers 201 with Location", async () => {
      const first = await opened()
      const second = await opened({ priority: "critical", source: "email", occurredAt: "2026-10-01T08:00:00Z", dueAt: "2026-10-08T12:00:00Z", assigneeUserAccountId: a.users.viewer.id })
      assert.equal(second.number, first.number + 1, "the counter steps by one per ticket")
      assert.deepEqual([first.label, second.label], [`T-${first.number}`, `T-${second.number}`])
      assert.deepEqual(
        [first.status, first.kind, first.priority, first.source, first.occurredAt, first.dueAt, first.assigneeUserAccountId, first.createdBy, first.sourceEventId, first.resolution, first.recollectionRouteId, first.closedAt],
        ["open", "missed-collection", "none", "office", NOON.toISOString(), null, null, a.users.olivia.id, null, null, null, null],
        "open, the defaults, the request's clock, the caller as its opener",
      )
      assert.deepEqual(first.links, { routeId: null, pickupId: null, containerId: null, propertyId: null, sharedCollectionPointId: null, customerId: null, agreementId: null, driverId: null, parentTicketId: null }, "an internal task is about nothing but itself")
      assert.deepEqual([second.priority, second.source, second.occurredAt, second.dueAt, second.assigneeUserAccountId], ["critical", "email", "2026-10-01T08:00:00.000Z", "2026-10-08T12:00:00.000Z", a.users.viewer.id], "yesterday's complaint is recorded as it happened: no lower bound")

      const detail = await read(second.id)
      assert.deepEqual(detail.events.map((event) => [event.kind, event.status, event.assigneeUserAccountId, event.body, event.visibility, event.resolution, event.objectKey, event.recordedBy, event.sourceEventId]), [["created", "open", a.users.viewer.id, null, "internal", null, null, a.users.olivia.id, null]])
      assert.deepEqual(detail.alerts, [])
      const [openedEvent, assignedEvent, ...more] = await eventsAbout(second.id)
      assert.equal(more.length, 0)
      assert.deepEqual([assignedEvent.kind, assignedEvent.aggregateKind, assignedEvent.occurredAt.toISOString()], ["ticket-assigned", "ticket", NOON.toISOString()], "opened with an assignee, the assignment follows for the staff notices (O16 of #290)")
      assert.deepEqual(Ticket.parse(assignedEvent.payload), second)
      assert.deepEqual([openedEvent.kind, openedEvent.aggregateKind, openedEvent.projectId, openedEvent.occurredAt.toISOString(), openedEvent.publishedAt], ["ticket-opened", "ticket", second.projectId, NOON.toISOString(), null])
      assert.deepEqual(Ticket.parse(openedEvent.payload), second, "the payload is the ticket as answered")

      const viewers = await opened({}, viewer)
      assert.equal(viewers.createdBy, a.users.viewer.id, "the viewer has create and works in Copenhagen")
    })

    test("stores every link it is given, held to the ticket's project", async () => {
      const parent = await opened()
      const linked = await opened({
        links: {
          routeId: ex.routes.completed.id,
          pickupId: ex.routes.completed.pickupIds[0],
          containerId: ex.containers.bin1.id,
          propertyId: ex.properties.parkvej.id,
          sharedCollectionPointId: registry.point,
          customerId: portal.anna,
          agreementId: registry.agreement,
          driverId: fleet.drivers.mads.id,
          parentTicketId: parent.id,
        },
      })
      assert.deepEqual(linked.links, {
        routeId: ex.routes.completed.id,
        pickupId: ex.routes.completed.pickupIds[0],
        containerId: ex.containers.bin1.id,
        propertyId: ex.properties.parkvej.id,
        sharedCollectionPointId: registry.point,
        customerId: portal.anna,
        agreementId: registry.agreement,
        driverId: fleet.drivers.mads.id,
        parentTicketId: parent.id,
      })
      const retired = await opened({ links: { containerId: ex.containers.bin1.id, driverId: fleet.drivers.karen.id, customerId: portal.anna } })
      assert.equal(retired.links.driverId, fleet.drivers.karen.id, "no status gates a link: a ticket about an inactive driver's collection is exactly what tickets are for")
    })

    test("holds the project, the clock, the assignee, every link and the alert, each a 400 at its field", async () => {
      const errorsOf = async (values: Record<string, unknown>, call = olivia) => (await refused(await open(values, call), 400)).errors
      assert.deepEqual(await errorsOf({ projectId: a.projects.harbor.id }, viewer), [{ path: "projectId", message: "Not a project this account works in" }])
      assert.deepEqual(await errorsOf({}, lars), [{ path: "links.routeId", message: "A ticket NordRen ApS raises names a route NordRen ApS runs" }], "the provider's manager raises a ticket about a route it runs alone (#291 slice 23b), and this suite awards it none")
      assert.deepEqual(await errorsOf({ occurredAt: new Date(NOON.getTime() + 6 * 60_000).toISOString() }), [{ path: "occurredAt", message: RECORDED_AFTER_IT_HAPPENED }])
      assert.equal((await opened({ occurredAt: new Date(NOON.getTime() + 4 * 60_000).toISOString() })).occurredAt, new Date(NOON.getTime() + 4 * 60_000).toISOString(), "four minutes ahead is a clock's skew")
      assert.deepEqual(await errorsOf({ source: "driver-app" }).then((errors) => errors?.map((error) => error.path)), ["source"], "the consumer's source is not the office's")
      assert.ok((await errorsOf({ status: "in-progress" }))?.some((error) => /status/.test(error.message)), "the status is the server's")

      assert.deepEqual(await errorsOf({ assigneeUserAccountId: testId() }), [{ path: "assigneeUserAccountId", message: "Not a user account of this company" }])
      assert.deepEqual(await errorsOf({ assigneeUserAccountId: a.users.deactivated.id }), [{ path: "assigneeUserAccountId", message: "Not a user account of this company" }])
      assert.deepEqual(await errorsOf({ assigneeUserAccountId: b.users.olivia.id }), [{ path: "assigneeUserAccountId", message: "Not a user account of this company" }])
      assert.deepEqual(await errorsOf({ projectId: a.projects.harbor.id, assigneeUserAccountId: a.users.viewer.id }), [{ path: "assigneeUserAccountId", message: "Not a user account working in this project" }], "the viewer works in Copenhagen")
      assert.deepEqual(await errorsOf({ assigneeUserAccountId: a.users.lars.id }), [{ path: "assigneeUserAccountId", message: "Not a user account working in this project" }], "the provider's manager works in no project")

      const link = (links: Record<string, unknown>) => errorsOf({ links })
      assert.deepEqual(await link({ routeId: harborRoute.id }), [{ path: "links.routeId", message: "Not a route of this project" }])
      assert.deepEqual(await link({ routeId: testId() }), [{ path: "links.routeId", message: "Not a route of this project" }])
      assert.deepEqual(await link({ pickupId: ex.routes.completed.pickupIds[0] }), [{ path: "links.pickupId", message: PICKUP_WITH_ITS_ROUTE }], "a pickup is named with its route")
      assert.deepEqual(await link({ routeId: ex.routes.planned.id, pickupId: ex.routes.completed.pickupIds[0] }), [{ path: "links.pickupId", message: "Not a pickup of this route" }])
      assert.deepEqual(await link({ containerId: ex.containers.harborBin.id }), [{ path: "links.containerId", message: "Not a container of this project" }])
      assert.deepEqual(await link({ propertyId: ex.properties.harbor.id }), [{ path: "links.propertyId", message: "Not a property of this project" }])
      assert.deepEqual(await link({ sharedCollectionPointId: testId() }), [{ path: "links.sharedCollectionPointId", message: "Not a shared collection point of this project" }])
      assert.deepEqual(await link({ customerId: testId() }), [{ path: "links.customerId", message: "Not a customer of this company" }])
      assert.deepEqual(await link({ agreementId: testId() }), [{ path: "links.agreementId", message: "Not an agreement of this project" }])
      assert.deepEqual(await link({ driverId: fleet.drivers.henrik.id }), [{ path: "links.driverId", message: "Not a driver of this project" }])
      assert.deepEqual(await link({ parentTicketId: harbors.id }), [{ path: "links.parentTicketId", message: "Not a ticket of this project" }])
      assert.deepEqual(await link({ parentTicketId: theirs.id }), [{ path: "links.parentTicketId", message: "Not a ticket of this project" }])

      assert.deepEqual(await errorsOf({ alertId: testId() }), [{ path: "alertId", message: "Not an alert of this project" }])
      assert.deepEqual(await errorsOf({ alertId: await seedAlert("new", a.projects.harbor.id) }), [{ path: "alertId", message: "Not an alert of this project" }])
      assert.match((await refused(await open({}, ungranted), 403)).detail ?? "", /create on operate\.tickets/)
    })

    test("links the alert it is opened from in the same transaction, once: a resolved alert and one already another ticket's are refused (409)", async () => {
      const alertId = await seedAlert("acknowledged")
      const answering = await opened({ kind: "reported-problem", alertId })
      const detail = await read(answering.id)
      assert.deepEqual(detail.alerts.map((row) => [row.id, row.ticketId, row.status]), [[alertId, answering.id, "acknowledged"]], "the alert now names the ticket, and the ticket lists it")
      const twice = await refused(await open({ alertId }), 409)
      assert.equal(twice.detail, `This alert is linked to ticket ${answering.label}; an alert links to one ticket`)
      const resolved = await refused(await open({ alertId: await seedAlert("resolved") }), 409)
      assert.equal(resolved.detail, "This alert is resolved and does not change")
      const numberBefore = (await opened()).number
      const refusedThenOpened = await opened()
      assert.equal(refusedThenOpened.number, numberBefore + 1, "a refused create leaves nothing behind, the counter's step included")
    })
  })

  describe("GET /tickets/:id", () => {
    test("answers the ticket with its history in recording order and the alerts naming it, and 404 outside the caller's scope", async () => {
      const fresh = await opened()
      await commanded(fresh.id, "assign", { assigneeUserAccountId: a.users.olivia.id, note: "Taking it" })
      await commanded(fresh.id, "start", {})
      const detail = await read(fresh.id)
      assert.deepEqual(detail.events.map((event) => [event.kind, event.status, event.assigneeUserAccountId, event.body]), [
        ["created", "open", null, null],
        ["assigned", "open", a.users.olivia.id, "Taking it"],
        ["status-changed", "in-progress", a.users.olivia.id, null],
      ])
      assert.ok(detail.events.every((event) => event.ticketId === fresh.id && event.projectId === fresh.projectId && event.recordedBy === a.users.olivia.id))
      assert.equal(detail.status, "in-progress")
      await refused(await olivia(`/tickets/${theirs.id}`), 404)
      assert.equal((await read(theirs.id, other)).id, theirs.id, "still there for its own company")
      await refused(await viewer(`/tickets/${harbors.id}`), 404)
      await refused(await lars(`/tickets/${harbors.id}`), 404)
      await refused(await olivia(`/tickets/${testId()}`), 404)
      assert.deepEqual((await refused(await olivia("/tickets/not-a-uuid"), 400)).errors?.map((error) => error.path), ["id"])
      assert.match((await refused(await ungranted(`/tickets/${harbors.id}`), 403)).detail ?? "", /view on operate\.tickets/)
    })
  })

  describe("PATCH /tickets/:id", () => {
    test("moves the case's own fields and the links, moves the stamp, appends nothing, and holds the pickup rule against the row it leaves behind", async () => {
      const fresh = await opened({ links: { routeId: ex.routes.completed.id, pickupId: ex.routes.completed.pickupIds[0] } })
      await nextMillisecond()
      const moved = await patched(fresh.id, { subject: "Bin still not emptied", description: "Second week running.", kind: "complaint", priority: "high", dueAt: "2026-10-07T12:00:00Z", links: { containerId: ex.containers.bin1.id } })
      assert.deepEqual([moved.subject, moved.description, moved.kind, moved.priority, moved.dueAt], ["Bin still not emptied", "Second week running.", "complaint", "high", "2026-10-07T12:00:00.000Z"])
      assert.deepEqual([moved.links.routeId, moved.links.pickupId, moved.links.containerId], [ex.routes.completed.id, ex.routes.completed.pickupIds[0], ex.containers.bin1.id], "a link the body did not name stands")
      assert.ok(moved.updatedAt > fresh.updatedAt, "the stamp moves")
      assert.deepEqual([moved.status, moved.source, moved.assigneeUserAccountId, moved.number], [fresh.status, fresh.source, fresh.assigneeUserAccountId, fresh.number], "nothing the machine or the assignment owns")
      assert.equal((await history(fresh.id)).length, 1, "a field edit appends nothing: the audit log's, not the history's")
      assert.equal((await eventsAbout(fresh.id)).length, 1, "and is nobody else's news")

      const otherStop = await patched(fresh.id, { links: { pickupId: ex.routes.completed.pickupIds[1] } })
      assert.equal(otherStop.links.pickupId, ex.routes.completed.pickupIds[1], "a pickup moved alone names the stored route")
      const cleared = await patched(fresh.id, { dueAt: null, links: { routeId: null, pickupId: null } })
      assert.deepEqual([cleared.dueAt, cleared.links.routeId, cleared.links.pickupId], [null, null, null], "null clears")
    })

    test("refuses a link out of reach, a route moved under a pickup, a route cleared under one, its own parent, a closed ticket, and a body that changes nothing", async () => {
      const fresh = await opened({ links: { routeId: ex.routes.completed.id, pickupId: ex.routes.completed.pickupIds[0] } })
      const movedRoute = await refused(await patch(fresh.id, { links: { routeId: ex.routes.planned.id } }), 400)
      assert.deepEqual(movedRoute.errors, [{ path: "links.pickupId", message: "Not a pickup of this route" }], "the stored pickup is not the new route's")
      const clearedRoute = await refused(await patch(fresh.id, { links: { routeId: null } }), 400)
      assert.deepEqual(clearedRoute.errors, [{ path: "links.pickupId", message: PICKUP_WITH_ITS_ROUTE }])
      const self = await refused(await patch(fresh.id, { links: { parentTicketId: fresh.id } }), 400)
      assert.deepEqual(self.errors, [{ path: "links.parentTicketId", message: "A ticket is not its own parent" }])
      const elsewhere = await refused(await patch(fresh.id, { links: { propertyId: ex.properties.harbor.id } }), 400)
      assert.deepEqual(elsewhere.errors, [{ path: "links.propertyId", message: "Not a property of this project" }])
      assert.deepEqual((await refused(await patch(fresh.id, {}), 400)).errors?.map((error) => error.path), [""])
      assert.ok((await refused(await patch(fresh.id, { status: "completed" }), 400)).errors?.some((error) => /status/.test(error.message)), "the status moves through the commands")
      assert.ok((await refused(await patch(fresh.id, { assigneeUserAccountId: a.users.olivia.id }), 400)).errors?.some((error) => /assigneeUserAccountId/.test(error.message)), "the assignee through assign")

      const done = await inStatus("completed")
      assert.equal((await refused(await patch(done.id, { subject: "Too late" }), 409)).detail, `Ticket ${done.label} is completed; reopen it first`)
      const gone = await inStatus("rejected")
      assert.equal((await refused(await patch(gone.id, { subject: "Too late" }), 409)).detail, `Ticket ${gone.label} is rejected; reopen it first`)
      await refused(await patch(theirs.id, { subject: "Mine" }), 404)
      await refused(await patch(harbors.id, { subject: "Mine" }, viewer), 404)
      assert.match((await refused(await patch(harbors.id, { subject: "Mine" }, lars), 403)).detail ?? "", /edit on operate\.tickets/, "the provider manager's charter grants view and create, not edit")
      assert.match((await refused(await patch(harbors.id, { subject: "Mine" }, ungranted), 403)).detail ?? "", /edit on operate\.tickets/)
      assert.deepEqual((await read(fresh.id)).links.routeId, ex.routes.completed.id, "no refused body wrote anything")
    })
  })
})
