import assert from "node:assert/strict"
import { after, before } from "node:test"

import { Page } from "@waste/contracts/pagination"
import { Ticket, TicketDetail, TicketEvent } from "@waste/contracts/tickets"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { agreement } from "@waste/db/schema/agreements"
import { customer, property, propertyParty, sharedCollectionPoint } from "@waste/db/schema/customers"
import { outboxEvent } from "@waste/db/schema/execution"
import { alert } from "@waste/db/schema/resolution"
import { withCompany } from "@waste/db/tenant"
import { type TicketCommand, type TicketStatus } from "@waste/domain/resolution/vocabulary"
import { and, asc, eq } from "drizzle-orm"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { seedExecution, seedRoute, TOWN_HALL, type ExecutionFixtures, type SeededRoute } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, type FleetFixtures } from "./scheme-fixtures"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

// The ticket endpoints' suites share one setup: their tests are three files —
// tickets.test.ts, ticket-commands.test.ts and ticket-evidence.test.ts — since
// node's test timeout bounds a whole file, and one file of them all ran near
// it under CI's parallel load.

export const database = databaseUnderTest()
/** The owner sweeps the proofs the fixtures append and the ticket history these suites write, which `wms_api` may not delete. */
export const owner = ownerUnderTest()
export const TicketPage = Page(Ticket)
export const EventPage = Page(TicketEvent)

export const MODULE = "operate.tickets"

/** The request's clock, pinned: noon on the fixtures' Monday, so a stamp is known. */
export const NOON = new Date("2026-10-05T12:00:00Z")

/** What the suites' calls need: the setup before its two tickets are opened. */
export type TicketBase = {
  pool: Database
  ownerPool: Database
  keys: SigningKeys
  /** The company under test. */
  a: Tenant
  /** The other company: one ticket of its own, to prove it is invisible. */
  b: Tenant
  fleet: FleetFixtures
  ex: ExecutionFixtures
  app: ReturnType<typeof createApp>
  olivia: Call
  /** The custom role, granted view, edit and create, with Project Access to Copenhagen Central only. */
  viewer: Call
  /** The Service Provider Manager, whose charter grants operate.tickets view and create: a role that reaches no project of the company. */
  lars: Call
  other: Call
  /** A role with `configure.access` and nothing else: the 403s. */
  ungranted: Call
  /** A route of Harbor Commercial, a link a Copenhagen ticket may not name. */
  harborRoute: SeededRoute
  /** The portal's ground: two customers, two Copenhagen properties, and who is a party to which. */
  portal: { anna: string; bo: string; annas: string; bos: string }
  /** An agreement and a shared collection point of Copenhagen Central, for the links a body names. */
  registry: { agreement: string; point: string }
}

export type TicketSuite = TicketBase & {
  /** A ticket of Harbor Commercial, which the viewer does not work in. */
  harbors: Ticket
  /** The other company's ticket. */
  theirs: Ticket
}

