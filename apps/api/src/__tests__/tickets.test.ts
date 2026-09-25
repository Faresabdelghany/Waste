import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Page } from "@waste/contracts/pagination"
import { TICKET_OBJECT_KEY_SHAPE } from "@waste/contracts/resolution"
import { PICKUP_WITH_ITS_ROUTE, RECOLLECTION_ROUTE_WITH_RECOLLECTED, Ticket, TicketDetail, TicketEvent } from "@waste/contracts/tickets"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { agreement } from "@waste/db/schema/agreements"
import { customer, property, propertyParty, sharedCollectionPoint } from "@waste/db/schema/customers"
import { outboxEvent } from "@waste/db/schema/execution"
import { alert } from "@waste/db/schema/resolution"
import { withCompany } from "@waste/db/tenant"
import { RECORDED_AFTER_IT_HAPPENED } from "@waste/domain/execution/commands"
import { TICKET_COMMAND_TARGETS, TICKET_COMMANDS, type TicketCommand } from "@waste/domain/resolution/transitions"
import { isClosedTicketStatus, TICKET_STATUSES, type TicketStatus } from "@waste/domain/resolution/vocabulary"
import { and, asc, eq } from "drizzle-orm"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { nextMillisecond } from "./clock"
import { created } from "./created"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { seedExecution, seedRoute, TOWN_HALL, type ExecutionFixtures, type SeededRoute } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, type FleetFixtures } from "./scheme-fixtures"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the proofs the fixtures append and the ticket history this suite writes, which `wms_api` may not delete. */
const owner = ownerUnderTest()
const TicketPage = Page(Ticket)
const EventPage = Page(TicketEvent)

const MODULE = "operate.tickets"

/** The request's clock, pinned: noon on the fixtures' Monday, so a stamp is known. */
const NOON = new Date("2026-10-05T12:00:00Z")

