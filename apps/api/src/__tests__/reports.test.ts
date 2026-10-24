// The reports (#292, C26 and O12) over one seeded week, the fixtures' Monday
// 2026-10-05 to Sunday 2026-10-11, with numbers a reader can count by hand.
//
// The routes: the execution fixtures' three on the Monday — ready for Mads
// at 06:00 (three planned pickups), planned and unassigned (three), and
// completed, started at 06:00 against a 06:00 start (one collected, one
// failed for want of a bin, one closed by the end of the day) — and, laid
// here, a route completed on Tuesday that started 30 minutes after its 05:30
// start (two collected, one of them glass, one removed by the dispatcher), a
// route running on Tuesday that started ten minutes before its 06:10 start
// (one collected, two planned), a route the dispatcher cancelled on
// Wednesday (three pickups closed with it), a route a regeneration cancelled
// on Thursday (three pickups withdrawn with it, the route counted in nothing),
// Harbor's route completed on the Monday with no start time to judge (one
// collected), and a completed route a week later, outside the window.
//
// The tickets, the documents and the unloads are laid in their own suites
// below, each over the same tenant; the request's clock is pinned to
// 2026-10-24 08:00Z, which is what "open now" and "overdue" are read at and
// the day a billing run issues on.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { BillableEvent } from "@waste/contracts/billable-events"
import { BillingRunDetail } from "@waste/contracts/billing"
import { InvoiceDetail } from "@waste/contracts/invoices"
import {
  REPORT_WINDOW_TOO_LONG,
  RevenueReport,
  ServiceReport,
  TicketReport,
  TonnageReport,
  WasteDataReport,
  type PickupStandings,
  type RouteCounts,
  type WasteDataRow,
  type WasteDataWarning,
} from "@waste/contracts/reports"
import { Unload } from "@waste/contracts/unloads"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { route } from "@waste/db/schema/execution"
import { unloadingStation } from "@waste/db/schema/places"
import { ticket } from "@waste/db/schema/resolution"
import { withCompany } from "@waste/db/tenant"
import { WASTE_DATA_COLUMNS, wasteDataWarningSentence, type WasteDataRow as DomainRow, type WasteDataWarning as DomainWarning } from "@waste/domain/insight/waste-data"
import { csvRecords } from "@waste/domain/imports/csv"
import type { TicketKind, TicketResolution, TicketStatus } from "@waste/domain/resolution/vocabulary"
import { and, eq } from "drizzle-orm"

import { createApp } from "../app"
import { nextNumber } from "../routes/shared"
import { seedBilling, type BillingFixtures } from "./billing-fixtures"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { at, seedExecution, seedRoute, type ExecutionFixtures, type RouteSeed, type SeededRoute } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, type FleetFixtures } from "./scheme-fixtures"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the proofs, the unloads, the reviews and the documents this suite appends, which `wms_api` may not delete. */
const owner = ownerUnderTest()

/** The request's clock: a Saturday morning, after everything the week did. */
const NOW = new Date("2026-10-24T08:00:00Z")

/** The week the reports are read over. */
const WEEK = "from=2026-10-05&to=2026-10-11"

const routeCounts = (counts: Partial<RouteCounts> = {}): RouteCounts => ({ total: 0, planned: 0, ready: 0, active: 0, completed: 0, cancelled: 0, started: 0, onTime: 0, late: 0, unjudged: 0, ...counts })
const pickupStandings = (counts: Partial<PickupStandings> = {}): PickupStandings => ({ due: 0, completed: 0, missed: 0, skipped: 0, failed: 0, open: 0, withdrawn: 0, ...counts })

