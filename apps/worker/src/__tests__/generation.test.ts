// Generation against Postgres (Issue #97 part B), on a database of this
// file's own: migration 0012 applied, two companies seeded as the owner —
// each a project in Copenhagen with a planning area whose boundary is a
// square over the city, a validated weekly scheme on Mondays and Thursdays
// with a rule group for residual waste and a manual glass group on
// Thursdays, an agreement, a subscription per property, and containers
// placed under them — and then the job run as the process runs it: the
// writes as `wms_api` under `withCompany` on a pool logged in as the API
// role, the sweep as `wms_worker` on a pool logged in as the worker role,
// both logins the local stack's (bootstrap gave them cluster-wide, and every
// role of the stack has the one password), so what is proved is what the
// roles may do and not what the owner may.
//
// Proved: a run writes the routes and their pickups with the place and the
// fraction of the day, numbered from the company's counter in a block; a
// second run over the same window writes nothing and moves no `updated_at`;
// a boundary that moves changes the stops of later dates and leaves the
// earlier ones; a shifted holiday keeps the service date and moves the
// operating date; a placement that ends mid-window drops out of the later
// dates; a shrunk scheme cancels the planned routes it leaves with the
// sentence and leaves a ready one; a run of the cancelled identity brings
// the route back; the drift stamp is written when the set moves and not for
// the same set; a failing run leaves the row `failed` with the projection
// and nothing written; the sweep finds exactly the eligible schemes across
// companies, writes each a run as `wms_api` and sends its job in the same
// transaction, and a scheme mid-generation is not queued twice; the API role
// sees its company's runs and stamps and nothing of another's; a route the
// office held (#209) keeps its day, start and Planned Assignment through a
// run that still refreshes its pickups and its note, the hold alone writing
// nothing, and a cancel still cancels it and clears the hold — but under a
// skipped holiday a route the office held on another day stays (#226); a
// route created or refreshed on a day its group's driver is absent, or its
// vehicle out of use, is written without them with the run's warning, a held
// one keeps the office's crew and only warns, and the period gone, the next
// run writes the group's crew back (O6 of #290).
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { routeLabel } from "@waste/contracts/execution"
import type { Point, Polygon } from "@waste/contracts/geojson"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { GENERATE_ROUTES_QUEUE } from "@waste/db/commands/generation"
import { migrateDatabase } from "@waste/db/migrate"
import { agreement, subscription, subscriptionPause } from "@waste/db/schema/agreements"
import { driverAbsence, vehicleUnavailability } from "@waste/db/schema/availability"
import { containerType, product, wasteFraction } from "@waste/db/schema/catalogue"
import { collectionCalendar, collectionCalendarHoliday } from "@waste/db/schema/collection-calendars"
import { container, containerServicePlacement } from "@waste/db/schema/containers"
import { customer, property } from "@waste/db/schema/customers"
import { pickup, route } from "@waste/db/schema/execution"
import { driver, vehicle } from "@waste/db/schema/fleet"
import { vehicleType } from "@waste/db/schema/fleet-types"
import { generationMatch, generationRun } from "@waste/db/schema/generation"
import { company, project, serviceProvider } from "@waste/db/schema/organisation"
import { depot, unloadingStation } from "@waste/db/schema/places"
import { planningArea, planningAreaBoundary } from "@waste/db/schema/planning-areas"
import { collectionGroup, collectionGroupContainer, collectionGroupFraction, routeScheme } from "@waste/db/schema/route-schemes"
import { PGBOSS_SCHEMA } from "@waste/db/sql/pgboss"
import { withCompany } from "@waste/db/tenant"
import { NO_LONGER_SERVES_DATE, NO_PLANNING_AREA, REMOVED_FROM_DAY_PLAN } from "@waste/domain/planning/generation"
import { and, asc, eq, sql } from "drizzle-orm"
import { PgBoss } from "pg-boss"

import { createBoss, startBoss, type Boss } from "../boss"
import type { JobContext } from "../jobs"
import { DRAFT_GENERATES_NOTHING, generateRoutes, runGeneration } from "../jobs/generate-routes"
import { eligibleSchemes, PLAN_AHEAD_QUEUE, planAhead } from "../jobs/plan-ahead"
import { databaseUnderTest, ownerUnderTest, workerUnderTest } from "./database"
import { fakeRouting, settlesNothing } from "./routing-context"

const owner = ownerUnderTest()
const apiRole = databaseUnderTest()
const workerRole = workerUnderTest()
const skip = owner.skip || apiRole.skip || workerRole.skip

/** One company's fixture ids, a nibble telling the companies apart; this file's own bucket, on its own database. */
const ids = (n: "a" | "b") => ({
  company: `018f7c36-${n}000-7000-8000-000000000001`,
  project: `018f7c36-${n}000-7000-8000-000000000002`,
  wasteFraction: `018f7c36-${n}000-7000-8000-000000000003`,
  glassFraction: `018f7c36-${n}000-7000-8000-000000000004`,
  containerType: `018f7c36-${n}000-7000-8000-000000000005`,
  customer: `018f7c36-${n}000-7000-8000-000000000006`,
  product: `018f7c36-${n}000-7000-8000-000000000007`,
  agreement: `018f7c36-${n}000-7000-8000-000000000008`,
  /** Inside the square. */
  parkvej: `018f7c36-${n}000-7000-8000-000000000009`,
  /** Inside the square too, further east. */
  havnegade: `018f7c36-${n}000-7000-8000-00000000000a`,
  /** Outside the square, in Amager. */
  amager: `018f7c36-${n}000-7000-8000-00000000000b`,
  /** No location at all. */
  unlocated: `018f7c36-${n}000-7000-8000-00000000000c`,
  parkvejSubscription: `018f7c36-${n}000-7000-8000-00000000000d`,
  havnegadeSubscription: `018f7c36-${n}000-7000-8000-00000000000e`,
  amagerSubscription: `018f7c36-${n}000-7000-8000-00000000000f`,
  unlocatedSubscription: `018f7c36-${n}000-7000-8000-000000000010`,
  bin1: `018f7c36-${n}000-7000-8000-000000000011`,
  bin2: `018f7c36-${n}000-7000-8000-000000000012`,
  bin3: `018f7c36-${n}000-7000-8000-000000000013`,
  bin4: `018f7c36-${n}000-7000-8000-000000000014`,
  glassBin: `018f7c36-${n}000-7000-8000-000000000015`,
  /** A residual bin at the property with no location: the rule wants it and nobody can say where it is. */
  nowhereBin: `018f7c36-${n}000-7000-8000-000000000016`,
  placement1: `018f7c36-${n}000-7000-8000-000000000021`,
  placement2: `018f7c36-${n}000-7000-8000-000000000022`,
  placement3: `018f7c36-${n}000-7000-8000-000000000023`,
  placement4: `018f7c36-${n}000-7000-8000-000000000024`,
  glassPlacement: `018f7c36-${n}000-7000-8000-000000000025`,
  nowherePlacement: `018f7c36-${n}000-7000-8000-000000000026`,
  planningArea: `018f7c36-${n}000-7000-8000-000000000031`,
  boundary: `018f7c36-${n}000-7000-8000-000000000032`,
  calendar: `018f7c36-${n}000-7000-8000-000000000033`,
  holiday: `018f7c36-${n}000-7000-8000-000000000034`,
  scheme: `018f7c36-${n}000-7000-8000-000000000041`,
  residualGroup: `018f7c36-${n}000-7000-8000-000000000042`,
  glassGroup: `018f7c36-${n}000-7000-8000-000000000043`,
  /** A second, draft scheme the sweep must not find. */
  draftScheme: `018f7c36-${n}000-7000-8000-000000000044`,
  draftGroup: `018f7c36-${n}000-7000-8000-000000000045`,
  /** The office's crew and ends for a held route (#209), none of which the scheme or its groups name; written by that test alone. */
  vehicleType: `018f7c36-${n}000-7000-8000-000000000051`,
  vehicle: `018f7c36-${n}000-7000-8000-000000000052`,
  driver: `018f7c36-${n}000-7000-8000-000000000053`,
  depot: `018f7c36-${n}000-7000-8000-000000000054`,
  station: `018f7c36-${n}000-7000-8000-000000000055`,
  provider: `018f7c36-${n}000-7000-8000-000000000056`,
  /** The residual group's crew while O6's test runs (#290), and their periods away. */
  crewVehicle: `018f7c36-${n}000-7000-8000-000000000061`,
  crewDriver: `018f7c36-${n}000-7000-8000-000000000062`,
  absence: `018f7c36-${n}000-7000-8000-000000000063`,
  unavailability: `018f7c36-${n}000-7000-8000-000000000064`,
  /** A trailer the office hangs on a held route, and its time in for repair. */
  crewTrailer: `018f7c36-${n}000-7000-8000-000000000065`,
  trailerRepair: `018f7c36-${n}000-7000-8000-000000000066`,
})
const a = ids("a")
const b = ids("b")