describe("the ticket endpoints", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  /** The company under test. */
  let a: Tenant
  /** The other company: one ticket of its own, to prove it is invisible. */
  let b: Tenant
  let fleet: FleetFixtures
  let ex: ExecutionFixtures
  let app: ReturnType<typeof createApp>
  let olivia: Call
  /** The custom role, granted view, edit and create, with Project Access to Copenhagen Central only. */
  let viewer: Call
  /** The Service Provider Manager, whose charter grants operate.tickets view and create: a role that reaches no project of the company. */
  let lars: Call
  let other: Call
  /** A role with `configure.access` and nothing else: the 403s. */
  let ungranted: Call
  /** A ticket of Harbor Commercial, which the viewer does not work in. */
  let harbors: Ticket
  /** The other company's ticket. */
  let theirs: Ticket
  /** A route of Harbor Commercial, a link a Copenhagen ticket may not name. */
  let harborRoute: SeededRoute
  /** The portal's ground: two customers, two Copenhagen properties, and who is a party to which. */
  let portal: { anna: string; bo: string; annas: string; bos: string }
  /** An agreement and a shared collection point of Copenhagen Central, for the links a body names. */
  let registry: { agreement: string; point: string }

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    fleet = await seedFleet(pool, a, await seedPlanning(pool, a))
    ex = await seedExecution(pool, a, fleet)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: MODULE, actions: ["view", "edit", "create"] }])
    app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOON })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    lars = callingAs(app, keys, a.users.lars, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    ungranted = callingAs(app, keys, b.users.viewer, b.companyId)
    harborRoute = await seedRoute(pool, a, fleet, ex, { project: "harbor", pickups: [{ containerId: ex.containers.harborBin.id, propertyId: ex.properties.harbor.id }] })

    portal = { anna: testId(), bo: testId(), annas: testId(), bos: testId() }
    registry = { agreement: testId(), point: testId() }
    const copenhagen = a.projects.copenhagen.id
    await withCompany(pool.db, a.companyId, async (tx: Tx) => {
      await tx.insert(customer).values([
        { id: portal.anna, companyId: a.companyId, kind: "person", name: "Anna Andersen", status: "active" },
        { id: portal.bo, companyId: a.companyId, kind: "person", name: "Bo Berg", status: "active" },
      ])
      await tx.insert(property).values([
        { id: portal.annas, companyId: a.companyId, projectId: copenhagen, name: "Rosenvej 4", address: "Rosenvej 4, 2100 København Ø", kind: "residential", location: TOWN_HALL, status: "active" },
        { id: portal.bos, companyId: a.companyId, projectId: copenhagen, name: "Lindevej 9", address: "Lindevej 9, 2100 København Ø", kind: "residential", location: TOWN_HALL, status: "active" },
      ])
      // Anna is two things to her address; Bo one thing to his.
      await tx.insert(propertyParty).values([
        { id: testId(), companyId: a.companyId, projectId: copenhagen, propertyId: portal.annas, customerId: portal.anna, role: "tenant" },
        { id: testId(), companyId: a.companyId, projectId: copenhagen, propertyId: portal.annas, customerId: portal.anna, role: "payer" },
        { id: testId(), companyId: a.companyId, projectId: copenhagen, propertyId: portal.bos, customerId: portal.bo, role: "owner" },
      ])
      await tx.insert(agreement).values({ id: registry.agreement, companyId: a.companyId, projectId: copenhagen, number: "AGR-1", customerId: portal.anna, payerCustomerId: portal.anna, status: "active", billingCadence: "monthly", currency: "DKK", validFrom: "2026-01-01" })
      await tx.insert(sharedCollectionPoint).values({
        id: registry.point,
        companyId: a.companyId,
        projectId: copenhagen,
        name: "Rosenvej point",
        kind: "surface",
        address: "Rosenvej 2, 2100 København Ø",
        location: TOWN_HALL,
        operatingModel: "municipal",
        accessMode: "open",
        billingMode: "municipal",
        status: "open",
      })
    })
    harbors = await opened({ projectId: a.projects.harbor.id, subject: "Harbor complaint", links: { routeId: harborRoute.id } })
    theirs = await opened({ projectId: b.projects.copenhagen.id, subject: "Theirs" }, other)
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    if (b) await dropTenant(pool, b.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  /** A create body: Copenhagen Central, a missed collection, the two texts, and whatever the test adds. */
  const body = (values: Record<string, unknown> = {}) => ({
    projectId: a.projects.copenhagen.id,
    subject: "Bin not emptied",
    description: "The bin at Parkvej 18 was not emptied on Monday.",
    kind: "missed-collection",
    ...values,
  })
  const open = (values: Record<string, unknown> = {}, call = olivia) => call("/tickets", { method: "POST", body: body(values) })
  async function opened(values: Record<string, unknown> = {}, call = olivia): Promise<Ticket> {
    return await created(call, "/tickets", await open(values, call), Ticket)
  }
  const read = async (id: string, call = olivia): Promise<TicketDetail> => {
    const response = await call(`/tickets/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return TicketDetail.parse(await response.json())
  }
  const page = async (call: Call, query = "?limit=200") => TicketPage.parse(await (await call(`/tickets${query}`)).json())
  const command = (id: string, action: string, values?: unknown, call = olivia) => call(`/tickets/${id}/${action}`, { method: "POST", body: values })
  const commanded = async (id: string, action: string, values?: unknown, call = olivia): Promise<Ticket> => {
    const response = await command(id, action, values, call)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return Ticket.parse(await response.json())
  }
  const patch = (id: string, values: unknown, call = olivia) => call(`/tickets/${id}`, { method: "PATCH", body: values })
  const patched = async (id: string, values: unknown, call = olivia): Promise<Ticket> => {
    const response = await patch(id, values, call)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return Ticket.parse(await response.json())
  }
  const history = async (id: string, query = "?limit=200", call = olivia): Promise<TicketEvent[]> => {
    const response = await call(`/tickets/${id}/events${query}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return EventPage.parse(await response.json()).items
  }
  /** The outbox rows about one aggregate, oldest first, read as `wms_api` under the fence. */
  const eventsAbout = async (aggregateId: string, companyId = a.companyId) =>
    await withCompany(pool.db, companyId, async (tx: Tx) =>
      tx
        .select({ kind: outboxEvent.kind, aggregateKind: outboxEvent.aggregateKind, projectId: outboxEvent.projectId, occurredAt: outboxEvent.occurredAt, payload: outboxEvent.payload, publishedAt: outboxEvent.publishedAt })
        .from(outboxEvent)
        .where(and(eq(outboxEvent.companyId, companyId), eq(outboxEvent.aggregateId, aggregateId)))
        .orderBy(asc(outboxEvent.id)),
    )
  /** The body each command takes, where the test has nothing to say. */
  const bodyFor: Record<TicketCommand, unknown> = {
    start: {},
    wait: { note: "Waiting for the customer to say when the bin is out" },
    hold: { note: "Waiting on the yard" },
    complete: { resolution: "no-action", note: "Nothing to do" },
    reject: { reason: "Not this company's address" },
    reopen: { note: "The customer called again" },
  }
  /** A fresh ticket moved into the status named through the commands, as the office would. */
  async function inStatus(status: TicketStatus, values: Record<string, unknown> = {}): Promise<Ticket> {
    const fresh = await opened(values)
    switch (status) {
      case "open":
        return fresh
      case "in-progress":
        return await commanded(fresh.id, "start", bodyFor.start)
      case "pending":
        return await commanded(fresh.id, "wait", bodyFor.wait)
      case "on-hold":
        return await commanded(fresh.id, "hold", bodyFor.hold)
      case "completed":
        return await commanded(fresh.id, "complete", bodyFor.complete)
      case "rejected":
        return await commanded(fresh.id, "reject", bodyFor.reject)
    }
  }
  /** An alert of the project, seeded through `tx` the way the alerts API writes it: manual, about the ready route, in the status asked for. */
  async function seedAlert(status: "new" | "acknowledged" | "resolved", projectId = a.projects.copenhagen.id): Promise<string> {
    const id = testId()
    const stamps = status === "new" ? {} : status === "acknowledged" ? { acknowledgedAt: NOON, acknowledgedBy: a.users.olivia.id } : { resolvedAt: NOON, resolvedBy: a.users.olivia.id }
    await withCompany(pool.db, a.companyId, async (tx: Tx) => {
      await tx.insert(alert).values({
        id,
        companyId: a.companyId,
        projectId,
        kind: "route-exception",
        severity: "high",
        source: "manual",
        status,
        title: "Route behind schedule",
        details: "Two hours behind at noon.",
        detectedAt: NOON,
        vehicleId: projectId === a.projects.copenhagen.id ? fleet.vehicles.wh24.id : fleet.vehicles.harborTruck.id,
        raisedBy: a.users.olivia.id,
        ...stamps,
      })
    })
    return id
  }

  describe("GET /tickets", () => {
    test("lists the caller's projects' tickets in id order, filters them, pages them, and shows nothing to a foreman or across companies", async () => {
      const first = await opened({ priority: "high", source: "phone", occurredAt: "2026-10-04T23:30:00Z", assigneeUserAccountId: a.users.olivia.id, links: { routeId: ex.routes.completed.id, pickupId: ex.routes.completed.pickupIds[1], containerId: ex.containers.bin2.id, propertyId: ex.properties.havnegade.id, driverId: fleet.drivers.mads.id } })
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
      const [openedEvent, ...more] = await eventsAbout(second.id)
      assert.equal(more.length, 0)
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
      assert.deepEqual(await errorsOf({}, lars), [{ path: "projectId", message: "Not a project this account works in" }], "the provider's manager may create and works in no project")
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
      assert.equal((await eventsAbout(fresh.id)).length, 1, "an assignment is nobody else's news")
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
      const fresh = await opened({ links: { routeId: ex.routes.completed.id, pickupId: ex.routes.completed.pickupIds[1] } })
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

  describe("POST /tickets/:id/comments", () => {
    const comment = (id: string, values: unknown, call = olivia) => call(`/tickets/${id}/comments`, { method: "POST", body: values })

    test("appends a comment, internal unless said, on an open or a closed ticket, touching the row not at all, and answers 201 without Location", async () => {
      const done = await inStatus("completed")
      await nextMillisecond()
      const response = await comment(done.id, { body: "The customer thanked us" })
      assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
      assert.equal(response.headers.get("location"), null, "a history row has no address of its own")
      const row = TicketEvent.parse(await response.json())
      assert.deepEqual([row.ticketId, row.kind, row.status, row.assigneeUserAccountId, row.body, row.visibility, row.objectKey, row.resolution, row.recordedBy, row.sourceEventId], [done.id, "comment", "completed", null, "The customer thanked us", "internal", null, null, a.users.olivia.id, null], "the snapshot is the closed ticket's")
      const after = await read(done.id)
      assert.equal(after.updatedAt, done.updatedAt, "nothing of the row moves")
      assert.deepEqual([after.status, after.closedAt], ["completed", done.closedAt])
      assert.equal(after.events.at(-1)?.id, row.id)
      const customers = TicketEvent.parse(await (await comment(done.id, { body: "We are sorry", visibility: "customer" })).json())
      assert.equal(customers.visibility, "customer")
      assert.equal((await eventsAbout(done.id)).length, 2, "a comment is nobody else's news")
      const viewers = await comment((await opened()).id, { body: "From Vera" }, viewer)
      assert.equal(viewers.status, 201, "create is the grant, as it is for opening a ticket")
    })

    test("holds the attachment key to its shape and to the row's own company and ticket, stores a matching one, and answers 404 and 403 like every route here", async () => {
      const fresh = await opened()
      const shape = await refused(await comment(fresh.id, { body: "See attached", objectKey: "photos/bin.jpg" }), 400)
      assert.deepEqual(shape.errors, [{ path: "objectKey", message: TICKET_OBJECT_KEY_SHAPE }])
      const anotherTicket = await refused(await comment(fresh.id, { body: "See attached", objectKey: `${a.companyId}/${harbors.id}/${testId()}.pdf` }), 400)
      assert.deepEqual(anotherTicket.errors, [{ path: "objectKey", message: "The attachment key names another company or another ticket" }])
      const anotherCompany = await refused(await comment(fresh.id, { body: "See attached", objectKey: `${testId()}/${fresh.id}/${testId()}.jpg` }), 400)
      assert.deepEqual(anotherCompany.errors, [{ path: "objectKey", message: "The attachment key names another company or another ticket" }])
      assert.deepEqual((await refused(await comment(fresh.id, {}), 400)).errors?.map((error) => error.path), ["body"])
      assert.deepEqual((await refused(await comment(fresh.id, { body: "x", kind: "created" }), 400)).errors?.map((error) => error.path), ["kind"], "the kind is the server's")
      assert.equal((await history(fresh.id)).length, 1, "no refused comment was appended")
      // The object's id is the client's, minted before the upload (#109 §7.23 as corrected at integration): a key under this company and ticket is stored as sent.
      const objectKey = `${a.companyId}/${fresh.id}/${testId()}.pdf`
      const attached = await comment(fresh.id, { body: "See attached", objectKey })
      assert.equal(attached.status, 201, JSON.stringify(await attached.clone().json()))
      assert.equal(TicketEvent.parse(await attached.json()).objectKey, objectKey)
      assert.equal((await history(fresh.id)).at(-1)?.objectKey, objectKey, "the key is what the history reads back")
      await refused(await comment(theirs.id, { body: "Mine" }), 404)
      await refused(await comment(harbors.id, { body: "Mine" }, viewer), 404)
      assert.match((await refused(await comment(harbors.id, { body: "Mine" }, ungranted), 403)).detail ?? "", /create on operate\.tickets/)
    })
  })
})