/** Registers the suite's hooks inside the calling `describe` and answers the suite, filled once its `before` has run. */
export function ticketSuite(): { readonly current: TicketSuite } {
  const held: { base?: TicketBase; current?: TicketSuite } = {}
  const { opened } = ticketCalls(() => {
    assert.ok(held.base, "the ticket suite is set up in its before")
    return held.base
  })

  before(async () => {
    const pool = createDb(database.url, { max: 4 })
    const ownerPool = createDb(owner.url, { max: 1 })
    const keys = await signingKeys()
    const a = await seedTenant(pool)
    const b = await seedTenant(pool)
    const fleet = await seedFleet(pool, a, await seedPlanning(pool, a))
    const ex = await seedExecution(pool, a, fleet)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: MODULE, actions: ["view", "edit", "create"] }])
    const app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOON })
    const olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    const viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    const lars = callingAs(app, keys, a.users.lars, a.companyId)
    const other = callingAs(app, keys, b.users.olivia, b.companyId)
    const ungranted = callingAs(app, keys, b.users.viewer, b.companyId)
    const harborRoute = await seedRoute(pool, a, fleet, ex, { project: "harbor", pickups: [{ containerId: ex.containers.harborBin.id, propertyId: ex.properties.harbor.id }] })

    const portal = { anna: testId(), bo: testId(), annas: testId(), bos: testId() }
    const registry = { agreement: testId(), point: testId() }
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
        { id: testId(), companyId: a.companyId, projectId: copenhagen, propertyId: portal.annas, customerId: portal.anna, role: "tenant", validFrom: "2026-01-01" },
        { id: testId(), companyId: a.companyId, projectId: copenhagen, propertyId: portal.annas, customerId: portal.anna, role: "payer", validFrom: "2026-01-01" },
        { id: testId(), companyId: a.companyId, projectId: copenhagen, propertyId: portal.bos, customerId: portal.bo, role: "owner", validFrom: "2026-01-01" },
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
    held.base = { pool, ownerPool, keys, a, b, fleet, ex, app, olivia, viewer, lars, other, ungranted, harborRoute, portal, registry }
    const harbors = await opened({ projectId: a.projects.harbor.id, subject: "Harbor complaint", links: { routeId: harborRoute.id } })
    const theirs = await opened({ projectId: b.projects.copenhagen.id, subject: "Theirs" }, other)
    held.current = { ...held.base, harbors, theirs }
  })
  after(async () => {
    const base = held.base
    if (!base) return
    await dropTenant(base.pool, base.a.companyId, base.ownerPool)
    await dropTenant(base.pool, base.b.companyId, base.ownerPool)
    await base.pool.close()
    await base.ownerPool.close()
  })
  return {
    get current(): TicketSuite {
      assert.ok(held.current, "the ticket suite is set up in its before")
      return held.current
    },
  }
}

/** The suites' calls and reads, over the setup `of` answers once its `before` has run. */
export function ticketCalls(of: () => TicketBase) {
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  /** A create body: Copenhagen Central, a missed collection, the two texts, and whatever the test adds. */
  const body = (values: Record<string, unknown> = {}) => ({
    projectId: of().a.projects.copenhagen.id,
    subject: "Bin not emptied",
    description: "The bin at Parkvej 18 was not emptied on Monday.",
    kind: "missed-collection",
    ...values,
  })
  const open = (values: Record<string, unknown> = {}, call: Call = of().olivia) => call("/tickets", { method: "POST", body: body(values) })
  async function opened(values: Record<string, unknown> = {}, call: Call = of().olivia): Promise<Ticket> {
    return await created(call, "/tickets", await open(values, call), Ticket)
  }
  const read = async (id: string, call: Call = of().olivia): Promise<TicketDetail> => {
    const response = await call(`/tickets/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return TicketDetail.parse(await response.json())
  }
  const page = async (call: Call, query = "?limit=200") => TicketPage.parse(await (await call(`/tickets${query}`)).json())
  const command = (id: string, action: string, values?: unknown, call: Call = of().olivia) => call(`/tickets/${id}/${action}`, { method: "POST", body: values })
  const commanded = async (id: string, action: string, values?: unknown, call: Call = of().olivia): Promise<Ticket> => {
    const response = await command(id, action, values, call)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return Ticket.parse(await response.json())
  }
  const patch = (id: string, values: unknown, call: Call = of().olivia) => call(`/tickets/${id}`, { method: "PATCH", body: values })
  const patched = async (id: string, values: unknown, call: Call = of().olivia): Promise<Ticket> => {
    const response = await patch(id, values, call)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return Ticket.parse(await response.json())
  }
  const history = async (id: string, query = "?limit=200", call: Call = of().olivia): Promise<TicketEvent[]> => {
    const response = await call(`/tickets/${id}/events${query}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return EventPage.parse(await response.json()).items
  }
  /** The outbox rows about one aggregate, oldest first, read as `wms_api` under the fence. */
  const eventsAbout = async (aggregateId: string, companyId: string = of().a.companyId) =>
    await withCompany(of().pool.db, companyId, async (tx: Tx) =>
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
  async function seedAlert(status: "new" | "acknowledged" | "resolved", projectId: string = of().a.projects.copenhagen.id): Promise<string> {
    const { pool, a, fleet } = of()
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

  return { refused, body, open, opened, read, page, command, commanded, patch, patched, history, eventsAbout, bodyFor, inStatus, seedAlert }
}