/** A square over central Copenhagen. */
const SQUARE: Polygon = { type: "Polygon", coordinates: [[[12.5, 55.65], [12.65, 55.65], [12.65, 55.75], [12.5, 55.75], [12.5, 55.65]]] }
/** The western half of it: Parkvej stays inside, Havnegade falls out. */
const WEST_HALF: Polygon = { type: "Polygon", coordinates: [[[12.5, 55.65], [12.58, 55.65], [12.58, 55.75], [12.5, 55.75], [12.5, 55.65]]] }
const PARKVEJ: Point = { type: "Point", coordinates: [12.55, 55.7] }
const HAVNEGADE: Point = { type: "Point", coordinates: [12.62, 55.7] }
const AMAGER: Point = { type: "Point", coordinates: [12.62, 55.62] }

const OPENED = "2026-01-01"
/** Monday 5 October 2026 to Sunday 11 October: a Monday and a Thursday of the scheme. */
const WEEK = { from: "2026-10-05", to: "2026-10-11" }
/** The instant the tests run at: a Saturday evening in Copenhagen, so `today` there is the 3rd and the sweep's window begins on the 4th. */
const NOW = new Date("2026-10-03T18:00:00Z")

/** The same server and credentials, another database. */
const withDatabaseName = (url: string, name: string): string => {
  const parsed = new URL(url)
  parsed.pathname = `/${name}`
  return parsed.toString()
}