/** True when two types are each other's: a field one of them gains alone makes it false. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

test("the waste-data report's wire rows and warnings are the domain's, each warning with its sentence (#291 slice 29)", () => {
  // A compile-time check: the typecheck refuses this line when the two drift.
  const agree: [Same<WasteDataRow, DomainRow>, Same<WasteDataWarning, DomainWarning & { sentence: string }>] = [true, true]
  assert.deepEqual(agree, [true, true])
})

describe("the report endpoints", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let fleet: FleetFixtures
  let ex: ExecutionFixtures
  let fx: BillingFixtures
  let app: ReturnType<typeof createApp>
  let olivia: Call
  /** The custom role, granted the three report modules, with Project Access to Copenhagen Central only. */
  let viewer: Call
  /** The Service Provider Manager, granted Improve's two modules: an account that works in no project. */
  let lars: Call
  /** Another company's administrator: sees none of this company's rows. */
  let other: Call
  /** Another company's viewer: Improve's Performance and none of the rows a report counts. */
  let ungranted: Call
  let copenhagen: string
  let harbor: string

  let lateStart: SeededRoute
  let running: SeededRoute
  let harborRoute: SeededRoute

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    copenhagen = a.projects.copenhagen.id
    harbor = a.projects.harbor.id
    fleet = await seedFleet(pool, a, await seedPlanning(pool, a))
    ex = await seedExecution(pool, a, fleet)
    fx = await seedBilling(pool, a, ex)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [
      { moduleKey: "improve.performance", actions: ["view"] },
      { moduleKey: "improve.analytics", actions: ["view"] },
      { moduleKey: "route-studio.routes", actions: ["view"] },
      { moduleKey: "operate.tickets", actions: ["view"] },
      { moduleKey: "route-studio.weights", actions: ["view"] },
      { moduleKey: "commercial.invoices", actions: ["view"] },
    ])
    // The provider's charter reads the routes, the tickets and the weights already; Improve's two modules are added, the invoices are not.
    await grantRole(pool, a.companyId, a.roles.providerManager.id, [
      { moduleKey: "improve.performance", actions: ["view"] },
      { moduleKey: "improve.analytics", actions: ["view"] },
    ])
    // Another company's viewer holds Performance and nothing it counts, and not Analytics.
    await grantRole(pool, b.companyId, b.roles.viewer.id, [{ moduleKey: "improve.performance", actions: ["view"] }])
    app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOW })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    lars = callingAs(app, keys, a.users.lars, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    ungranted = callingAs(app, keys, b.users.viewer, b.companyId)

    const { bin1, bin2, bin3, harborBin } = ex.containers
    const { parkvej, havnegade, norrebrogade } = ex.properties
    const fresh = (seed: RouteSeed) => seedRoute(pool, a, fleet, ex, seed)
    const threePickups = (day: string, outcome: { status: "skipped" | "completed"; reason?: "route-cancelled" | "regeneration" | null }) =>
      [
        { containerId: bin1.id, propertyId: parkvej.id },
        { containerId: bin2.id, propertyId: havnegade.id },
        { containerId: bin3.id, propertyId: norrebrogade.id },
      ].map((place) => ({ ...place, status: outcome.status, reason: outcome.reason ?? null, outcomeAt: at(day, "05:00") }))

    lateStart = await fresh({
      status: "completed",
      operatingDate: "2026-10-06",
      plannedStartTime: "05:30",
      pickups: [
        { containerId: bin1.id, propertyId: parkvej.id, wasteFractionId: ex.fractions.glass.id, status: "completed", outcomeAt: at("2026-10-06", "07:10") },
        { containerId: bin2.id, propertyId: havnegade.id, status: "completed", outcomeAt: at("2026-10-06", "07:20") },
        { containerId: bin3.id, propertyId: norrebrogade.id, status: "skipped", reason: "removed-by-dispatcher", outcomeAt: at("2026-10-06", "05:00") },
        // A wash the office booked beside bin1's collection, and not done: no collection of anything, so the service report counts nothing of it (O3 of #290).
        { containerId: bin1.id, propertyId: parkvej.id, origin: "office", service: "wash", status: "failed", reason: "inaccessible", outcomeAt: at("2026-10-06", "07:12") },
      ],
      // The glass pickup weighed twice, the second reading the word; the residual pickup once.
      proofs: [
        { kind: "weight", pickupIndex: 0, occurredAt: at("2026-10-06", "07:05"), weightKg: 40 },
        { kind: "weight", pickupIndex: 0, occurredAt: at("2026-10-06", "07:06"), weightKg: 42 },
        { kind: "weight", pickupIndex: 1, occurredAt: at("2026-10-06", "07:15"), weightKg: 55 },
        // Weighed, then removed by the dispatcher: withdrawn, and its weight with it.
        { kind: "weight", pickupIndex: 2, occurredAt: at("2026-10-06", "04:55"), weightKg: 99 },
      ],
    })
    running = await fresh({
      status: "active",
      operatingDate: "2026-10-06",
      plannedStartTime: "06:10",
      pickups: [
        { containerId: bin1.id, propertyId: parkvej.id, status: "completed", outcomeAt: at("2026-10-06", "06:30") },
        { containerId: bin2.id, propertyId: havnegade.id },
        { containerId: bin3.id, propertyId: norrebrogade.id },
      ],
      proofs: [{ kind: "weight", pickupIndex: 0, occurredAt: at("2026-10-06", "06:30"), weightKg: 30 }],
    })
    await fresh({ status: "cancelled", operatingDate: "2026-10-07", pickups: threePickups("2026-10-07", { status: "skipped", reason: "route-cancelled" }) })
    const regenerated = await fresh({
      status: "cancelled",
      operatingDate: "2026-10-08",
      pickups: threePickups("2026-10-08", { status: "skipped", reason: "regeneration" }),
      proofs: [{ kind: "weight", pickupIndex: 0, source: "dispatch", occurredAt: at("2026-10-08", "04:00"), weightKg: 77 }],
    })
    await withCompany(pool.db, a.companyId, async (tx: Tx) => {
      await tx.update(route).set({ cancelledByGeneration: true }).where(and(eq(route.companyId, a.companyId), eq(route.id, regenerated.id)))
    })
    harborRoute = await fresh({
      project: "harbor",
      status: "completed",
      operatingDate: "2026-10-05",
      plannedDriverId: fleet.drivers.henrik.id,
      plannedVehicleId: fleet.vehicles.harborTruck.id,
      pickups: [{ containerId: harborBin.id, propertyId: ex.properties.harbor.id, status: "completed", outcomeAt: at("2026-10-05", "08:00") }],
    })
    await fresh({ status: "completed", operatingDate: "2026-10-12", plannedStartTime: "06:00", pickups: threePickups("2026-10-12", { status: "completed" }) })
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
  const read = async <T>(call: Call, path: string, schema: { parse: (value: unknown) => T }): Promise<T> => {
    const response = await call(path)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return schema.parse(await response.json())
  }
  const service = (call: Call, query = WEEK) => read(call, `/reports/service?${query}`, ServiceReport)
  const tickets = (call: Call, query = WEEK) => read(call, `/reports/tickets?${query}`, TicketReport)
  const revenue = (call: Call, query: string) => read(call, `/reports/revenue?${query}`, RevenueReport)
  const tonnage = (call: Call, query = WEEK) => read(call, `/reports/tonnage?${query}`, TonnageReport)

  describe("GET /reports/service", () => {
    test("counts the window's routes by status, whether they went out and whether on time, and their pickups by standing, with the rates", async () => {
      const report = await service(olivia)
      assert.deepEqual(report.window, { projectId: null, from: "2026-10-05", to: "2026-10-11", interval: "day" })
      assert.deepEqual(
        report.routes,
        routeCounts({ total: 7, planned: 1, ready: 1, active: 1, completed: 3, cancelled: 1, started: 4, onTime: 2, late: 1, unjudged: 1 }),
        "the regeneration's cancellation and the route of the 12th are not counted; Harbor's route had no start time to judge",
      )
      assert.deepEqual(report.pickups, pickupStandings({ due: 18, completed: 5, missed: 5, skipped: 4, failed: 1, open: 8, withdrawn: 1 }))
      assert.deepEqual(report.rates, { collection: 0.5, missed: 0.5, onTime: 2 / 3 }, "five collected of ten with an outcome; two on time of three judged")
      assert.deepEqual(report.missedByReason, [
        { reason: "not-presented", skipped: 0, failed: 1 },
        { reason: "route-ended", skipped: 1, failed: 0 },
        { reason: "route-cancelled", skipped: 3, failed: 0 },
      ])
    })

    test("answers every day of the window, a quiet one at zero, and the counts of each add up to the window's", async () => {
      const { intervals, routes, pickups } = await service(olivia)
      assert.deepEqual(
        intervals.map((span) => span.from),
        ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"],
      )
      assert.deepEqual(intervals[0], {
        from: "2026-10-05",
        to: "2026-10-05",
        routes: routeCounts({ total: 4, planned: 1, ready: 1, completed: 2, started: 2, onTime: 1, unjudged: 1 }),
        pickups: pickupStandings({ due: 10, completed: 2, missed: 2, skipped: 1, failed: 1, open: 6 }),
      })
      assert.deepEqual(intervals[1].routes, routeCounts({ total: 2, active: 1, completed: 1, started: 2, onTime: 1, late: 1 }))
      assert.deepEqual(intervals[1].pickups, pickupStandings({ due: 5, completed: 3, open: 2, withdrawn: 1 }))
      assert.deepEqual([intervals[2].routes.cancelled, intervals[2].pickups], [1, pickupStandings({ due: 3, missed: 3, skipped: 3 })])
      assert.deepEqual(intervals[3], { from: "2026-10-08", to: "2026-10-08", routes: routeCounts(), pickups: pickupStandings() }, "the regeneration's cancelled route is no route at all")
      assert.equal(
        intervals.reduce((sum, span) => sum + span.routes.total, 0),
        routes.total,
      )
      assert.equal(
        intervals.reduce((sum, span) => sum + span.pickups.due, 0),
        pickups.due,
      )
    })

    test("cuts by the ISO week, the first clipped to a window that starts on a Thursday", async () => {
      const { window, intervals } = await service(olivia, "from=2026-10-01&to=2026-10-11&interval=week")
      assert.equal(window.interval, "week")
      assert.deepEqual(
        intervals.map((span) => [span.from, span.to, span.routes.total, span.pickups.due]),
        [
          ["2026-10-01", "2026-10-04", 0, 0],
          ["2026-10-05", "2026-10-11", 7, 18],
        ],
      )
    })

    test("answers each Route Scheme with a route in the window, by name, with its own rates", async () => {
      const { schemes } = await service(olivia)
      assert.deepEqual(
        schemes.map((scheme) => [scheme.name, scheme.projectId, scheme.routes.total, scheme.pickups.due]),
        [
          ["Centrum Mondays", copenhagen, 6, 17],
          ["Havnen Mondays", harbor, 1, 1],
        ],
      )
      assert.equal(schemes[0].routeSchemeId, ex.schemes.copenhagen.id)
      assert.deepEqual(schemes[1].rates, { collection: 1, missed: 0, onTime: null }, "Harbor's one route had no start to judge: its on-time rate is nothing, not zero")
    })

    test("narrows to a fraction's pickups and the routes that hold one, to one scheme, and to one project", async () => {
      const glass = await service(olivia, `${WEEK}&wasteFractionId=${ex.fractions.glass.id}`)
      assert.deepEqual(glass.routes, routeCounts({ total: 1, completed: 1, started: 1, late: 1 }), "the late route holds the one glass pickup")
      assert.deepEqual(glass.pickups, pickupStandings({ due: 1, completed: 1 }))
      const harborScheme = await service(olivia, `${WEEK}&routeSchemeId=${ex.schemes.harbor.id}`)
      assert.deepEqual([harborScheme.routes.total, harborScheme.pickups.completed], [1, 1])
      const harborOnly = await service(olivia, `${WEEK}&projectId=${harbor}`)
      assert.deepEqual([harborOnly.window.projectId, harborOnly.routes.total, harborOnly.schemes.map((scheme) => scheme.name)], [harbor, 1, ["Havnen Mondays"]])
      assert.equal(harborRoute.projectId, harbor)
    })

    test("counts only the caller's projects: the viewer works in Copenhagen, a provider's account in none, another company sees nothing of this one", async () => {
      const mine = await service(viewer)
      assert.deepEqual([mine.routes.total, mine.pickups.due, mine.schemes.length], [6, 17, 1])
      const none = await service(lars)
      assert.deepEqual([none.routes, none.pickups, none.schemes, none.missedByReason], [routeCounts(), pickupStandings(), [], []])
      assert.equal(none.intervals.length, 7, "zeros, every day still answered")
      assert.deepEqual(none.rates, { collection: null, missed: null, onTime: null })
      assert.deepEqual((await service(other)).routes, routeCounts(), "another company reads its own rows, and has none")
    })

    test("refuses a project the caller does not work in, a window that runs backwards or past a year, and a parameter it does not read; and a role without the grant", async () => {
      const outside = await refused(await viewer(`/reports/service?${WEEK}&projectId=${harbor}`), 400)
      assert.deepEqual(outside.errors?.map((error) => error.path), ["projectId"])
      assert.deepEqual((await refused(await other(`/reports/service?${WEEK}&projectId=${copenhagen}`), 400)).errors?.map((error) => error.path), ["projectId"])
      assert.deepEqual((await refused(await olivia("/reports/service?from=2026-10-11&to=2026-10-05"), 400)).errors?.map((error) => error.path), ["to"])
      assert.deepEqual((await refused(await olivia("/reports/service?from=2026-01-01&to=2027-01-02"), 400)).errors, [{ path: "to", message: REPORT_WINDOW_TOO_LONG }])
      assert.equal((await olivia(`/reports/service?${WEEK}&unloadingStationId=${fleet.stations.amager.id}`)).status, 400, "a station is the tonnage report's filter, not this one's")
      assert.equal((await olivia("/reports/service?from=2026-10-05")).status, 400)
      assert.match((await refused(await ungranted(`/reports/service?${WEEK}`), 403)).detail ?? "", /route-studio\.routes/, "Performance alone does not read the routes it counts")
    })
  })

  describe("GET /reports/tickets", () => {
    type TicketSeed = { kind: TicketKind; status: TicketStatus; createdAt: string; projectId?: string; dueAt?: string; closedAt?: string; resolution?: TicketResolution; routeId?: string }

    const seedTicket = async (seed: TicketSeed): Promise<void> => {
      await withCompany(pool.db, a.companyId, async (tx: Tx) => {
        const number = await nextNumber(tx, a.companyId, "nextTicketNumber")
        await tx.insert(ticket).values({
          id: testId(),
          companyId: a.companyId,
          projectId: seed.projectId ?? copenhagen,
          number,
          kind: seed.kind,
          status: seed.status,
          source: "phone",
          subject: `A ${seed.kind} ticket`,
          description: "Seeded for the ticket report.",
          occurredAt: new Date(seed.createdAt),
          createdAt: new Date(seed.createdAt),
          createdBy: a.users.olivia.id,
          dueAt: seed.dueAt === undefined ? null : new Date(seed.dueAt),
          closedAt: seed.closedAt === undefined ? null : new Date(seed.closedAt),
          resolution: seed.resolution ?? null,
          routeId: seed.routeId ?? null,
        })
      })
    }

    before(async () => {
      // Opened Monday on the completed route, due Tuesday, still open: overdue.
      await seedTicket({ kind: "missed-collection", status: "open", createdAt: "2026-10-05T07:00:00Z", dueAt: "2026-10-06T07:00:00Z", routeId: ex.routes.completed.id })
      // Opened Tuesday, completed Wednesday, within its Thursday due time.
      await seedTicket({ kind: "missed-collection", status: "completed", resolution: "serviced", createdAt: "2026-10-06T07:00:00Z", dueAt: "2026-10-08T07:00:00Z", closedAt: "2026-10-07T08:00:00Z" })
      // Opened Wednesday, rejected Friday, after its Thursday due time.
      await seedTicket({ kind: "complaint", status: "rejected", createdAt: "2026-10-07T07:00:00Z", dueAt: "2026-10-08T07:00:00Z", closedAt: "2026-10-09T08:00:00Z" })
      // Opened before the window, completed inside it with no due time.
      await seedTicket({ kind: "overflow", status: "completed", resolution: "serviced", createdAt: "2026-10-01T07:00:00Z", closedAt: "2026-10-06T08:00:00Z" })
      // Opened Saturday on the late route, in progress, due after the clock.
      await seedTicket({ kind: "access-issue", status: "in-progress", createdAt: "2026-10-10T07:00:00Z", dueAt: "2026-10-30T07:00:00Z", routeId: lateStart.id })
      // Harbor's, opened Monday, open.
      await seedTicket({ kind: "other", status: "open", projectId: harbor, createdAt: "2026-10-05T07:00:00Z" })
      // 22:30Z on Sunday is 00:30 on Monday the 12th in Copenhagen: outside the window on the project's clock, inside it in UTC.
      await seedTicket({ kind: "internal-task", status: "pending", createdAt: "2026-10-11T22:30:00Z" })
    })

    test("counts the tickets opened and closed over the window on the project's clock, and the open ones now, overdue among them", async () => {
      const report = await tickets(olivia)
      assert.equal(report.asOf, NOW.toISOString())
      assert.deepEqual(
        [report.opened, report.closed, report.completed, report.rejected, report.closedWithDue, report.closedWithinDue, report.open, report.overdue, report.openOnRoutes],
        [5, 3, 2, 1, 2, 1, 4, 1, 2],
      )
      assert.deepEqual(report.rates, { closedWithinDue: 0.5 })
      assert.deepEqual(report.byKind, [
        { kind: "missed-collection", opened: 2, closed: 1, open: 1 },
        { kind: "overflow", opened: 0, closed: 1, open: 0 },
        { kind: "access-issue", opened: 1, closed: 0, open: 1 },
        { kind: "complaint", opened: 1, closed: 1, open: 0 },
        { kind: "internal-task", opened: 0, closed: 0, open: 1 },
        { kind: "other", opened: 1, closed: 0, open: 1 },
      ])
      assert.deepEqual(
        report.intervals.map((span) => [span.from, span.opened, span.closed]),
        [
          ["2026-10-05", 2, 0],
          ["2026-10-06", 1, 1],
          ["2026-10-07", 1, 1],
          ["2026-10-08", 0, 0],
          ["2026-10-09", 0, 1],
          ["2026-10-10", 1, 0],
          ["2026-10-11", 0, 0],
        ],
      )
    })

    test("counts only the caller's projects, refuses a parameter it does not read, and a role without the grant", async () => {
      const mine = await tickets(viewer)
      assert.deepEqual([mine.opened, mine.open, mine.byKind.some((counts) => counts.kind === "other")], [4, 3, false])
      const none = await tickets(lars)
      assert.deepEqual([none.opened, none.closed, none.open, none.overdue, none.byKind, none.rates.closedWithinDue], [0, 0, 0, 0, [], null])
      assert.equal((await olivia(`/reports/tickets?${WEEK}&wasteFractionId=${ex.fractions.glass.id}`)).status, 400)
      assert.match((await refused(await ungranted(`/reports/tickets?${WEEK}`), 403)).detail ?? "", /operate\.tickets/, "nor the tickets")
    })
  })

  describe("GET /reports/revenue", () => {
    const entered = async (agreementId: string): Promise<BillableEvent> => {
      const response = await olivia("/billable-events", { method: "POST", body: { projectId: copenhagen, agreementId, productId: fx.products.residual.id, quantity: 1, serviceDate: fx.day } })
      assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
      return BillableEvent.parse(await response.json())
    }

    before(async () => {
      // The housing association's two pickups at its negotiated 100.00 kr, Anna's at the list's 120.00 kr, and the association's EUR pickup at 16.00 EUR.
      await entered(fx.agreements.housingDkk.id)
      await entered(fx.agreements.housingDkk.id)
      await entered(fx.agreements.anna.id)
      await entered(fx.agreements.housingEur.id)
      const response = await olivia("/billing-runs", { method: "POST", body: { projectId: copenhagen, periodFrom: fx.day, periodTo: fx.day } })
      assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
      const run = BillingRunDetail.parse(await response.json())
      assert.equal(run.invoiceIds.length, 3)
      const invoices = await Promise.all(run.invoiceIds.map((id) => read(olivia, `/invoices/${id}`, InvoiceDetail)))
      const annas = invoices.find((document) => document.customerId === fx.customers.anna.id)
      assert.ok(annas)
      await created(olivia, `/invoices/${annas.id}/credit-notes`, await olivia(`/invoices/${annas.id}/credit-notes`, { method: "POST", body: { reason: "service-not-delivered", lines: "all" } }), InvoiceDetail, "/invoices")
    })

    test("totals the documents issued over the window by currency, a credit note's negative, never summing two currencies", async () => {
      const report = await revenue(olivia, "from=2026-10-01&to=2026-10-31&interval=month")
      assert.deepEqual(report.currencies, [
        { currency: "DKK", invoices: 2, creditNotes: 1, netMinor: 20_000, vatMinor: 5_000, grossMinor: 25_000 },
        { currency: "EUR", invoices: 1, creditNotes: 0, netMinor: 1_600, vatMinor: 400, grossMinor: 2_000 },
      ])
      assert.deepEqual(
        report.intervals.map((span) => [span.from, span.to, span.currency, span.netMinor]),
        [
          ["2026-10-01", "2026-10-31", "DKK", 20_000],
          ["2026-10-01", "2026-10-31", "EUR", 1_600],
        ],
      )
      assert.deepEqual(report.products, [
        { productId: fx.products.residual.id, name: fx.products.residual.name, currency: "DKK", quantity: 2, netMinor: 20_000 },
        { productId: fx.products.residual.id, name: fx.products.residual.name, currency: "EUR", quantity: 1, netMinor: 1_600 },
      ], "Anna's pickup was invoiced and credited: three lines, two of them standing")
    })

    test("reads by the issuing day: a window before the run's issues nothing", async () => {
      const report = await revenue(olivia, "from=2026-10-01&to=2026-10-23")
      assert.deepEqual([report.currencies, report.intervals, report.products], [[], [], []])
    })

    test("is held by the invoices' grant, not Improve's, and counts only the caller's projects", async () => {
      assert.match((await refused(await lars("/reports/revenue?from=2026-10-01&to=2026-10-31"), 403)).detail ?? "", /commercial\.invoices/)
      assert.equal((await revenue(viewer, "from=2026-10-01&to=2026-10-31")).currencies.length, 2, "the viewer works in Copenhagen, where the documents were issued")
      assert.deepEqual((await revenue(olivia, `from=2026-10-01&to=2026-10-31&projectId=${harbor}`)).currencies, [])
    })
  })

  describe("GET /reports/tonnage", () => {
    let vestforbraending: string

    const capture = async (routeId: string, values: { unloadingStationId?: string; wasteFractionId?: string; netKg: number; occurredAt: string }): Promise<Unload> => {
      const body = { unloadingStationId: fleet.stations.amager.id, wasteFractionId: ex.fractions.residual.id, ...values }
      return await created(olivia, `/routes/${routeId}/unloads`, await olivia(`/routes/${routeId}/unloads`, { method: "POST", body }), Unload, "/unloads")
    }
    const decide = async (id: string, verb: "approve" | "reject" | "correct", body: Record<string, unknown> = {}) => {
      const response = await olivia(`/unloads/${id}/${verb}`, { method: "POST", body })
      assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    }

    before(async () => {
      vestforbraending = testId()
      await withCompany(pool.db, a.companyId, async (tx: Tx) => {
        await tx.insert(unloadingStation).values({
          id: vestforbraending,
          companyId: a.companyId,
          code: "VF-GLOSTRUP",
          name: "Vestforbrænding",
          address: "Ejbymosevej 219, 2600 Glostrup",
          location: { type: "Point", coordinates: [12.3946, 55.6735] },
          ownership: "external",
          weighbridge: true,
          status: "active",
        })
      })
      const completed = ex.routes.completed.id
      // Monday at Amager: 8,000 kg approved and 2,000 kg nobody has looked at.
      await decide((await capture(completed, { netKg: 8_000, occurredAt: at("2026-10-05", "12:40").toISOString() })).id, "approve")
      await capture(completed, { netKg: 2_000, occurredAt: at("2026-10-05", "13:00").toISOString() })
      // Tuesday: a glass load refused at Vestforbrænding, and 5,000 kg at Amager corrected to 4,800.
      await decide((await capture(lateStart.id, { unloadingStationId: vestforbraending, wasteFractionId: ex.fractions.glass.id, netKg: 1_500, occurredAt: at("2026-10-06", "11:00").toISOString() })).id, "reject", { note: "Contaminated load refused at the gate" })
      await decide((await capture(lateStart.id, { netKg: 5_000, occurredAt: at("2026-10-06", "12:00").toISOString() })).id, "correct", { netKg: 4_800, note: "Net misread at the bridge" })
      // Harbor's Monday: 3,000 kg at Amager.
      await capture(harborRoute.id, { netKg: 3_000, occurredAt: at("2026-10-05", "11:00").toISOString() })
      // 22:30Z on Sunday is Monday the 12th in Copenhagen: outside the window.
      await capture(completed, { netKg: 700, occurredAt: "2026-10-11T22:30:00.000Z" })
    })

    test("totals the window's net weight by review — approved and captured counted apart, a rejected load beside them, a corrected one by its correction — and the pickups' weights", async () => {
      const { window, totals } = await tonnage(olivia, `${WEEK}&interval=week`)
      assert.equal(window.interval, "week")
      assert.deepEqual(totals, { netKg: 17_800, approvedKg: 8_000, capturedKg: 9_800, unloads: 4, rejectedKg: 1_500, rejectedUnloads: 1, pickupWeightKg: 127, weighedPickups: 3 })
    })

    test("answers the unloads by project, fraction, station and interval, and the pickup weights by project, fraction and interval", async () => {
      const { unloads, pickupWeights } = await tonnage(olivia, `${WEEK}&interval=week`)
      const row = (projectId: string, fractionId: string, stationId: string) => unloads.find((candidate) => candidate.projectId === projectId && candidate.wasteFractionId === fractionId && candidate.unloadingStationId === stationId)
      assert.equal(unloads.length, 3)
      assert.deepEqual(row(copenhagen, ex.fractions.residual.id, fleet.stations.amager.id), {
        from: "2026-10-05",
        to: "2026-10-11",
        projectId: copenhagen,
        wasteFractionId: ex.fractions.residual.id,
        wasteFractionName: "Residual waste",
        unloadingStationId: fleet.stations.amager.id,
        unloadingStationName: "ARC Amager Bakke",
        netKg: 14_800,
        approvedKg: 8_000,
        capturedKg: 6_800,
        unloads: 3,
        rejectedKg: 0,
        rejectedUnloads: 0,
      })
      assert.deepEqual(
        [row(copenhagen, ex.fractions.glass.id, vestforbraending)?.netKg, row(copenhagen, ex.fractions.glass.id, vestforbraending)?.rejectedKg, row(copenhagen, ex.fractions.glass.id, vestforbraending)?.unloadingStationName],
        [0, 1_500, "Vestforbrænding"],
      )
      assert.deepEqual([row(harbor, ex.fractions.residual.id, fleet.stations.amager.id)?.capturedKg, row(harbor, ex.fractions.residual.id, fleet.stations.amager.id)?.unloads], [3_000, 1])
      assert.deepEqual(
        pickupWeights.map((weights) => [weights.projectId, weights.wasteFractionName, weights.weightKg, weights.pickups]).sort((x, y) => String(x[1]).localeCompare(String(y[1]))),
        [
          [copenhagen, "Glass", 42, 1],
          [copenhagen, "Residual waste", 85, 2],
        ],
        "the glass pickup's second reading is its weight; the removed pickup's and the regeneration's route's weights are not counted",
      )
    })

    test("by the day, Monday's and Tuesday's Amager residual apart", async () => {
      const { unloads } = await tonnage(olivia)
      const amager = unloads.filter((row) => row.projectId === copenhagen && row.wasteFractionId === ex.fractions.residual.id).map((row) => [row.from, row.netKg, row.approvedKg, row.capturedKg, row.unloads])
      assert.deepEqual(amager, [
        ["2026-10-05", 10_000, 8_000, 2_000, 2],
        ["2026-10-06", 4_800, 0, 4_800, 1],
      ])
    })

    test("narrows to a fraction — the unloads and the pickups — and to a station, the unloads alone", async () => {
      const glass = await tonnage(olivia, `${WEEK}&wasteFractionId=${ex.fractions.glass.id}`)
      assert.deepEqual([glass.totals.netKg, glass.totals.rejectedKg, glass.totals.pickupWeightKg], [0, 1_500, 42])
      const amager = await tonnage(olivia, `${WEEK}&unloadingStationId=${fleet.stations.amager.id}`)
      assert.deepEqual([amager.totals.netKg, amager.totals.rejectedKg, amager.totals.pickupWeightKg], [17_800, 0, 127], "a pickup's weight is weighed at the kerb, whatever the station")
    })

    test("counts only the caller's projects, and is held by Improve's Analytics", async () => {
      assert.equal((await tonnage(viewer)).totals.netKg, 14_800)
      assert.deepEqual((await tonnage(lars)).totals, { netKg: 0, approvedKg: 0, capturedKg: 0, unloads: 0, rejectedKg: 0, rejectedUnloads: 0, pickupWeightKg: 0, weighedPickups: 0 })
      assert.equal((await tonnage(other)).unloads.length, 0)
      assert.match((await refused(await ungranted(`/reports/tonnage?${WEEK}`), 403)).detail ?? "", /improve\.analytics/, "Analytics is not held")
      assert.match((await refused(await ungranted("/reports/revenue?from=2026-10-01&to=2026-10-31"), 403)).detail ?? "", /improve\.analytics/)
      assert.equal(running.projectId, copenhagen)
    })

    // The regulatory report over the same week (#291 slice 29): after the tonnage tests above, since it adds an approved glass load and the residual's code.
    describe("GET /reports/waste-data and its file", () => {
      const wasteData = (call: Call, query = WEEK) => read(call, `/reports/waste-data?${query}`, WasteDataReport)

      before(async () => {
        const coded = await olivia(`/waste-fractions/${ex.fractions.residual.id}`, { method: "PATCH", body: { wasteCode: "200301" } })
        assert.equal(coded.status, 200, JSON.stringify(await coded.clone().json()))
        // Monday at Amager: 1,200 kg of glass, approved — a fraction with no code yet.
        await decide((await capture(ex.routes.completed.id, { wasteFractionId: ex.fractions.glass.id, netKg: 1_200, occurredAt: at("2026-10-05", "14:00").toISOString() })).id, "approve")
        // And Harbor's 500 kg, approved: a business unit's, filed under its name.
        await decide((await capture(harborRoute.id, { netKg: 500, occurredAt: at("2026-10-05", "15:00").toISOString() })).id, "approve")
        await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: "improve.compliance", actions: ["view"] }])
      })

      const harborRow = (): WasteDataRow => ({
        projectId: harbor,
        municipality: "Harbor Commercial",
        unloadingStationId: fleet.stations.amager.id,
        unloadingStationName: "ARC Amager Bakke",
        wasteFractionId: ex.fractions.residual.id,
        wasteFractionName: "Residual waste",
        wasteCode: "200301",
        netKg: 500,
        unloads: 1,
      })

      test("files the approved loads by municipality, station and fraction with their codes, and warns of a fraction without one, of a project that is no municipality, and of the loads nobody has reviewed", async () => {
        const report = await wasteData(olivia)
        assert.deepEqual(report.window, { projectId: null, from: "2026-10-05", to: "2026-10-11" })
        const place = { projectId: copenhagen, municipality: "Copenhagen Central", unloadingStationId: fleet.stations.amager.id, unloadingStationName: "ARC Amager Bakke" }
        assert.deepEqual(report.rows, [
          { ...place, wasteFractionId: ex.fractions.glass.id, wasteFractionName: "Glass", wasteCode: null, netKg: 1_200, unloads: 1 },
          // 8,000 approved; 2,000 nobody has looked at and the correction's 4,800 are warned of, the rejected glass at Vestforbrænding counted nowhere, Sunday's 700 outside the week.
          { ...place, wasteFractionId: ex.fractions.residual.id, wasteFractionName: "Residual waste", wasteCode: "200301", netKg: 8_000, unloads: 1 },
          harborRow(),
        ])
        assert.deepEqual(report.totals, { netKg: 9_700, unloads: 3 })
        const noCode = { kind: "no-waste-code" as const, wasteFractionId: ex.fractions.glass.id, wasteFractionName: "Glass" }
        const harborNotMunicipal = { kind: "not-a-municipality" as const, projectId: harbor, municipality: "Harbor Commercial", projectKind: "Business unit" }
        const copenhagenUnreviewed = { kind: "not-reviewed" as const, ...place, wasteFractionId: ex.fractions.residual.id, wasteFractionName: "Residual waste", unloads: 2, netKg: 6_800 }
        const harborUnreviewed = { kind: "not-reviewed" as const, projectId: harbor, municipality: "Harbor Commercial", unloadingStationId: fleet.stations.amager.id, unloadingStationName: "ARC Amager Bakke", wasteFractionId: ex.fractions.residual.id, wasteFractionName: "Residual waste", unloads: 1, netKg: 3_000 }
        assert.deepEqual(report.warnings, [noCode, harborNotMunicipal, copenhagenUnreviewed, harborUnreviewed].map((warning) => ({ ...warning, sentence: wasteDataWarningSentence(warning) })))
      })

      test("downloads as the documented file, with commas or semicolons", async () => {
        const response = await olivia(`/reports/waste-data.csv?${WEEK}`)
        assert.equal(response.status, 200)
        assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8")
        assert.equal(response.headers.get("content-disposition"), 'attachment; filename="waste-data-2026-10-05-2026-10-11.csv"')
        const text = await response.text()
        const records = csvRecords(text).map((record) => record.fields)
        assert.deepEqual(records[0], [...WASTE_DATA_COLUMNS])
        assert.deepEqual(records.slice(1, 3), [
          ["2026-10-05", "2026-10-11", "Copenhagen Central", "ARC Amager Bakke", "Glass", "", "1200", ""],
          ["2026-10-05", "2026-10-11", "Copenhagen Central", "ARC Amager Bakke", "Residual waste", "200301", "8000", ""],
        ])
        assert.deepEqual(records[3], ["2026-10-05", "2026-10-11", "Harbor Commercial", "ARC Amager Bakke", "Residual waste", "200301", "500", ""])
        assert.equal(records.length, 8, "the header, three rows and four warning rows")
        assert.equal(records[4]?.[7], "Glass has no waste code: set it under the fraction in Settings › Master data before the report is filed")
        assert.deepEqual(records[5]?.slice(2, 7), ["Harbor Commercial", "", "", "", ""], "a project's warning row names the project alone")
        const semicolons = await (await olivia(`/reports/waste-data.csv?${WEEK}&separator=semicolon`)).text()
        assert.equal(semicolons.replace(/^\uFEFF/, "").split("\r\n")[0], WASTE_DATA_COLUMNS.join(";"))
      })

      test("counts only the caller's projects, is held by Improve's Compliance and the weights' grant, and refuses what it does not read", async () => {
        const viewed = await wasteData(viewer)
        assert.deepEqual([viewed.totals, viewed.warnings.map((warning) => warning.kind)], [{ netKg: 9_200, unloads: 2 }, ["no-waste-code", "not-reviewed"]], "the viewer works in Copenhagen alone")
        assert.deepEqual((await wasteData(olivia, `${WEEK}&projectId=${harbor}`)).rows, [harborRow()])
        assert.deepEqual((await wasteData(other)).rows, [])
        assert.match((await refused(await lars(`/reports/waste-data?${WEEK}`), 403)).detail ?? "", /improve\.compliance/)
        assert.match((await refused(await ungranted(`/reports/waste-data.csv?${WEEK}`), 403)).detail ?? "", /improve\.compliance/)
        assert.equal((await refused(await olivia(`/reports/waste-data?${WEEK}&interval=week`), 400)).errors?.[0]?.path, "interval", "a filing is one period's, with no series")
        assert.equal((await refused(await viewer(`/reports/waste-data?${WEEK}&projectId=${harbor}`), 400)).errors?.[0]?.path, "projectId")
        assert.equal((await refused(await olivia(`/reports/waste-data.csv?${WEEK}&separator=tab`), 400)).errors?.[0]?.path, "separator")
      })

      // Last, since it adds a load to the week the tests above count.
      test("warns only of the rows it files: a fraction without a code whose loads nobody has reviewed is in the not-reviewed warning alone", async () => {
        // Tuesday at Amager: 400 kg of glass nobody has reviewed, on a day of its own.
        await capture(ex.routes.completed.id, { wasteFractionId: ex.fractions.glass.id, netKg: 400, occurredAt: at("2026-10-06", "14:00").toISOString() })
        const tuesday = await wasteData(olivia, "from=2026-10-06&to=2026-10-06")
        assert.deepEqual(tuesday.rows, [])
        assert.deepEqual(
          tuesday.warnings.map((warning) => [warning.kind, warning.kind === "not-reviewed" ? warning.wasteFractionName : null]),
          [
            ["not-reviewed", "Glass"],
            ["not-reviewed", "Residual waste"],
          ],
        )
      })
    })
  })

  // Last, since it adds a route to the week the suites above count.
  describe("the office's ad-hoc routes (#111)", () => {
    test("count in the window as any route does, and stand in a row of their own per project, after the schemes, with no scheme and no name", async () => {
      const before = await service(olivia)
      const made = await olivia("/routes", { method: "POST", body: { projectId: copenhagen, operatingDate: "2026-10-09" } })
      assert.equal(made.status, 201, JSON.stringify(await made.clone().json()))
      const { id } = (await made.json()) as { id: string }
      const stop = await olivia(`/routes/${id}/pickups`, { method: "POST", body: { propertyId: ex.properties.parkvej.id, wasteFractionId: ex.fractions.residual.id } })
      assert.equal(stop.status, 201, JSON.stringify(await stop.clone().json()))

      const after = await service(olivia)
      assert.deepEqual([after.routes.total, after.routes.planned, after.pickups.due, after.pickups.open], [before.routes.total + 1, before.routes.planned + 1, before.pickups.due + 1, before.pickups.open + 1])
      assert.deepEqual(
        after.schemes.map((scheme) => [scheme.name, scheme.routeSchemeId === null, scheme.projectId, scheme.routes.total, scheme.pickups.open]),
        [
          ["Centrum Mondays", false, copenhagen, 6, 8],
          ["Havnen Mondays", false, harbor, 1, 0],
          [null, true, copenhagen, 1, 1],
        ],
      )
      assert.equal(after.intervals.find((span) => span.from === "2026-10-09")?.routes.planned, 1)
      const centrum = await service(olivia, `${WEEK}&routeSchemeId=${ex.schemes.copenhagen.id}`)
      assert.equal(centrum.schemes.some((scheme) => scheme.routeSchemeId === null), false, "a scheme's filter leaves the ad-hoc routes out")
    })
  })
})