/** A company as the owner: the project, the catalogue, the customer and its four properties, the agreement and the subscriptions, five placed containers, the area with its boundary, the calendar with one holiday, and the two schemes. */
async function seed(tx: Tx, n: "a" | "b"): Promise<void> {
  const own = ids(n)
  const tenant = { companyId: own.company }
  const scoped = { ...tenant, projectId: own.project }
  await tx.insert(company).values({ id: own.company, ...tenant, name: `Company ${n}`, legalName: `Company ${n} A/S`, registrationNumber: `1000000${n}`, country: "DK", status: "active" })
  await tx.insert(project).values({ id: own.project, ...tenant, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active", weekend: ["saturday", "sunday"], holidayList: "Danish public holidays" })
  await tx.insert(wasteFraction).values([
    { id: own.wasteFraction, ...tenant, key: "residual", name: "Residual waste" },
    { id: own.glassFraction, ...tenant, key: "glass", name: "Glass" },
  ])
  await tx.insert(containerType).values({ id: own.containerType, ...tenant, name: "240 L bin", volumeLitres: 240 })
  await tx.insert(customer).values({ id: own.customer, ...tenant, kind: "organisation", name: "Parkvej Boligforening", registrationNumber: `3000000${n}`, status: "active" })
  await tx.insert(product).values({ id: own.product, ...scoped, name: "Residual 240 L weekly", kind: "container-collection", status: "active", unit: "pickup", containerTypeId: own.containerType, wasteFractionId: own.wasteFraction })
  await tx.insert(property).values([
    { id: own.parkvej, ...scoped, name: "Parkvej 18", address: "Parkvej 18", kind: "residential", status: "active", location: PARKVEJ },
    { id: own.havnegade, ...scoped, name: "Havnegade 2", address: "Havnegade 2", kind: "commercial", status: "active", location: HAVNEGADE },
    { id: own.amager, ...scoped, name: "Amagerbrogade 1", address: "Amagerbrogade 1", kind: "residential", status: "active", location: AMAGER },
    { id: own.unlocated, ...scoped, name: "Nowhere 1", address: "Nowhere 1", kind: "residential", status: "active" },
  ])
  await tx.insert(agreement).values({ id: own.agreement, ...scoped, validFrom: OPENED, number: "AGR-2408", customerId: own.customer, payerCustomerId: own.customer, status: "active", billingCadence: "monthly", currency: "DKK" })
  await tx.insert(subscription).values([
    { id: own.parkvejSubscription, ...scoped, validFrom: OPENED, agreementId: own.agreement, productId: own.product, propertyId: own.parkvej },
    { id: own.havnegadeSubscription, ...scoped, validFrom: OPENED, agreementId: own.agreement, productId: own.product, propertyId: own.havnegade },
    { id: own.amagerSubscription, ...scoped, validFrom: OPENED, agreementId: own.agreement, productId: own.product, propertyId: own.amager },
    { id: own.unlocatedSubscription, ...scoped, validFrom: OPENED, agreementId: own.agreement, productId: own.product, propertyId: own.unlocated },
  ])
  await tx.insert(container).values([
    { id: own.bin1, ...scoped, label: "BIN-1001", containerTypeId: own.containerType, ownership: "company" },
    { id: own.bin2, ...scoped, label: "BIN-1002", containerTypeId: own.containerType, ownership: "company" },
    { id: own.bin3, ...scoped, label: "BIN-1003", containerTypeId: own.containerType, ownership: "company" },
    { id: own.bin4, ...scoped, label: "BIN-1004", containerTypeId: own.containerType, ownership: "company" },
    { id: own.glassBin, ...scoped, label: "BIN-1005", containerTypeId: own.containerType, ownership: "company" },
    { id: own.nowhereBin, ...scoped, label: "BIN-1006", containerTypeId: own.containerType, ownership: "company" },
  ])
  await tx.insert(containerServicePlacement).values([
    // Parkvej: bin 1 for good, bin 2 until the Thursday of the week (valid_to is the first day out).
    { id: own.placement1, ...scoped, validFrom: OPENED, containerId: own.bin1, subscriptionId: own.parkvejSubscription, wasteFractionId: own.wasteFraction },
    { id: own.placement2, ...scoped, validFrom: OPENED, validTo: "2026-10-08", containerId: own.bin2, subscriptionId: own.parkvejSubscription, wasteFractionId: own.wasteFraction },
    // Havnegade: bin 3, inside the square and outside its western half.
    { id: own.placement3, ...scoped, validFrom: OPENED, containerId: own.bin3, subscriptionId: own.havnegadeSubscription, wasteFractionId: own.wasteFraction },
    // Amager: bin 4, outside the square altogether.
    { id: own.placement4, ...scoped, validFrom: OPENED, containerId: own.bin4, subscriptionId: own.amagerSubscription, wasteFractionId: own.wasteFraction },
    // The glass bin at Parkvej, picked by hand.
    { id: own.glassPlacement, ...scoped, validFrom: OPENED, containerId: own.glassBin, subscriptionId: own.parkvejSubscription, wasteFractionId: own.glassFraction },
    // A residual bin at the property nobody has located: the rule wants it, and it is counted as unlocated.
    { id: own.nowherePlacement, ...scoped, validFrom: OPENED, containerId: own.nowhereBin, subscriptionId: own.unlocatedSubscription, wasteFractionId: own.wasteFraction },
  ])
  await tx.insert(planningArea).values({ id: own.planningArea, ...scoped, code: "OP-CEN-01", name: "Central", purpose: "route-planning" })
  await tx.insert(planningAreaBoundary).values({ id: own.boundary, ...scoped, validFrom: OPENED, planningAreaId: own.planningArea, boundary: SQUARE })
  await tx.insert(collectionCalendar).values({ id: own.calendar, ...scoped, validFrom: OPENED, validTo: "2027-01-01", name: "Copenhagen Central 2026" })
  // Thursday 8 October 2026 is a holiday here.
  await tx.insert(collectionCalendarHoliday).values({ id: own.holiday, ...scoped, collectionCalendarId: own.calendar, day: "2026-10-08", name: "Test Day" })
  await tx.insert(routeScheme).values([
    { id: own.scheme, ...scoped, validFrom: OPENED, name: "Residual weekly", planningAreaId: own.planningArea, serviceType: "container-collection", frequency: "weekly", serviceDays: ["monday", "thursday"], holidayPolicy: "shift-next", status: "validated", plannedStartTime: "06:30" },
    { id: own.draftScheme, ...scoped, validFrom: OPENED, name: "Paper draft", planningAreaId: own.planningArea, serviceType: "container-collection", frequency: "weekly", serviceDays: ["tuesday"], status: "draft" },
  ])
  await tx.insert(collectionGroup).values([
    { id: own.residualGroup, ...scoped, routeSchemeId: own.scheme, name: "Residual", position: 1, days: ["monday", "thursday"], stopSource: "rule" },
    { id: own.glassGroup, ...scoped, routeSchemeId: own.scheme, name: "Glass", position: 2, days: ["thursday"], stopSource: "manual" },
    { id: own.draftGroup, ...scoped, routeSchemeId: own.draftScheme, name: "Paper", position: 1, days: ["tuesday"], stopSource: "rule" },
  ])
  await tx.insert(collectionGroupFraction).values([
    { ...scoped, collectionGroupId: own.residualGroup, wasteFractionId: own.wasteFraction },
    { ...scoped, collectionGroupId: own.draftGroup, wasteFractionId: own.wasteFraction },
  ])
  await tx.insert(collectionGroupContainer).values({ ...scoped, collectionGroupId: own.glassGroup, containerId: own.glassBin, position: 1 })
}

describe("generation against a migrated database", { skip }, () => {
  const name = `waste_worker_generation_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  let admin: Database
  let ownerPool: Database
  let api: Database
  let worker: Database
  let running: Boss | undefined
  const lines: string[] = []
  const sent: Array<{ queue: string; data: object | null; singletonKey: string | undefined; inTransaction: boolean }> = []

  /** The context a job runs with: the API role's pool for the writes, the worker role's for the sweep, a pinned clock, a recording log, and a `send` that records and, where pg-boss runs, sends. */
  const context = (): JobContext => ({
    api,
    worker,
    now: () => NOW,
    log: (message) => void lines.push(message),
    complete: settlesNothing,
    routing: fakeRouting(),
    send: async (queue, data, options) => {
      sent.push({ queue, data, singletonKey: options?.singletonKey, inTransaction: options?.db !== undefined })
      if (running === undefined) return `sent-${sent.length}`
      return running.boss.send(queue, data, options)
    },
  })

  /** A run row of company a's scheme over the window, written as the owner, answering its id. */
  const runFor = async (schemeId: string, companyId: string, projectId: string, window: { from: string; to: string }): Promise<string> => {
    const [row] = await ownerPool.db.insert(generationRun).values({ companyId, projectId, routeSchemeId: schemeId, trigger: "on-demand", windowFrom: window.from, windowTo: window.to }).returning({ id: generationRun.id })
    return row.id
  }
  const generateA = async (window = WEEK) => {
    const runId = await runFor(a.scheme, a.company, a.project, window)
    const outcome = await runGeneration({ generationRunId: runId, companyId: a.company }, null, context())
    const [run] = await ownerPool.db.select().from(generationRun).where(eq(generationRun.id, runId))
    return { runId, outcome, run }
  }
  const routesOfA = () => ownerPool.db.select().from(route).where(eq(route.routeSchemeId, a.scheme)).orderBy(asc(route.serviceDate), asc(route.number))
  const pickupsOf = (routeId: string) => ownerPool.db.select().from(pickup).where(eq(pickup.routeId, routeId)).orderBy(asc(pickup.position))

  before(async () => {
    admin = createDb(owner.url, { max: 1 })
    await admin.sql.unsafe(`create database "${name}"`)
    const url = withDatabaseName(owner.url, name)
    await migrateDatabase(url)
    ownerPool = createDb(url, { max: 3 })
    api = createDb(withDatabaseName(apiRole.url, name), { max: 3 })
    worker = createDb(withDatabaseName(workerRole.url, name), { max: 2 })
    await ownerPool.db.transaction(async (tx) => {
      await seed(tx, "a")
      await seed(tx, "b")
    })
  })
  after(async () => {
    await running?.stop(2_000)
    await api?.close()
    await worker?.close()
    await ownerPool?.close()
    try {
      await admin.sql.unsafe(`drop database if exists "${name}" with (force)`)
    } finally {
      await admin.close()
    }
  })

  test("the API role's pool is wms_api and the worker role's wms_worker: the fence is real here", async () => {
    const [{ who: apiWho }] = await api.sql<{ who: string }[]>`select current_user as who`
    const [{ who: workerWho }] = await worker.sql<{ who: string }[]>`select current_user as who`
    assert.deepEqual([apiWho, workerWho], ["wms_api", "wms_worker"])
  })

  test("a run writes the week's routes and pickups: the rule group's stops are the contained, located, placed containers by label with the day's place and fraction, the manual group's its pick, numbers from the counter, the holiday shifted", async () => {
    const { outcome, run } = await generateA()
    assert.equal(outcome.kind, "succeeded")
    assert.deepEqual([run.status, run.routesCreated, run.routesRefreshed, run.routesCancelled, run.pickupsWritten, run.holidaysSkipped, run.unlocated], ["succeeded", 3, 0, 0, 6, 0, 1])
    assert.deepEqual(run.warnings, [])
    assert.ok(run.startedAt instanceof Date && run.finishedAt instanceof Date)

    const routes = await routesOfA()
    assert.deepEqual(
      routes.map((row) => [row.collectionGroupId, row.serviceDate, row.operatingDate, row.status, row.number, row.note, row.generationRunId, row.plannedStartTime]),
      [
        [a.residualGroup, "2026-10-05", "2026-10-05", "planned", 1000, null, run.id, "06:30:00"],
        // Thursday the 8th is Test Day: shifted to Friday the 9th, the identity kept.
        [a.residualGroup, "2026-10-08", "2026-10-09", "planned", 1001, "Shifted from Thu 8 Oct · Test Day", run.id, "06:30:00"],
        [a.glassGroup, "2026-10-08", "2026-10-09", "planned", 1002, "Shifted from Thu 8 Oct · Test Day", run.id, "06:30:00"],
      ],
    )
    const [{ next }] = await ownerPool.db.select({ next: company.nextRouteNumber }).from(company).where(eq(company.id, a.company))
    assert.equal(next, 1003, "the counter moved by the block")

    // Monday: bins 1, 2 and 3 are inside the square and placed; bin 4 is in Amager; bin 6's place has no location, so it is counted and gets no stop.
    const monday = await pickupsOf(routes[0].id)
    assert.deepEqual(
      monday.map((row) => [row.position, row.containerId, row.propertyId, row.wasteFractionId, row.status]),
      [
        [1, a.bin1, a.parkvej, a.wasteFraction, "planned"],
        [2, a.bin2, a.parkvej, a.wasteFraction, "planned"],
        [3, a.bin3, a.havnegade, a.wasteFraction, "planned"],
      ],
    )
    // Thursday: bin 2's placement ended on the 8th, so it drops out of the later date.
    const thursday = await pickupsOf(routes[1].id)
    assert.deepEqual(thursday.map((row) => [row.position, row.containerId]), [[1, a.bin1], [2, a.bin3]])
    const glass = await pickupsOf(routes[2].id)
    assert.deepEqual(glass.map((row) => [row.position, row.containerId, row.wasteFractionId]), [[1, a.glassBin, a.glassFraction]])

    // The drift stamp, as of the window's first day: the rule's three matches under its signature.
    const stamps = await ownerPool.db.select().from(generationMatch).where(eq(generationMatch.collectionGroupId, a.residualGroup))
    assert.equal(stamps.length, 1)
    assert.deepEqual([...stamps[0].containerIds].sort(), [a.bin1, a.bin2, a.bin3].sort())
    assert.equal(stamps[0].ruleSignature, `${a.planningArea}|${a.wasteFraction}||`)
    assert.equal(stamps[0].generationRunId, run.id)
    assert.equal((await ownerPool.db.select().from(generationMatch).where(eq(generationMatch.collectionGroupId, a.glassGroup))).length, 0, "a manual group is never stamped")
  })

  test("a second run over the same window writes no route, no pickup and no stamp, and moves no updated_at", async () => {
    const before = await routesOfA()
    const beforePickups = await ownerPool.db.select().from(pickup).where(eq(pickup.companyId, a.company)).orderBy(asc(pickup.id))
    const { run } = await generateA()
    assert.deepEqual([run.status, run.routesCreated, run.routesRefreshed, run.routesCancelled, run.pickupsWritten], ["succeeded", 0, 0, 0, 0])
    const after = await routesOfA()
    assert.deepEqual(after, before, "the same rows, updated_at included")
    assert.deepEqual(await ownerPool.db.select().from(pickup).where(eq(pickup.companyId, a.company)).orderBy(asc(pickup.id)), beforePickups)
    assert.equal((await ownerPool.db.select().from(generationMatch).where(eq(generationMatch.collectionGroupId, a.residualGroup))).length, 1, "the same set writes no stamp")
    assert.equal(after[0].generationRunId, before[0].generationRunId, "a route the run left alone keeps the run that wrote it")
  })

  test("a moved boundary changes the stops of later dates only: the western half leaves Havnegade out from the Thursday on, the Monday's pickups stand, and the stamp moves", async () => {
    // The square ends on the 8th and the western half begins there.
    await ownerPool.db.update(planningAreaBoundary).set({ validTo: "2026-10-08" }).where(eq(planningAreaBoundary.id, a.boundary))
    await ownerPool.db.insert(planningAreaBoundary).values({ companyId: a.company, projectId: a.project, validFrom: "2026-10-08", planningAreaId: a.planningArea, boundary: WEST_HALF })
    const { run } = await generateA()
    assert.deepEqual([run.routesCreated, run.routesRefreshed, run.routesCancelled], [0, 1, 0])
    const routes = await routesOfA()
    assert.deepEqual((await pickupsOf(routes[0].id)).map((row) => [row.containerId, row.status]), [[a.bin1, "planned"], [a.bin2, "planned"], [a.bin3, "planned"]], "the Monday, before the move, stands")
    assert.deepEqual((await pickupsOf(routes[1].id)).map((row) => [row.containerId, row.status, row.reason, row.note]), [
      [a.bin1, "planned", null, null],
      [a.bin3, "skipped", "regeneration", REMOVED_FROM_DAY_PLAN],
    ], "Havnegade left the Thursday's plan: skipped, never deleted")
    assert.equal(routes[1].generationRunId, run.id)
    assert.equal((await ownerPool.db.select().from(generationMatch).where(eq(generationMatch.collectionGroupId, a.residualGroup))).length, 1, "the stamp is as of the window's first day, the 5th, where the square still holds")

    // A window starting on the Thursday stamps the western half's set: the set moved, so a second row.
    const later = await generateA({ from: "2026-10-08", to: "2026-10-11" })
    assert.equal(later.run.status, "succeeded")
    const stamps = await ownerPool.db.select().from(generationMatch).where(eq(generationMatch.collectionGroupId, a.residualGroup)).orderBy(asc(generationMatch.id))
    assert.equal(stamps.length, 2)
    assert.deepEqual([...stamps[1].containerIds], [a.bin1])
  })

  test("a shrunk scheme cancels the planned routes it leaves with the sentence and skips their pickups; a ready route stands; the identity planned again comes back", async () => {
    const routes = await routesOfA()
    const thursdayResidual = routes[1]
    const thursdayGlass = routes[2]
    await ownerPool.db.update(route).set({ status: "ready", dispatchedAt: NOW }).where(eq(route.id, thursdayGlass.id))
    // Mondays only from here: the Thursday is no longer served.
    await ownerPool.db.update(routeScheme).set({ serviceDays: ["monday"] }).where(eq(routeScheme.id, a.scheme))
    await ownerPool.db.update(collectionGroup).set({ days: ["monday"] }).where(eq(collectionGroup.id, a.residualGroup))
    await ownerPool.db.update(collectionGroup).set({ days: [] }).where(eq(collectionGroup.id, a.glassGroup))
    const shrunk = await generateA()
    assert.deepEqual([shrunk.run.routesCreated, shrunk.run.routesRefreshed, shrunk.run.routesCancelled], [0, 0, 1])
    const [cancelled] = await ownerPool.db.select().from(route).where(eq(route.id, thursdayResidual.id))
    assert.deepEqual([cancelled.status, cancelled.cancelledByGeneration, cancelled.cancelReasonCode, cancelled.note, cancelled.cancelledAt?.toISOString()], ["cancelled", true, "regeneration", NO_LONGER_SERVES_DATE, NOW.toISOString()], "the run's own code beside its sentence (O5 of #290)")
    assert.deepEqual((await pickupsOf(thursdayResidual.id)).map((row) => [row.containerId, row.status, row.reason, row.note]), [
      [a.bin1, "skipped", "regeneration", NO_LONGER_SERVES_DATE],
      [a.bin3, "skipped", "regeneration", REMOVED_FROM_DAY_PLAN],
    ])
    const [ready] = await ownerPool.db.select().from(route).where(eq(route.id, thursdayGlass.id))
    assert.equal(ready.status, "ready", "a dispatched route is not the run's to touch")

    // The Thursday returns: the cancelled route is resurrected, its open pickups brought back, the ready one still stands.
    await ownerPool.db.update(routeScheme).set({ serviceDays: ["monday", "thursday"] }).where(eq(routeScheme.id, a.scheme))
    await ownerPool.db.update(collectionGroup).set({ days: ["monday", "thursday"] }).where(eq(collectionGroup.id, a.residualGroup))
    const back = await generateA()
    assert.deepEqual([back.run.routesCreated, back.run.routesRefreshed, back.run.routesCancelled], [0, 1, 0])
    const [resurrected] = await ownerPool.db.select().from(route).where(eq(route.id, thursdayResidual.id))
    assert.deepEqual([resurrected.status, resurrected.cancelledByGeneration, resurrected.cancelReasonCode, resurrected.cancelledAt, resurrected.number, resurrected.generationRunId], ["planned", false, null, null, 1001, back.runId], "the same route, the same number, its code cleared")
    assert.deepEqual((await pickupsOf(thursdayResidual.id)).map((row) => [row.containerId, row.status, row.reason]), [
      [a.bin1, "planned", null],
      [a.bin3, "skipped", "regeneration"],
    ], "bin 3 is still outside the western half")
  })

  test("a held route (#209) keeps its day, its start and its Planned Assignment, its ends among them, while its pickups and its note are the run's; the hold alone writes nothing and asks no Plan; a cancel still cancels it, clearing the hold, and the route brought back is the scheme's", async () => {
    const scoped = { companyId: a.company, projectId: a.project }
    await ownerPool.db.insert(vehicleType).values({ id: a.vehicleType, companyId: a.company, key: "rear-loader", name: "Rear loader" })
    await ownerPool.db.insert(depot).values({ id: a.depot, ...scoped, code: "DEP-NORD", name: "Nordhavn depot", address: "Sundkrogsgade 21", location: PARKVEJ, ownership: "company", status: "active" })
    await ownerPool.db.insert(unloadingStation).values({ id: a.station, companyId: a.company, code: "ARC-AMAGER", name: "ARC Amager Bakke", address: "Vindmøllevej 6", location: AMAGER, ownership: "external", status: "active" })
    await ownerPool.db.insert(vehicle).values({ id: a.vehicle, ...scoped, registration: "CN 42 018", callsign: "WH-24", kind: "powered-vehicle", vehicleTypeId: a.vehicleType, ownership: "company", status: "active", requiredLicenceClass: "c" })
    await ownerPool.db.insert(driver).values({ id: a.driver, ...scoped, name: "Mads Jensen", employment: "employee", licenceClass: "ce", licenceExpiry: "2030-12-31", status: "active" })
    await ownerPool.db.insert(serviceProvider).values({ id: a.provider, companyId: a.company, legalName: "NordRen ApS", registrationNumber: "40000001", country: "DK", contactName: "Lars Mikkelsen", contactEmail: "lars@nordren.example" })
    /** What a hold covers, as a route row carries it. */
    const covered = (row: typeof route.$inferSelect) => ({
      operatingDate: row.operatingDate,
      plannedStartTime: row.plannedStartTime,
      plannedVehicleId: row.plannedVehicleId,
      plannedDriverId: row.plannedDriverId,
      plannedServiceProviderId: row.plannedServiceProviderId,
      depotId: row.depotId,
      unloadingStationId: row.unloadingStationId,
      heldAt: row.heldAt,
    })
    const rowOf = async (id: string) => (await ownerPool.db.select().from(route).where(eq(route.id, id)))[0]

    // The office moved Monday's route to the Tuesday, earlier, with its own crew and ends: `reschedule` and `assign`, as apps/api writes them.
    const [monday] = await routesOfA()
    assert.deepEqual([monday.serviceDate, monday.status, monday.collectionGroupId], ["2026-10-05", "planned", a.residualGroup])
    const office = { operatingDate: "2026-10-06", plannedStartTime: "05:15:00", plannedVehicleId: a.vehicle, plannedDriverId: a.driver, plannedServiceProviderId: a.provider, depotId: a.depot, unloadingStationId: a.station, heldAt: NOW }
    await ownerPool.db.update(route).set(office).where(eq(route.id, monday.id))
    const held = await rowOf(monday.id)

    // The hold alone: nothing differs but what the office moved, so the run writes nothing and reshapes nothing.
    const quiet = await generateA()
    assert.deepEqual([quiet.run.status, quiet.run.routesRefreshed, quiet.run.routesCancelled], ["succeeded", 0, 0])
    assert.deepEqual(await rowOf(monday.id), held, "the same row, updated_at included")
    assert.ok(quiet.outcome.kind === "succeeded" && !quiet.outcome.horizon.asked.includes(monday.id), "no Plan asked for")

    // A stop out of order and a stale note: the run's to bring back, and what the office held stands.
    const [first] = await pickupsOf(monday.id)
    await ownerPool.db.update(pickup).set({ position: 7 }).where(eq(pickup.id, first.id))
    await ownerPool.db.update(route).set({ note: "Moved by hand" }).where(eq(route.id, monday.id))
    const refreshed = await generateA()
    assert.deepEqual([refreshed.run.routesRefreshed, refreshed.run.routesCancelled], [1, 0])
    const kept = await rowOf(monday.id)
    assert.deepEqual(covered(kept), office, "the day, the start and the Planned Assignment the office gave it")
    assert.deepEqual([kept.note, kept.generationRunId, kept.status], [null, refreshed.runId, "planned"], "the note is the run's")
    assert.deepEqual((await pickupsOf(monday.id)).map((row) => [row.position, row.containerId]), [[1, a.bin1], [2, a.bin2], [3, a.bin3]], "the stops are the run's")
    assert.ok(refreshed.outcome.kind === "succeeded" && refreshed.outcome.horizon.asked.includes(monday.id), "a stop moved reshapes it, asked a Plan on the day the office holds it to")

    // The scheme stops serving Mondays: the held route is cancelled like any other, and the hold goes with `planned`.
    await ownerPool.db.update(routeScheme).set({ serviceDays: ["thursday"] }).where(eq(routeScheme.id, a.scheme))
    await ownerPool.db.update(collectionGroup).set({ days: ["thursday"] }).where(eq(collectionGroup.id, a.residualGroup))
    const shrunk = await generateA()
    assert.equal(shrunk.run.routesCancelled, 1)
    const cancelled = await rowOf(monday.id)
    assert.deepEqual([cancelled.status, cancelled.cancelledByGeneration, cancelled.note, cancelled.heldAt], ["cancelled", true, NO_LONGER_SERVES_DATE, null])

    // Mondays again: the route brought back is the scheme's, not what the office had held.
    await ownerPool.db.update(routeScheme).set({ serviceDays: ["monday", "thursday"] }).where(eq(routeScheme.id, a.scheme))
    await ownerPool.db.update(collectionGroup).set({ days: ["monday", "thursday"] }).where(eq(collectionGroup.id, a.residualGroup))
    const back = await generateA()
    assert.deepEqual([back.run.routesRefreshed, back.run.routesCancelled], [1, 0])
    const resurrected = await rowOf(monday.id)
    assert.equal(resurrected.status, "planned")
    assert.deepEqual(covered(resurrected), { operatingDate: "2026-10-05", plannedStartTime: "06:30:00", plannedVehicleId: null, plannedDriverId: null, plannedServiceProviderId: null, depotId: null, unloadingStationId: null, heldAt: null })
  })

  test("under skip, a route the office held off its holiday is kept on its day, its note saying so; without the hold it goes with the holiday (#226)", async () => {
    const rowOf = async (id: string) => (await ownerPool.db.select().from(route).where(eq(route.id, id)))[0]
    const thursday = (await routesOfA()).find((row) => row.serviceDate === "2026-10-08")
    assert.ok(thursday, "the holiday Thursday's route, shifted by the scheme's policy")
    await ownerPool.db.update(routeScheme).set({ holidayPolicy: "skip" }).where(eq(routeScheme.id, a.scheme))
    try {
      // The office moved Thursday's collection to the Wednesday before, by hand.
      await ownerPool.db.update(route).set({ operatingDate: "2026-10-07", heldAt: NOW }).where(eq(route.id, thursday.id))
      const kept = await generateA()
      assert.equal(kept.run.routesCancelled, 0)
      const row = await rowOf(thursday.id)
      assert.deepEqual([row.status, row.operatingDate, row.note, row.heldAt !== null], ["planned", "2026-10-07", "Kept on Wed 7 Oct by the office, off Test Day", true])

      // Not held, the same route goes with the holiday the policy skips.
      await ownerPool.db.update(route).set({ heldAt: null }).where(eq(route.id, thursday.id))
      const skipped = await generateA()
      assert.equal(skipped.run.routesCancelled, 1)
      const gone = await rowOf(thursday.id)
      assert.deepEqual([gone.status, gone.note], ["cancelled", "Skipped · Test Day"])
    } finally {
      // The scheme shifts holidays again: the route comes back, the scheme's, for the tests after.
      await ownerPool.db.update(routeScheme).set({ holidayPolicy: "shift-next" }).where(eq(routeScheme.id, a.scheme))
      await generateA()
    }
  })

  test("a group's driver absent or its vehicle out of use on a route's day (O6 of #290): the run writes the route without them and warns; a held route keeps the office's crew and only warns; the period gone, the next run writes the group's crew back", async () => {
    const scoped = { companyId: a.company, projectId: a.project }
    const rowOf = async (id: string) => (await ownerPool.db.select().from(route).where(eq(route.id, id)))[0]
    const crewOf = (row: typeof route.$inferSelect) => [row.plannedVehicleId, row.plannedDriverId]
    await ownerPool.db.insert(vehicleType).values({ id: a.vehicleType, companyId: a.company, key: "rear-loader", name: "Rear loader" }).onConflictDoNothing()
    await ownerPool.db.insert(vehicle).values({ id: a.crewVehicle, ...scoped, registration: "CK 74 305", callsign: "NR-12", kind: "powered-vehicle", vehicleTypeId: a.vehicleType, ownership: "company", status: "active", requiredLicenceClass: "c" })
    await ownerPool.db.insert(vehicle).values({ id: a.crewTrailer, ...scoped, registration: "TR 12 012", kind: "trailer", vehicleTypeId: a.vehicleType, ownership: "company", status: "active", requiredLicenceClass: "b" })
    await ownerPool.db.insert(driver).values({ id: a.crewDriver, ...scoped, name: "Freja Nielsen", employment: "employee", licenceClass: "ce", licenceExpiry: "2030-12-31", status: "active" })
    await ownerPool.db.update(collectionGroup).set({ vehicleId: a.crewVehicle, driverId: a.crewDriver }).where(eq(collectionGroup.id, a.residualGroup))
    try {
      // Nobody away: both of the residual group's routes carry its crew, and the run warns of nothing.
      const crewed = await generateA()
      assert.deepEqual(crewed.run.warnings, [])
      const residual = (await routesOfA()).filter((row) => row.collectionGroupId === a.residualGroup)
      const [monday, thursday] = residual
      assert.deepEqual(
        residual.map((row) => [row.serviceDate, row.operatingDate, row.status, row.heldAt]),
        [
          ["2026-10-05", "2026-10-05", "planned", null],
          ["2026-10-08", "2026-10-09", "planned", null],
        ],
      )
      assert.deepEqual(residual.map(crewOf), [[a.crewVehicle, a.crewDriver], [a.crewVehicle, a.crewDriver]])

      // Freja is on holiday on the Monday, and NR-12 goes into the workshop from the Friday the holiday moved Thursday's collection to.
      await ownerPool.db.insert(driverAbsence).values({ id: a.absence, ...scoped, driverId: a.crewDriver, validFrom: "2026-10-05", validTo: "2026-10-06", reason: "holiday" })
      await ownerPool.db.insert(vehicleUnavailability).values({ id: a.unavailability, ...scoped, vehicleId: a.crewVehicle, validFrom: "2026-10-09", reason: "maintenance" })
      const away = await generateA()
      assert.deepEqual(away.run.warnings, [
        `Freja Nielsen is absent on Mon 5 Oct (holiday): ${routeLabel(monday.number)} is written without a planned driver`,
        `NR-12 is unavailable on Fri 9 Oct (maintenance): ${routeLabel(thursday.number)} is written without a planned vehicle`,
      ])
      assert.deepEqual(crewOf(await rowOf(monday.id)), [a.crewVehicle, null], "the Monday's route without Freja, still with NR-12")
      assert.deepEqual(crewOf(await rowOf(thursday.id)), [null, a.crewDriver], "the Friday's without NR-12, still with Freja")
      assert.deepEqual([(await rowOf(monday.id)).status, (await rowOf(thursday.id)).status], ["planned", "planned"])

      // The office holds the Friday's route on NR-12 with the trailer, as an assign made before the workshop was booked: the run keeps both and says so.
      await ownerPool.db.insert(vehicleUnavailability).values({ id: a.trailerRepair, ...scoped, vehicleId: a.crewTrailer, validFrom: "2026-10-09", validTo: "2026-10-10", reason: "repair" })
      await ownerPool.db.update(route).set({ plannedVehicleId: a.crewVehicle, plannedTrailerId: a.crewTrailer, heldAt: NOW }).where(eq(route.id, thursday.id))
      const held = await generateA()
      assert.deepEqual(held.run.warnings, [
        `Freja Nielsen is absent on Mon 5 Oct (holiday): ${routeLabel(monday.number)} is written without a planned driver`,
        `NR-12 is unavailable on Fri 9 Oct (maintenance), and ${routeLabel(thursday.number)}, which the office holds, still names it`,
        `TR 12 012 is unavailable on Fri 9 Oct (repair), and ${routeLabel(thursday.number)}, which the office holds, still names it`,
      ])
      assert.deepEqual(crewOf(await rowOf(thursday.id)), [a.crewVehicle, a.crewDriver], "the office's word stands")
      assert.equal((await rowOf(thursday.id)).plannedTrailerId, a.crewTrailer)

      // The periods gone and the hold released: the next run writes the group's crew back on both.
      await ownerPool.db.delete(driverAbsence).where(eq(driverAbsence.id, a.absence))
      await ownerPool.db.delete(vehicleUnavailability).where(eq(vehicleUnavailability.id, a.unavailability))
      await ownerPool.db.delete(vehicleUnavailability).where(eq(vehicleUnavailability.id, a.trailerRepair))
      await ownerPool.db.update(route).set({ heldAt: null, plannedTrailerId: null }).where(eq(route.id, thursday.id))
      const back = await generateA()
      assert.deepEqual(back.run.warnings, [])
      assert.deepEqual([crewOf(await rowOf(monday.id)), crewOf(await rowOf(thursday.id))], [[a.crewVehicle, a.crewDriver], [a.crewVehicle, a.crewDriver]])
    } finally {
      // The group crewless again, for the tests after: its routes go back to the scheme's, with no crew.
      await ownerPool.db.delete(driverAbsence).where(eq(driverAbsence.id, a.absence))
      await ownerPool.db.delete(vehicleUnavailability).where(eq(vehicleUnavailability.id, a.unavailability))
      await ownerPool.db.delete(vehicleUnavailability).where(eq(vehicleUnavailability.id, a.trailerRepair))
      await ownerPool.db.update(collectionGroup).set({ vehicleId: null, driverId: null }).where(eq(collectionGroup.id, a.residualGroup))
      await ownerPool.db.update(route).set({ heldAt: null, plannedTrailerId: null }).where(eq(route.routeSchemeId, a.scheme))
      await generateA()
    }
  })

  test("the office's stops and route are the office's (#111): a refresh never skips or moves an office stop nor plans its container twice; a route carrying an open one is trimmed, never cancelled; an ad-hoc route is never read", async () => {
    const scoped = { companyId: a.company, projectId: a.project }
    const rowOf = async (id: string) => (await ownerPool.db.select().from(route).where(eq(route.id, id)))[0]
    const officeOf = async (routeId: string) => ownerPool.db.select().from(pickup).where(and(eq(pickup.routeId, routeId), eq(pickup.origin, "office"))).orderBy(asc(pickup.id))
    const monday = (await routesOfA()).find((row) => row.serviceDate === "2026-10-05")
    assert.ok(monday, "the Monday's route, planned and the scheme's")
    // The office's ad-hoc route on the same day, in the same project, with a stop of its own: no run may read it.
    const [adHoc] = await ownerPool.db.insert(route).values({ ...scoped, serviceDate: "2026-10-05", operatingDate: "2026-10-05", number: 9000, note: "Re-collections" }).returning()
    await ownerPool.db.insert(pickup).values({ ...scoped, routeId: adHoc.id, containerId: null, position: 1, origin: "office", propertyId: a.parkvej, wasteFractionId: a.wasteFraction })
    const [adHocStop] = await officeOf(adHoc.id)
    // On the Monday's route: bin 4 at Amager, which the rule never plans, an address-only stop at Havnegade, and bin 3 taken as the office's at the end — a container the plan holds too.
    await ownerPool.db.insert(pickup).values([
      { ...scoped, routeId: monday.id, containerId: a.bin4, position: 4, origin: "office", propertyId: a.amager, wasteFractionId: a.wasteFraction },
      { ...scoped, routeId: monday.id, containerId: null, position: 5, origin: "office", propertyId: a.havnegade, wasteFractionId: a.glassFraction },
    ])
    await ownerPool.db.update(pickup).set({ origin: "office", position: 9 }).where(and(eq(pickup.routeId, monday.id), eq(pickup.containerId, a.bin3)))
    const office = await officeOf(monday.id)
    assert.equal(office.length, 3)

    // A refresh over the week: the office's three stand as they are — never skipped, never moved — and bin 3 is not planned a second time.
    const refresh = await generateA()
    assert.equal(refresh.run.status, "succeeded")
    assert.deepEqual(await officeOf(monday.id), office, "the same rows, updated_at included")
    assert.deepEqual((await pickupsOf(monday.id)).filter((row) => row.origin === "generation").map((row) => [row.position, row.containerId, row.status]), [[1, a.bin1, "planned"], [2, a.bin2, "planned"]])

    // The scheme stops serving Mondays: the route carries open office stops, so it is trimmed — the run's own stops skipped with the sentence, the route still planned for the office's.
    await ownerPool.db.update(routeScheme).set({ serviceDays: ["thursday"] }).where(eq(routeScheme.id, a.scheme))
    await ownerPool.db.update(collectionGroup).set({ days: ["thursday"] }).where(eq(collectionGroup.id, a.residualGroup))
    try {
      const trimmed = await generateA()
      assert.deepEqual([trimmed.run.routesCancelled, trimmed.run.routesRefreshed], [0, 1])
      const kept = await rowOf(monday.id)
      assert.deepEqual([kept.status, kept.cancelledByGeneration, kept.cancelledAt, kept.note, kept.generationRunId], ["planned", false, null, NO_LONGER_SERVES_DATE, trimmed.runId])
      assert.deepEqual(
        (await pickupsOf(monday.id)).filter((row) => row.origin === "generation").map((row) => [row.containerId, row.status, row.reason, row.note]),
        [
          [a.bin1, "skipped", "regeneration", NO_LONGER_SERVES_DATE],
          [a.bin2, "skipped", "regeneration", NO_LONGER_SERVES_DATE],
        ],
      )
      assert.deepEqual(await officeOf(monday.id), office, "the office's stops stand, open")
      assert.ok(trimmed.outcome.kind === "succeeded" && trimmed.outcome.horizon.asked.includes(monday.id), "its stops moved: a Plan is asked for")
      // Trimmed is what the next run would make it: nothing written.
      const again = await generateA()
      assert.deepEqual([again.run.routesRefreshed, again.run.routesCancelled], [0, 0])
      assert.deepEqual(await rowOf(monday.id), kept)
    } finally {
      await ownerPool.db.update(routeScheme).set({ serviceDays: ["monday", "thursday"] }).where(eq(routeScheme.id, a.scheme))
      await ownerPool.db.update(collectionGroup).set({ days: ["monday", "thursday"] }).where(eq(collectionGroup.id, a.residualGroup))
    }
    // Mondays again: the run's stops come back, the office's still stand.
    const back = await generateA()
    assert.equal(back.run.status, "succeeded")
    assert.deepEqual([(await rowOf(monday.id)).note, (await rowOf(monday.id)).status], [null, "planned"])
    assert.deepEqual((await pickupsOf(monday.id)).filter((row) => row.origin === "generation").map((row) => [row.containerId, row.status]), [[a.bin1, "planned"], [a.bin2, "planned"]])
    assert.deepEqual(await officeOf(monday.id), office)

    // Through every run above, the ad-hoc route and its stop were never read: not refreshed, not cancelled, not stamped.
    assert.deepEqual(await rowOf(adHoc.id), adHoc)
    assert.deepEqual(await officeOf(adHoc.id), [adHocStop])
  })

  test("a draft scheme generates nothing and says so on the run; a run already succeeded is not run again; a validated scheme with a rule group and no planning area warns", async () => {
    const draftRun = await runFor(a.draftScheme, a.company, a.project, WEEK)
    const draft = await runGeneration({ generationRunId: draftRun, companyId: a.company }, "job-1", context())
    assert.equal(draft.kind, "succeeded")
    const [draftRow] = await ownerPool.db.select().from(generationRun).where(eq(generationRun.id, draftRun))
    assert.deepEqual([draftRow.status, draftRow.routesCreated, draftRow.warnings, draftRow.jobId], ["succeeded", 0, [DRAFT_GENERATES_NOTHING], "job-1"])
    assert.equal((await ownerPool.db.select().from(route).where(eq(route.routeSchemeId, a.draftScheme))).length, 0)

    const again = await runGeneration({ generationRunId: draftRun, companyId: a.company }, "job-2", context())
    assert.deepEqual(again, { kind: "already-done", status: "succeeded" })
    const [unchanged] = await ownerPool.db.select().from(generationRun).where(eq(generationRun.id, draftRun))
    assert.equal(unchanged.jobId, "job-1", "a replay writes nothing")

    // Validated with a rule group and no planning area: a warning on the run, never a throw, and no stops.
    await ownerPool.db.update(routeScheme).set({ status: "validated", planningAreaId: null }).where(eq(routeScheme.id, a.draftScheme))
    const areaLess = await runFor(a.draftScheme, a.company, a.project, WEEK)
    const warned = await runGeneration({ generationRunId: areaLess, companyId: a.company }, null, context())
    assert.equal(warned.kind, "succeeded")
    const [warnedRow] = await ownerPool.db.select().from(generationRun).where(eq(generationRun.id, areaLess))
    assert.deepEqual([warnedRow.routesCreated, warnedRow.pickupsWritten, warnedRow.warnings], [1, 0, [NO_PLANNING_AREA]], "the Tuesday's route, with no stops")
  })

  test("a failing run leaves the row failed with the loggable projection, nothing written, and the error rethrown for pg-boss to retry", async () => {
    const failing = await runFor(a.scheme, a.company, a.project, WEEK)
    // A Friday joins the scheme, so the run has a route to create and pickups to insert, and the insert is made to fail.
    await ownerPool.db.update(routeScheme).set({ serviceDays: ["monday", "thursday", "friday"] }).where(eq(routeScheme.id, a.scheme))
    await ownerPool.db.update(collectionGroup).set({ days: ["monday", "thursday", "friday"] }).where(eq(collectionGroup.id, a.residualGroup))
    // `not valid`: the rows already there stand, and the run's inserts are what the check refuses.
    await ownerPool.db.execute(sql`alter table wms.pickup add constraint fail_on_purpose check (position < 0) not valid`)
    try {
      await assert.rejects(runGeneration({ generationRunId: failing, companyId: a.company }, "job-3", context()), (error: unknown) => {
        // Drizzle wraps the driver's error; the constraint's name is on the cause.
        assert.equal((error as { cause?: { constraint_name?: string } }).cause?.constraint_name, "fail_on_purpose", String(error))
        return true
      })
    } finally {
      await ownerPool.db.execute(sql`alter table wms.pickup drop constraint fail_on_purpose`)
      await ownerPool.db.update(routeScheme).set({ serviceDays: ["monday", "thursday"] }).where(eq(routeScheme.id, a.scheme))
      await ownerPool.db.update(collectionGroup).set({ days: ["monday", "thursday"] }).where(eq(collectionGroup.id, a.residualGroup))
    }
    const [failedRow] = await ownerPool.db.select().from(generationRun).where(eq(generationRun.id, failing))
    assert.deepEqual([failedRow.status, failedRow.jobId, failedRow.routesCreated], ["failed", "job-3", 0])
    const projection = JSON.parse(failedRow.error ?? "{}") as { name?: string; message?: string; stack?: string; cause?: { code?: string; constraint_name?: string; message?: string } }
    assert.deepEqual([projection.message, projection.cause?.code, projection.cause?.constraint_name], ["Failed query", "23514", "fail_on_purpose"])
    assert.match(projection.cause?.message ?? "", /violates check constraint "fail_on_purpose"/)
    assert.doesNotMatch(failedRow.error ?? "", /insert into|params:|018f7c36/, "never a statement or its parameters, in the message or the stack")
    assert.equal((await routesOfA()).filter((row) => row.serviceDate === "2026-10-09").length, 0, "nothing of the failed run landed")
    assert.ok(lines.some((line) => line.includes(`run ${failing} failed`)))
  })

  test("under withCompany as wms_api, each company sees its runs and stamps and nothing of another's", async () => {
    const seen = await withCompany(api.db, b.company, async (tx) => ({
      runs: (await tx.select({ id: generationRun.id }).from(generationRun)).length,
      stamps: (await tx.select({ id: generationMatch.id }).from(generationMatch)).length,
      routes: (await tx.select({ id: route.id }).from(route)).length,
    }))
    assert.deepEqual(seen, { runs: 0, stamps: 0, routes: 0 }, "company b has generated nothing yet")
    const own = await withCompany(api.db, a.company, async (tx) => (await tx.select({ id: generationRun.id }).from(generationRun)).length)
    assert.ok(own >= 6, `company a's runs: ${own}`)
  })

  test("the sweep, as wms_worker, finds exactly the validated plan-ahead schemes across both companies, today in each project's timezone", async () => {
    const found = await eligibleSchemes(worker, NOW)
    assert.deepEqual(
      found.map((scheme) => [scheme.companyId, scheme.routeSchemeId, scheme.today]),
      [
        [a.company, a.scheme, "2026-10-03"],
        [a.company, a.draftScheme, "2026-10-03"],
        [b.company, b.scheme, "2026-10-03"],
      ],
      "a's draft was validated by an earlier test; b's draft stays out; 18:00Z on the 3rd is the 3rd in Copenhagen",
    )
    // A scheme whose period ends before the window's first day, or begins after its last, is out; plan_ahead off is out.
    await ownerPool.db.update(routeScheme).set({ planAhead: false }).where(eq(routeScheme.id, a.draftScheme))
    assert.deepEqual((await eligibleSchemes(worker, NOW)).map((scheme) => scheme.routeSchemeId), [a.scheme, b.scheme])
    await ownerPool.db.update(routeScheme).set({ validTo: "2026-10-04" }).where(eq(routeScheme.id, b.scheme))
    assert.deepEqual((await eligibleSchemes(worker, NOW)).map((scheme) => scheme.routeSchemeId), [a.scheme], "a scheme out of force on the window's first day is not swept")
    await ownerPool.db.update(routeScheme).set({ validTo: null }).where(eq(routeScheme.id, b.scheme))
    // At 23:30Z on the 3rd it is already the 4th in Copenhagen.
    assert.deepEqual((await eligibleSchemes(worker, new Date("2026-10-03T23:30:00Z"))).map((scheme) => scheme.today), ["2026-10-04", "2026-10-04"])
    await assert.rejects(
      worker.db.insert(generationRun).values({ companyId: a.company, projectId: a.project, routeSchemeId: a.scheme, trigger: "cron", windowFrom: WEEK.from, windowTo: WEEK.to }),
      (error: unknown) => {
        // Drizzle wraps the driver's error; the SQLSTATE and the sentence are on the cause.
        const cause = (error as { cause?: { code?: string; message?: string } }).cause
        assert.equal(cause?.code, "42501", String(error))
        assert.match(cause?.message ?? "", /permission denied for table generation_run/)
        return true
      },
      "the worker role writes nothing",
    )
  })

  test("the sweep writes one cron run per eligible scheme as wms_api over tomorrow through the week, and sends each job with the scheme as its key in the run's transaction", async () => {
    sent.length = 0
    const outcome = await planAhead(context(), "sweep-1")
    assert.deepEqual([outcome.eligible, outcome.queued.length, outcome.alreadyQueued, outcome.failed], [2, 2, [], []])
    const runs = await ownerPool.db.select().from(generationRun).where(eq(generationRun.trigger, "cron")).orderBy(asc(generationRun.companyId))
    assert.deepEqual(
      runs.map((run) => [run.companyId, run.routeSchemeId, run.windowFrom, run.windowTo, run.status, run.jobId]),
      [
        [a.company, a.scheme, "2026-10-04", "2026-10-10", "queued", "sent-1"],
        [b.company, b.scheme, "2026-10-04", "2026-10-10", "queued", "sent-2"],
      ],
    )
    assert.deepEqual(sent, [
      { queue: GENERATE_ROUTES_QUEUE, data: { generationRunId: runs[0].id, companyId: a.company }, singletonKey: a.scheme, inTransaction: true },
      { queue: GENERATE_ROUTES_QUEUE, data: { generationRunId: runs[1].id, companyId: b.company }, singletonKey: b.scheme, inTransaction: true },
    ])
    assert.ok(lines.some((line) => line.includes(`${PLAN_AHEAD_QUEUE}: ${NOW.toISOString()} swept 2 eligible schemes: 2 queued, 0 already queued, 0 failed (job sweep-1)`)), lines.at(-1))
    await ownerPool.db.delete(generationRun).where(eq(generationRun.trigger, "cron"))
  })

  test("with pg-boss running: the sweep's job reaches the generate queue and runs there as one transaction with its run; a scheme mid-generation is not queued twice", async () => {
    const boss = createBoss({ url: withDatabaseName(owner.url, name), log: (line) => void lines.push(`pg-boss: ${line}`), cronWorkerIntervalSeconds: 1, monitorIntervalSeconds: 1 })
    // Only the generate queue is registered here, without its worker, so the jobs sit queued and the second sweep meets them.
    running = await startBoss(boss, [{ ...generateRoutes, handler: async () => ({}) , workOptions: { pollingIntervalSeconds: 3600 } }], context())
    const [queue] = await boss.getQueues([GENERATE_ROUTES_QUEUE])
    assert.equal(queue.policy, "exclusive")
    assert.equal(queue.retryLimit, 2)

    const first = await planAhead(context(), "sweep-2")
    assert.deepEqual([first.queued.length, first.alreadyQueued.length, first.failed.length], [2, 0, 0])
    const jobs = await boss.findJobs(GENERATE_ROUTES_QUEUE, { queued: true })
    assert.equal(jobs.length, 2)
    const runs = await ownerPool.db.select().from(generationRun).where(eq(generationRun.trigger, "cron"))
    assert.deepEqual(runs.map((run) => run.jobId).sort(), jobs.map((job) => job.id).sort(), "the run names the job pg-boss holds")
    assert.deepEqual(jobs.map((job) => job.singletonKey).sort(), [a.scheme, b.scheme].sort())

    // The second sweep: both schemes have a job queued, so no run is written and the ones that were are the ones that stand.
    const second = await planAhead(context(), "sweep-3")
    assert.deepEqual([second.queued.length, second.alreadyQueued.sort(), second.failed.length], [0, [a.scheme, b.scheme].sort(), 0])
    assert.equal((await ownerPool.db.select().from(generationRun).where(eq(generationRun.trigger, "cron"))).length, 2, "a run rolled back with a send that answered null")

    // pg-boss's own table shows the two jobs, and nothing of the run rows leaked into it.
    const [{ count }] = await ownerPool.sql.unsafe<{ count: number }[]>(`select count(*)::int as count from ${PGBOSS_SCHEMA}.job where name = '${GENERATE_ROUTES_QUEUE}'`)
    assert.equal(count, 2)
    await running.stop(2_000)
    running = undefined
    await new PgBoss({ connectionString: withDatabaseName(owner.url, name), schema: PGBOSS_SCHEMA, migrate: false }).stop({ graceful: false, close: true, timeout: 1_000 }).catch(() => undefined)
  })
  test("a paused subscription's containers (#291) get no stop on the paused days, from the rule group or the manual group, are not counted unlocated, and are stopped at again once the pause ends", async () => {
    // Company b, which nothing has generated for: Parkvej's subscription — bins 1 and 2 by the rule, the glass bin by hand — paused for Thursday the 8th alone.
    await ownerPool.db.insert(subscriptionPause).values({ companyId: b.company, projectId: b.project, subscriptionId: b.parkvejSubscription, validFrom: "2026-10-08", validTo: "2026-10-09" })
    const generateB = async (window: { from: string; to: string }) => {
      const runId = await runFor(b.scheme, b.company, b.project, window)
      const outcome = await runGeneration({ generationRunId: runId, companyId: b.company }, null, context())
      assert.equal(outcome.kind, "succeeded")
      const [run] = await ownerPool.db.select().from(generationRun).where(eq(generationRun.id, runId))
      return run
    }
    const stopsOn = async (groupId: string, day: string): Promise<string[]> => {
      const [row] = await ownerPool.db.select().from(route).where(and(eq(route.collectionGroupId, groupId), eq(route.serviceDate, day)))
      return row === undefined ? [] : (await pickupsOf(row.id)).map((stop) => stop.containerId ?? "")
    }

    const paused = await generateB(WEEK)
    assert.equal(paused.unlocated, 1, "the bin nobody located, and not the paused pick")
    assert.deepEqual(await stopsOn(b.residualGroup, "2026-10-05"), [b.bin1, b.bin2, b.bin3], "Monday, before the pause")
    assert.deepEqual(await stopsOn(b.residualGroup, "2026-10-08"), [b.bin3], "Thursday, paused: bin 1 is passed over, and bin 2's placement ended that day")
    assert.deepEqual(await stopsOn(b.glassGroup, "2026-10-08"), [], "the paused pick has no stop")
    const [stamp] = await ownerPool.db.select().from(generationMatch).where(eq(generationMatch.collectionGroupId, b.residualGroup))
    assert.deepEqual([...stamp.containerIds].sort(), [b.bin1, b.bin2, b.bin3].sort(), "the drift stamp reads what the rule matched: a pause is not drift")

    const resumed = await generateB({ from: "2026-10-12", to: "2026-10-18" })
    assert.equal(resumed.unlocated, 1)
    assert.deepEqual(await stopsOn(b.residualGroup, "2026-10-15"), [b.bin1, b.bin3], "the Thursday after: bin 1 is back")
    assert.deepEqual(await stopsOn(b.glassGroup, "2026-10-15"), [b.glassBin], "and so is the pick")
  })
})
