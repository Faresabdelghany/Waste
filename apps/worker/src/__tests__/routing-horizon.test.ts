// The horizon (#172, over #132 §2–4 and #124 §2 and §4) on a database of
// this file's own. Generation asks a Plan for every route it creates or
// reshapes that is planned or ready and operates inside tomorrow…today + 7 on
// the project's clock, after its own transaction — the optimiser for a route
// of fifty stops or fewer from a depot, a baseline measurement above or
// without one, a dispatcher's order extended — and the nightly
// `routing.sweep-horizon` asks for every planned or ready route of an active
// project in that window with no active Plan or a stale one, across
// companies as the worker role, nearest date first, and re-sends the job of
// a calculating Plan a day old whose job is gone. The jobs land on real
// pg-boss queues made with their options and are handed to routing's
// handlers the way the worker's poll takes them, over the fake provider on a
// pinned clock. Company A generates from three schemes and carries most of
// the sweep's routes; company B has one route in an active project and one in
// a project still onboarding. The tests run in order over one database, each
// building on what the one before it left.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import type { Point, Polygon, Position2D } from "@waste/contracts/geojson"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { ensurePlan, ROUTING_MEASURE_QUEUE, ROUTING_OPTIMISE_QUEUE, type RoutingJobData } from "@waste/db/commands/plans"
import { createIdMinter } from "@waste/db/ids"
import { migrateDatabase } from "@waste/db/migrate"
import { agreement, subscription } from "@waste/db/schema/agreements"
import { containerType, product, wasteFraction } from "@waste/db/schema/catalogue"
import { container, containerServicePlacement } from "@waste/db/schema/containers"
import { customer, property } from "@waste/db/schema/customers"
import { pickup, route } from "@waste/db/schema/execution"
import { driver, vehicle } from "@waste/db/schema/fleet"
import { vehicleType } from "@waste/db/schema/fleet-types"
import { generationRun } from "@waste/db/schema/generation"
import { company, project } from "@waste/db/schema/organisation"
import { depot, unloadingStation } from "@waste/db/schema/places"
import { planningArea, planningAreaBoundary } from "@waste/db/schema/planning-areas"
import { plan, planStop, routingQuota } from "@waste/db/schema/routing"
import { collectionGroup, collectionGroupContainer, collectionGroupFraction, routeScheme } from "@waste/db/schema/route-schemes"
import { PGBOSS_SCHEMA } from "@waste/db/sql/pgboss"
import { withCompany } from "@waste/db/tenant"
import { SUPERSEDED } from "@waste/domain/routing/vocabulary"
import { FakeProvider, type FakeScript } from "@waste/routing/fake"
import { DEFAULT_PROFILE, type RoutingProvider } from "@waste/routing/provider"
import { QuotaEngine, STANDARD_PLAN } from "@waste/routing/quota"
import { and, asc, eq } from "drizzle-orm"
import type { PgBoss } from "pg-boss"

import { createBoss } from "../boss"
import type { JobContext } from "../jobs/definition"
import { runGeneration } from "../jobs/generate-routes"
import { sweepHorizon } from "../jobs/routing-horizon"
import { routingMeasure } from "../jobs/routing-measure"
import { routingOptimise } from "../jobs/routing-optimise"
import { rolesUnderTest, withDatabaseName } from "./database"

const roles = rolesUnderTest()
const testId = createIdMinter()

/** Saturday 3 October 2026, evening in Copenhagen: today there is the 3rd, and the horizon runs from Sunday the 4th to Saturday the 10th. */
const NOW = new Date("2026-10-03T18:00:00.000Z")
const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
/** The provider's reset two hours on, and a deferral's wake: the reset plus the half-minute of jitter the engine is pinned to. */
const RESET = "2026-10-03T20:00:00.000Z"
const DEFERRED = new Date("2026-10-03T20:00:30.000Z")
const OPENED = "2026-01-01"
/** Two weeks of service dates from Monday the 5th: the first week inside the horizon, the second beyond it. */
const TWO_WEEKS = { from: "2026-10-05", to: "2026-10-16" }
/** A batch job's priority, one step lower per day of its operating date (@waste/domain/routing/jobs): Monday the 5th is day 20 731 of the Unix epoch. */
const batchPriority = {
  "2026-10-04": 979_270,
  "2026-10-05": 979_269,
  "2026-10-06": 979_268,
  "2026-10-07": 979_267,
  "2026-10-08": 979_266,
  "2026-10-09": 979_265,
  "2026-10-10": 979_264,
  "2026-10-12": 979_262,
  "2026-10-15": 979_259,
} as const

const DEPOT: Position2D = [12.5683, 55.6761]
const SOUTH_DEPOT: Position2D = [12.6, 55.64]
const STATION: Position2D = [12.55, 55.72]
const PARKVEJ: Position2D = [12.55, 55.7]
const HAVNEGADE: Position2D = [12.62, 55.7]
const NOERREBRO: Position2D = [12.54, 55.69]
/** Outside the square: the residual rule never matches it, a hand's pick still can. */
const AMAGER: Position2D = [12.62, 55.62]
const HOSPITAL: Position2D = [12.58, 55.68]
/** A point the provider's optimiser cannot reach. */
const UNREACHABLE: Position2D = [12.6, 55.66]
/** A square over central Copenhagen. */
const SQUARE: Polygon = { type: "Polygon", coordinates: [[[12.5, 55.65], [12.65, 55.65], [12.65, 55.75], [12.5, 55.75], [12.5, 55.65]]] }
const point = (at: Position2D): Point => ({ type: "Point", coordinates: at })
const UNROUTABLE = "Could not find routable point within a radius of 350.0 meters of specified coordinate 1"

/** One company's fixture ids, a nibble telling the companies apart. */
const ids = (n: "a" | "b") => {
  const id = (suffix: number) => `018f7c38-${n}000-7000-8000-${suffix.toString(16).padStart(12, "0")}`
  return {
    company: id(0x01),
    project: id(0x02),
    onboarding: id(0x03),
    residual: id(0x04),
    glass: id(0x05),
    paper: id(0x0a),
    containerType: id(0x06),
    customer: id(0x07),
    product: id(0x08),
    agreement: id(0x09),
    parkvej: id(0x11),
    havnegade: id(0x12),
    noerrebro: id(0x13),
    amager: id(0x14),
    hospital: id(0x15),
    unreachable: id(0x16),
    onboardingHouse: id(0x17),
    parkvejSubscription: id(0x21),
    havnegadeSubscription: id(0x22),
    noerrebroSubscription: id(0x23),
    amagerSubscription: id(0x24),
    hospitalSubscription: id(0x25),
    bin1: id(0x31),
    bin2: id(0x32),
    bin3: id(0x33),
    bin4: id(0x34),
    farBin: id(0x35),
    onboardingBin: id(0x36),
    placement1: id(0x41),
    placement2: id(0x42),
    placement3: id(0x43),
    placement4: id(0x44),
    planningArea: id(0x51),
    boundary: id(0x52),
    depot: id(0x53),
    station: id(0x54),
    southDepot: id(0x55),
    residualScheme: id(0x61),
    residualGroup: id(0x62),
    plainScheme: id(0x63),
    plainGroup: id(0x64),
    hospitalScheme: id(0x65),
    hospitalGroup: id(0x66),
    handScheme: id(0x67),
    onboardingScheme: id(0x68),
    paperScheme: id(0x69),
    paperGroup: id(0x6a),
    vehicleType: id(0x71),
    vehicle: id(0x72),
    driver: id(0x73),
    hospitalBin: (index: number) => id(0x1000 + index),
    hospitalPlacement: (index: number) => id(0x2000 + index),
  }
}
type Fixture = ReturnType<typeof ids>
const a = ids("a")
const b = ids("b")
const HOSPITAL_BINS = 51

/**
 * Company A as the owner: a project in Copenhagen, its catalogue and customer,
 * six located properties under one agreement, placed bins, the square, two
 * depots and a station, a driver with a vehicle, and four validated schemes —
 * residual on Mondays and Thursdays by rule from the depot to the station,
 * a Tuesday round of two picked bins naming neither end, Wednesday's
 * fifty-one glass bins at the hospital from the depot to the station, and
 * paper on Fridays by a rule that matches nothing — beside a draft scheme the
 * hand-made routes hang from.
 */
async function seedA(tx: Tx): Promise<void> {
  const tenant = { companyId: a.company }
  const scoped = { ...tenant, projectId: a.project }
  await tx.insert(company).values({ id: a.company, ...tenant, name: "Company A", legalName: "Company A A/S", registrationNumber: "20000001", country: "DK", status: "active" })
  await tx.insert(project).values({ id: a.project, ...tenant, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active", weekend: ["saturday", "sunday"] })
  await tx.insert(wasteFraction).values([
    { id: a.residual, ...tenant, key: "residual", name: "Residual waste" },
    { id: a.glass, ...tenant, key: "glass", name: "Glass" },
    { id: a.paper, ...tenant, key: "paper", name: "Paper" },
  ])
  await tx.insert(containerType).values({ id: a.containerType, ...tenant, name: "240 L bin", volumeLitres: 240 })
  await tx.insert(customer).values({ id: a.customer, ...tenant, kind: "organisation", name: "Parkvej Boligforening", registrationNumber: "30000001", status: "active" })
  await tx.insert(product).values({ id: a.product, ...scoped, name: "Residual 240 L weekly", kind: "container-collection", status: "active", unit: "pickup", containerTypeId: a.containerType, wasteFractionId: a.residual })
  await tx.insert(property).values([
    { id: a.parkvej, ...scoped, name: "Parkvej 18", address: "Parkvej 18", kind: "residential", status: "active", location: point(PARKVEJ) },
    { id: a.havnegade, ...scoped, name: "Havnegade 2", address: "Havnegade 2", kind: "commercial", status: "active", location: point(HAVNEGADE) },
    { id: a.noerrebro, ...scoped, name: "Nørrebrogade 40", address: "Nørrebrogade 40", kind: "residential", status: "active", location: point(NOERREBRO) },
    { id: a.amager, ...scoped, name: "Amagerbrogade 1", address: "Amagerbrogade 1", kind: "residential", status: "active", location: point(AMAGER) },
    { id: a.hospital, ...scoped, name: "Bispebjerg Hospital", address: "Bispebjerg Bakke 23", kind: "commercial", status: "active", location: point(HOSPITAL) },
    { id: a.unreachable, ...scoped, name: "Prøvestenen 1", address: "Prøvestenen 1", kind: "commercial", status: "active", location: point(UNREACHABLE) },
  ])
  await tx.insert(agreement).values({ id: a.agreement, ...scoped, validFrom: OPENED, number: "AGR-2408", customerId: a.customer, payerCustomerId: a.customer, status: "active", billingCadence: "monthly", currency: "DKK" })
  await tx.insert(subscription).values([
    { id: a.parkvejSubscription, ...scoped, validFrom: OPENED, agreementId: a.agreement, productId: a.product, propertyId: a.parkvej },
    { id: a.havnegadeSubscription, ...scoped, validFrom: OPENED, agreementId: a.agreement, productId: a.product, propertyId: a.havnegade },
    { id: a.noerrebroSubscription, ...scoped, validFrom: OPENED, agreementId: a.agreement, productId: a.product, propertyId: a.noerrebro },
    { id: a.amagerSubscription, ...scoped, validFrom: OPENED, agreementId: a.agreement, productId: a.product, propertyId: a.amager },
    { id: a.hospitalSubscription, ...scoped, validFrom: OPENED, agreementId: a.agreement, productId: a.product, propertyId: a.hospital },
  ])
  const hospitalIndices = Array.from({ length: HOSPITAL_BINS }, (_, index) => index + 1)
  await tx.insert(container).values([
    { id: a.bin1, ...scoped, label: "BIN-1001", containerTypeId: a.containerType, ownership: "company" },
    { id: a.bin2, ...scoped, label: "BIN-1002", containerTypeId: a.containerType, ownership: "company" },
    { id: a.bin3, ...scoped, label: "BIN-1003", containerTypeId: a.containerType, ownership: "company" },
    { id: a.bin4, ...scoped, label: "BIN-1004", containerTypeId: a.containerType, ownership: "company" },
    { id: a.farBin, ...scoped, label: "BIN-1009", containerTypeId: a.containerType, ownership: "company" },
    ...hospitalIndices.map((index) => ({ id: a.hospitalBin(index), ...scoped, label: `GLS-${String(index).padStart(3, "0")}`, containerTypeId: a.containerType, ownership: "company" })),
  ])
  // BIN-1003 at Nørrebro waits unplaced until a test places it.
  await tx.insert(containerServicePlacement).values([
    { id: a.placement1, ...scoped, validFrom: OPENED, containerId: a.bin1, subscriptionId: a.parkvejSubscription, wasteFractionId: a.residual },
    { id: a.placement2, ...scoped, validFrom: OPENED, containerId: a.bin2, subscriptionId: a.havnegadeSubscription, wasteFractionId: a.residual },
    { id: a.placement4, ...scoped, validFrom: OPENED, containerId: a.bin4, subscriptionId: a.amagerSubscription, wasteFractionId: a.residual },
    ...hospitalIndices.map((index) => ({ id: a.hospitalPlacement(index), ...scoped, validFrom: OPENED, containerId: a.hospitalBin(index), subscriptionId: a.hospitalSubscription, wasteFractionId: a.glass })),
  ])
  await tx.insert(planningArea).values({ id: a.planningArea, ...scoped, code: "OP-CEN-01", name: "Central", purpose: "route-planning" })
  await tx.insert(planningAreaBoundary).values({ id: a.boundary, ...scoped, validFrom: OPENED, planningAreaId: a.planningArea, boundary: SQUARE })
  await tx.insert(depot).values([
    { id: a.depot, ...scoped, code: "DEP-NORD", name: "Nordhavn", address: "Sundkrogsgade 21", location: point(DEPOT), ownership: "company", status: "active" },
    { id: a.southDepot, ...scoped, code: "DEP-SYD", name: "Sydhavn", address: "Sydhavnsgade 5", location: point(SOUTH_DEPOT), ownership: "company", status: "active" },
  ])
  await tx.insert(unloadingStation).values({ id: a.station, ...tenant, code: "ARC-AMAGER", name: "Amager Bakke", address: "Vindmøllevej 6", location: point(STATION), ownership: "company", status: "active" })
  await tx.insert(vehicleType).values({ id: a.vehicleType, ...tenant, key: "rear-loader", name: "Rear loader" })
  await tx.insert(vehicle).values({ id: a.vehicle, ...scoped, registration: "CN 24 101", callsign: "WH-24", kind: "powered-vehicle", vehicleTypeId: a.vehicleType, ownership: "company", status: "active", requiredLicenceClass: "c" })
  await tx.insert(driver).values({ id: a.driver, ...scoped, name: "Mads Jensen", employment: "employee", licenceClass: "ce", licenceExpiry: "2030-12-31", status: "active" })
  await tx.insert(routeScheme).values([
    { id: a.residualScheme, ...scoped, validFrom: OPENED, name: "Residual weekly", planningAreaId: a.planningArea, serviceType: "container-collection", frequency: "weekly", serviceDays: ["monday", "thursday"], status: "validated", plannedStartTime: "06:30", depotId: a.depot, unloadingStationId: a.station },
    { id: a.plainScheme, ...scoped, validFrom: OPENED, name: "Tuesday round", serviceType: "container-collection", frequency: "weekly", serviceDays: ["tuesday"], status: "validated", plannedStartTime: "07:00" },
    { id: a.hospitalScheme, ...scoped, validFrom: OPENED, name: "Hospital glass", serviceType: "container-collection", frequency: "weekly", serviceDays: ["wednesday"], status: "validated", plannedStartTime: "05:30", depotId: a.depot, unloadingStationId: a.station },
    { id: a.handScheme, ...scoped, validFrom: OPENED, name: "Hand-made routes", serviceType: "container-collection", frequency: "weekly", serviceDays: ["monday"], status: "draft" },
    { id: a.paperScheme, ...scoped, validFrom: OPENED, name: "Paper weekly", planningAreaId: a.planningArea, serviceType: "container-collection", frequency: "weekly", serviceDays: ["friday"], status: "validated", plannedStartTime: "06:00", depotId: a.depot },
  ])
  await tx.insert(collectionGroup).values([
    { id: a.residualGroup, ...scoped, routeSchemeId: a.residualScheme, name: "Residual", position: 1, days: ["monday", "thursday"], stopSource: "rule" },
    { id: a.plainGroup, ...scoped, routeSchemeId: a.plainScheme, name: "Tuesday", position: 1, days: ["tuesday"], stopSource: "manual" },
    { id: a.hospitalGroup, ...scoped, routeSchemeId: a.hospitalScheme, name: "Hospital", position: 1, days: ["wednesday"], stopSource: "manual" },
    { id: a.paperGroup, ...scoped, routeSchemeId: a.paperScheme, name: "Paper", position: 1, days: ["friday"], stopSource: "rule" },
  ])
  // Nobody in the square puts paper out: the paper rule matches nothing.
  await tx.insert(collectionGroupFraction).values([
    { ...scoped, collectionGroupId: a.residualGroup, wasteFractionId: a.residual },
    { ...scoped, collectionGroupId: a.paperGroup, wasteFractionId: a.paper },
  ])
  await tx.insert(collectionGroupContainer).values([
    { ...scoped, collectionGroupId: a.plainGroup, containerId: a.bin1, position: 1 },
    { ...scoped, collectionGroupId: a.plainGroup, containerId: a.bin2, position: 2 },
    ...hospitalIndices.map((index) => ({ ...scoped, collectionGroupId: a.hospitalGroup, containerId: a.hospitalBin(index), position: index })),
  ])
}

/** Company B as the owner: a project in Aarhus that is active and one still onboarding, each with a located property, a bin and a draft scheme for hand-made routes. */
async function seedB(tx: Tx): Promise<void> {
  const tenant = { companyId: b.company }
  await tx.insert(company).values({ id: b.company, ...tenant, name: "Company B", legalName: "Company B A/S", registrationNumber: "20000002", country: "DK", status: "active" })
  await tx.insert(project).values([
    { id: b.project, ...tenant, name: "Aarhus Nord", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active" },
    { id: b.onboarding, ...tenant, name: "Aarhus Syd", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "onboarding" },
  ])
  await tx.insert(wasteFraction).values({ id: b.residual, ...tenant, key: "residual", name: "Residual waste" })
  await tx.insert(containerType).values({ id: b.containerType, ...tenant, name: "240 L bin", volumeLitres: 240 })
  await tx.insert(property).values([
    { id: b.parkvej, ...tenant, projectId: b.project, name: "Parkvej 1", address: "Parkvej 1, Aarhus", kind: "residential", status: "active", location: point(PARKVEJ) },
    { id: b.onboardingHouse, ...tenant, projectId: b.onboarding, name: "Havnegade 1", address: "Havnegade 1, Aarhus", kind: "residential", status: "active", location: point(HAVNEGADE) },
  ])
  await tx.insert(container).values([
    { id: b.bin1, ...tenant, projectId: b.project, label: "BIN-2001", containerTypeId: b.containerType, ownership: "company" },
    { id: b.onboardingBin, ...tenant, projectId: b.onboarding, label: "BIN-2002", containerTypeId: b.containerType, ownership: "company" },
  ])
  await tx.insert(routeScheme).values([
    { id: b.handScheme, ...tenant, projectId: b.project, validFrom: OPENED, name: "Hand-made routes", serviceType: "container-collection", frequency: "weekly", serviceDays: ["monday"], status: "draft" },
    { id: b.onboardingScheme, ...tenant, projectId: b.onboarding, validFrom: OPENED, name: "Hand-made routes", serviceType: "container-collection", frequency: "weekly", serviceDays: ["monday"], status: "draft" },
  ])
}

type JobRow = { id: string; name: string; state: string; data: RoutingJobData; priority: number; singleton_key: string }

describe("the horizon: generation's routing jobs and routing.sweep-horizon", { skip: roles.skip }, () => {
  const name = `waste_worker_horizon_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  let admin: Database
  let owner: Database
  let api: Database
  let worker: Database
  let boss: PgBoss
  const lines: string[] = []

  /** The clock every job reads, which the last test moves night by night. */
  const clock = { now: NOW }
  /** An engine over a scripted fake — or a provider of a test's own — on the pinned clock: the jitter half a minute, the 429's wait instant. */
  const engineOf = (script: FakeScript = {}, provider?: RoutingProvider) => {
    const fake = new FakeProvider(script)
    const engine = new QuotaEngine(provider ?? fake, {
      ...STANDARD_PLAN,
      now: () => clock.now,
      sleep: async () => {},
      random: () => 0.5,
      warn: (line) => void lines.push(line),
      error: (line) => void lines.push(line),
    })
    return { fake, engine }
  }
  /** The context a job runs with: the API role's pool for the writes, the worker role's for the sweeps, pg-boss's own send and complete. */
  const contextOf = (engine: QuotaEngine = engineOf().engine, overrides: Partial<JobContext> = {}): JobContext => ({
    api,
    worker,
    now: () => clock.now,
    log: (message) => void lines.push(message),
    send: (queue, data, options) => boss.send(queue, data, options ?? {}),
    complete: (queue, id, options) => boss.complete(queue, id, undefined, options),
    routing: engine,
    ...overrides,
  })

  before(async () => {
    admin = createDb(roles.adminUrl, { max: 1 })
    await admin.sql.unsafe(`create database "${name}"`)
    await migrateDatabase(withDatabaseName(roles.adminUrl, name))
    owner = createDb(withDatabaseName(roles.adminUrl, name), { max: 3 })
    api = createDb(withDatabaseName(roles.apiUrl, name), { max: 3 })
    worker = createDb(withDatabaseName(roles.workerUrl, name), { max: 2 })
    boss = createBoss({ url: withDatabaseName(roles.adminUrl, name), log: (line) => void lines.push(line) })
    await boss.start()
    // The routing queues as the worker's registry makes them; nobody works them here, so each job waits until a test hands it over.
    await boss.createQueue(ROUTING_MEASURE_QUEUE, routingMeasure.queueOptions)
    await boss.createQueue(ROUTING_OPTIMISE_QUEUE, routingOptimise.queueOptions)
    await owner.db.transaction(async (tx) => {
      await seedA(tx)
      await seedB(tx)
    })
  })

  after(async () => {
    await boss?.stop({ graceful: false, close: true, timeout: 2_000 })
    await Promise.allSettled([api?.close(), worker?.close(), owner?.close()])
    try {
      await admin?.sql.unsafe(`drop database if exists "${name}" with (force)`)
    } finally {
      await admin?.close()
    }
  })

  const routesOf = (schemeId: string) => owner.db.select().from(route).where(eq(route.routeSchemeId, schemeId)).orderBy(asc(route.serviceDate))
  const activeOf = async (routeId: string) => (await owner.db.select({ activePlanId: route.activePlanId }).from(route).where(eq(route.id, routeId)))[0].activePlanId
  const plansOf = (routeId: string) => owner.db.select().from(plan).where(eq(plan.routeId, routeId)).orderBy(asc(plan.id))
  const planRow = async (planId: string) => (await owner.db.select().from(plan).where(eq(plan.id, planId)))[0]
  const planCount = async () => (await owner.db.select({ id: plan.id }).from(plan)).length
  const stopsOf = async (planId: string) => (await owner.db.select({ pickupId: planStop.pickupId }).from(planStop).where(eq(planStop.planId, planId)).orderBy(asc(planStop.position))).map((row) => row.pickupId)
  const pickupsOf = (routeId: string) => owner.db.select().from(pickup).where(eq(pickup.routeId, routeId)).orderBy(asc(pickup.position), asc(pickup.id))
  const pickupOf = async (routeId: string, containerId: string) => (await owner.db.select().from(pickup).where(and(eq(pickup.routeId, routeId), eq(pickup.containerId, containerId))))[0]
  /** The jobs pg-boss holds under these Plans' keys, oldest first. */
  const jobsOf = (planIds: readonly string[]) => owner.sql.unsafe<JobRow[]>(`select id, name, state, data, priority, singleton_key from ${PGBOSS_SCHEMA}.job where singleton_key = any($1::text[]) order by created_on, id`, [[...planIds]])
  /** Every job either routing queue ever held, or one queue's. */
  const jobCount = async (queue?: string) => {
    const [{ count }] = await owner.sql.unsafe<{ count: number }[]>(`select count(*)::int as count from ${PGBOSS_SCHEMA}.job where name = any($1::text[])`, [queue === undefined ? [ROUTING_MEASURE_QUEUE, ROUTING_OPTIMISE_QUEUE] : [queue]])
    return count
  }

  /** A run of one of A's schemes over the window, its row written as a sender writes it, run to its end as the job runs it. */
  const generate = async (schemeId: string, window = TWO_WEEKS, context = contextOf()) => {
    const [row] = await owner.db.insert(generationRun).values({ companyId: a.company, projectId: a.project, routeSchemeId: schemeId, trigger: "on-demand", windowFrom: window.from, windowTo: window.to }).returning({ id: generationRun.id })
    const outcome = await runGeneration({ generationRunId: row.id, companyId: a.company }, null, context)
    if (outcome.kind !== "succeeded") assert.fail(`the run was already ${outcome.status}`)
    return outcome
  }

  /** Every job due on the queue, taken as the worker's poll takes them, handed to its handler, and settled as pg-boss settles the batch's answers. */
  const drain = async (queue: string, context: JobContext) => {
    const jobs = await boss.fetch<RoutingJobData>(queue, { batchSize: 100 })
    if (jobs.length === 0) return
    const settled = (await (queue === ROUTING_OPTIMISE_QUEUE ? routingOptimise : routingMeasure).handler(jobs, context)) as { id: string; status: string }[]
    for (const { id, status } of settled) await (status === "completed" ? boss.complete(queue, id) : boss.fail(queue, id))
  }

  const numbers = new Map<string, number>()
  type HandStop = { containerId: string; propertyId: string; fractionId: string; open?: false }
  /** A route written straight into a draft scheme's fresh group, as the owner, with its stops: what the sweep reads, however it came to be. */
  const handMade = async (own: Fixture, fields: { projectId?: string; schemeId?: string; operatingDate: string; status?: "planned" | "ready" | "active" | "cancelled"; depot?: true; stops: HandStop[] }) => {
    const projectId = fields.projectId ?? own.project
    const routeSchemeId = fields.schemeId ?? own.handScheme
    const routeId = testId()
    const collectionGroupId = testId()
    const pickupIds = fields.stops.map(() => testId())
    const number = (numbers.get(own.company) ?? 9000) + 1
    numbers.set(own.company, number)
    const status = fields.status ?? "planned"
    const early = new Date("2026-10-03T04:00:00.000Z")
    const stamps =
      status === "ready" ? { dispatchedAt: early } : status === "active" ? { dispatchedAt: early, startedAt: early, actualDriverId: own.driver, actualVehicleId: own.vehicle } : status === "cancelled" ? { cancelledAt: early } : {}
    await owner.db.transaction(async (tx) => {
      await tx.insert(collectionGroup).values({ id: collectionGroupId, companyId: own.company, projectId, routeSchemeId, name: `Hand-made ${number}`, position: number, days: [], stopSource: "manual" })
      await tx.insert(route).values({ id: routeId, companyId: own.company, projectId, routeSchemeId, collectionGroupId, serviceDate: fields.operatingDate, operatingDate: fields.operatingDate, status, number, depotId: fields.depot ? own.depot : null, ...stamps })
      await tx.insert(pickup).values(
        fields.stops.map((stop, index) => ({
          id: pickupIds[index],
          companyId: own.company,
          projectId,
          routeId,
          containerId: stop.containerId,
          position: index + 1,
          propertyId: stop.propertyId,
          wasteFractionId: stop.fractionId,
          ...(stop.open === false ? { status: "skipped", reason: "route-ended", outcomeAt: early } : { status: "planned" }),
        })),
      )
    })
    return { id: routeId, pickupIds }
  }

  test("a generation run asks one Plan for each route it creates operating inside tomorrow…today + 7: the optimiser for two stops from a depot, not yet active, its job batch under the Plan's key at the operating date's priority; the routes beyond get nothing", async () => {
    await generate(a.residualScheme)
    const routes = await routesOf(a.residualScheme)
    assert.deepEqual(
      routes.map((row) => row.operatingDate),
      ["2026-10-05", "2026-10-08", "2026-10-12", "2026-10-15"],
    )
    const [monday, thursday, ...beyond] = routes
    for (const row of beyond) assert.deepEqual(await plansOf(row.id), [], `${row.operatingDate} lies beyond the horizon`)
    const [mondayPlan, ...more] = await plansOf(monday.id)
    const [thursdayPlan] = await plansOf(thursday.id)
    assert.deepEqual(more, [], "one Plan a route")
    assert.deepEqual([mondayPlan.solver, mondayPlan.status, mondayPlan.trip, mondayPlan.provider], ["optimiser", "calculating", "full", "fake"])
    assert.equal(
      mondayPlan.fingerprint,
      "provider=fake|profile=driving-hgv|solver=optimiser|configuration=|depot=12.56830,55.67610|station=12.55000,55.72000|stops=12.55000,55.70000;12.62000,55.70000|constraints=",
      "keyed on the depot, the station and the two stops' places",
    )
    assert.equal(await activeOf(monday.id), null, "an optimiser Plan is made active on ready (#124 §2)")
    assert.deepEqual(
      (await jobsOf([mondayPlan.id, thursdayPlan.id])).map((job) => [job.name, job.state, job.singleton_key, job.data, job.priority]),
      [
        [ROUTING_OPTIMISE_QUEUE, "created", mondayPlan.id, { planId: mondayPlan.id, companyId: a.company, class: "batch" }, batchPriority["2026-10-05"]],
        [ROUTING_OPTIMISE_QUEUE, "created", thursdayPlan.id, { planId: thursdayPlan.id, companyId: a.company, class: "batch" }, batchPriority["2026-10-08"]],
      ],
    )
    assert.equal(await jobCount(), 2, "and nothing else was sent")
  })

  test("a second run over unchanged inputs asks for nothing: no Plan and no job", async () => {
    const [plans, jobs] = [await planCount(), await jobCount()]
    const outcome = await generate(a.residualScheme)
    assert.deepEqual([outcome.counts.routesCreated, outcome.counts.routesRefreshed], [0, 0])
    assert.deepEqual([await planCount(), await jobCount()], [plans, jobs])
  })

  test("a route of more than fifty stops, and one naming no depot, get a baseline Plan instead: active from creation, its stops the generated order, measured on routing.measure", async () => {
    await generate(a.hospitalScheme)
    await generate(a.plainScheme)
    const [wednesday, nextWednesday] = await routesOf(a.hospitalScheme)
    const [tuesday, nextTuesday] = await routesOf(a.plainScheme)
    assert.deepEqual(
      [wednesday.operatingDate, tuesday.operatingDate, nextWednesday.operatingDate, nextTuesday.operatingDate],
      ["2026-10-07", "2026-10-06", "2026-10-14", "2026-10-13"],
    )
    for (const row of [nextWednesday, nextTuesday]) assert.deepEqual(await plansOf(row.id), [], `${row.operatingDate} lies beyond the horizon`)
    const [hospital] = await plansOf(wednesday.id)
    assert.deepEqual([hospital.solver, hospital.status, hospital.trip], ["baseline", "calculating", "full"])
    assert.equal(await activeOf(wednesday.id), hospital.id)
    const hospitalPickups = await pickupsOf(wednesday.id)
    assert.equal(hospitalPickups.length, HOSPITAL_BINS)
    assert.deepEqual(
      await stopsOf(hospital.id),
      hospitalPickups.map((row) => row.id),
      "the fifty-one stops in the generated order",
    )
    const [plain] = await plansOf(tuesday.id)
    assert.deepEqual([plain.solver, plain.status, plain.trip], ["baseline", "calculating", "stops-only"])
    assert.equal(await activeOf(tuesday.id), plain.id)
    assert.deepEqual(await stopsOf(plain.id), [(await pickupOf(tuesday.id, a.bin1)).id, (await pickupOf(tuesday.id, a.bin2)).id])
    assert.deepEqual(
      (await jobsOf([hospital.id, plain.id])).map((job) => [job.name, job.data.class, job.priority]),
      [
        [ROUTING_MEASURE_QUEUE, "batch", batchPriority["2026-10-07"]],
        [ROUTING_MEASURE_QUEUE, "batch", batchPriority["2026-10-06"]],
      ],
    )
  })

  test("a route the run creates with nothing to collect is asked no Plan: there is no order to measure", async () => {
    const jobs = await jobCount()
    const outcome = await generate(a.paperScheme)
    assert.equal(outcome.counts.routesCreated, 2)
    const [friday] = await routesOf(a.paperScheme)
    assert.deepEqual([friday.operatingDate, (await pickupsOf(friday.id)).length], ["2026-10-09", 0])
    assert.deepEqual(await plansOf(friday.id), [])
    assert.deepEqual(outcome.horizon, { asked: [], failed: [] })
    assert.equal(await jobCount(), jobs)
  })

  test("the superseded path: a deferred measurement whose Plan is no longer the route's active one makes no call and fails as superseded", async () => {
    // The company's directions stand at the reserve, as the last job read them: both batch measurements wait for the reset, their Plans calculating.
    await owner.db.insert(routingQuota).values({ companyId: a.company, provider: "fake", family: "directions", remaining: 500, limit: 2000, resetAt: new Date(RESET) })
    await drain(ROUTING_MEASURE_QUEUE, contextOf())
    await owner.db.delete(routingQuota).where(eq(routingQuota.companyId, a.company))
    const [tuesday] = await routesOf(a.plainScheme)
    const [waiting] = await plansOf(tuesday.id)
    assert.deepEqual([waiting.status, waiting.deferredUntil?.toISOString()], ["calculating", DEFERRED.toISOString()])
    // A bin at Amager joins Tuesday's picks: regeneration reshapes the route, and the new baseline is active from its creation.
    await owner.db.insert(collectionGroupContainer).values({ companyId: a.company, projectId: a.project, collectionGroupId: a.plainGroup, containerId: a.bin4, position: 3 })
    await generate(a.plainScheme)
    const [, reshaped] = await plansOf(tuesday.id)
    assert.equal(await activeOf(tuesday.id), reshaped.id)
    // The waiting job comes due; the reshaped Plan's own is due already.
    const [, successor] = await jobsOf([waiting.id])
    await owner.sql.unsafe(`update ${PGBOSS_SCHEMA}.job set start_after = now() where id = $1`, [successor.id])
    const { engine, fake } = engineOf()
    await drain(ROUTING_MEASURE_QUEUE, contextOf(engine))
    const superseded = await planRow(waiting.id)
    assert.deepEqual([superseded.status, superseded.failureReason, superseded.deferredUntil], ["failed", SUPERSEDED, null])
    assert.equal((await planRow(reshaped.id)).status, "ready", "the reshaped Plan is measured")
    assert.equal(fake.calls.directions, 1, "in one call, its own; the superseded Plan made none")
  })

  test("the staleness path: a stop regeneration inserts under an active Plan leaves that Plan active, reading stale, and asks a new optimiser Plan whose job waits", async () => {
    await drain(ROUTING_OPTIMISE_QUEUE, contextOf())
    const [monday] = await routesOf(a.residualScheme)
    const [solved] = await plansOf(monday.id)
    assert.deepEqual([solved.status, await activeOf(monday.id)], ["ready", solved.id], "the optimiser answered and its Plan is active")
    const jobs = await jobCount()
    // BIN-1003 is placed at Nørrebro, inside the square: the residual rule matches it from here on.
    await owner.db.insert(containerServicePlacement).values({ id: a.placement3, companyId: a.company, projectId: a.project, validFrom: OPENED, containerId: a.bin3, subscriptionId: a.noerrebroSubscription, wasteFractionId: a.residual })
    await generate(a.residualScheme)
    const joined = await pickupOf(monday.id, a.bin3)
    assert.equal(joined.status, "planned")
    assert.equal(await activeOf(monday.id), solved.id, "the Plan stays active")
    assert.ok(!(await stopsOf(solved.id)).includes(joined.id), "and reads stale: the new stop is not among those it names")
    const [, asked] = await plansOf(monday.id)
    assert.deepEqual([asked.solver, asked.status], ["optimiser", "calculating"])
    assert.deepEqual(
      (await jobsOf([asked.id])).map((job) => [job.name, job.state, job.data.class]),
      [[ROUTING_OPTIMISE_QUEUE, "created", "batch"]],
    )
    assert.equal(await jobCount(), jobs + 2, "Monday's and Thursday's; the two routes beyond gained the stop and nothing else")
  })

  test("an unchanged fingerprint re-activates the stored Plan without a job: the stop leaves again, and the Plan that named exactly the rest is active once more", async () => {
    await drain(ROUTING_OPTIMISE_QUEUE, contextOf())
    const [monday, thursday] = await routesOf(a.residualScheme)
    const [first, second] = await plansOf(monday.id)
    const [thursdayFirst] = await plansOf(thursday.id)
    assert.equal(await activeOf(monday.id), second.id, "the answer over three stops is active")
    const [plans, jobs] = [await planCount(), await jobCount()]
    // BIN-1003's placement ends before the week: regeneration skips its pickups.
    await owner.db.update(containerServicePlacement).set({ validTo: "2026-10-05" }).where(eq(containerServicePlacement.id, a.placement3))
    await generate(a.residualScheme)
    const left = await pickupOf(monday.id, a.bin3)
    assert.deepEqual([left.status, left.reason], ["skipped", "regeneration"])
    assert.equal(await activeOf(monday.id), first.id, "the first answer, over exactly the two stops left, is active again")
    assert.equal(await activeOf(thursday.id), thursdayFirst.id)
    assert.deepEqual([await planCount(), await jobCount()], [plans, jobs], "no Plan written, no job sent")
  })

  test("under a dispatcher's order, a stop joining keeps the dispatcher's sequence with the new stop appended, as a manual Plan measured on routing.measure; the optimiser is asked nothing", async () => {
    const [monday, thursday] = await routesOf(a.residualScheme)
    const first = await pickupOf(monday.id, a.bin1)
    const second = await pickupOf(monday.id, a.bin2)
    // The dispatcher puts Havnegade first, through the office's door.
    const reordered = await withCompany(api.db, a.company, (tx: Tx) =>
      ensurePlan(tx, a.company, monday, { solver: "manual", orderedPickupIds: [second.id, first.id], class: "interactive" }, { routing: { name: "fake", profile: DEFAULT_PROFILE }, send: (queue, data, options) => boss.send(queue, data, options ?? {}) }),
    )
    assert.equal(await activeOf(monday.id), reordered.planId)
    const optimisations = await jobCount(ROUTING_OPTIMISE_QUEUE)
    // BIN-1003 is placed again from Monday on: regeneration brings its pickups back.
    await owner.db.insert(containerServicePlacement).values({ companyId: a.company, projectId: a.project, validFrom: "2026-10-05", containerId: a.bin3, subscriptionId: a.noerrebroSubscription, wasteFractionId: a.residual })
    await generate(a.residualScheme)
    const third = await pickupOf(monday.id, a.bin3)
    assert.equal(third.status, "planned")
    const extended = await planRow((await activeOf(monday.id)) as string)
    assert.deepEqual([extended.solver, extended.status], ["manual", "calculating"])
    assert.deepEqual(await stopsOf(extended.id), [second.id, first.id, third.id], "the dispatcher's sequence, Nørrebro appended")
    assert.deepEqual(
      (await jobsOf([extended.id])).map((job) => [job.name, job.data.class, job.priority]),
      [[ROUTING_MEASURE_QUEUE, "batch", batchPriority["2026-10-05"]]],
    )
    // Thursday, under the optimiser's own order, finds its answer over the same three stops.
    const [, thursdaySecond] = await plansOf(thursday.id)
    assert.equal(await activeOf(thursday.id), thursdaySecond.id)
    assert.equal(await jobCount(ROUTING_OPTIMISE_QUEUE), optimisations, "the optimiser was asked nothing")
  })

  test("a new depot on the scheme reshapes its routes inside the horizon: each is asked again from its new end, a dispatcher's order kept, the Plan before it active meanwhile", async () => {
    const [monday, thursday, nextMonday] = await routesOf(a.residualScheme)
    const dispatcherOrder = await stopsOf((await activeOf(monday.id)) as string)
    const [thursdayActive, jobs] = [await activeOf(thursday.id), await jobCount()]
    await owner.db.update(routeScheme).set({ depotId: a.southDepot }).where(eq(routeScheme.id, a.residualScheme))
    await generate(a.residualScheme)
    // Thursday, under the optimiser's own order: a new optimiser Plan from Sydhavn waits, and the one before it stays active.
    const thursdayNewest = (await plansOf(thursday.id)).at(-1)
    assert.deepEqual([thursdayNewest?.solver, thursdayNewest?.status], ["optimiser", "calculating"])
    assert.match(thursdayNewest?.fingerprint ?? "", /\|depot=12\.60000,55\.64000\|/)
    assert.equal(await activeOf(thursday.id), thursdayActive)
    // Monday, under the dispatcher's order: the same sequence as a new manual Plan, measured from Sydhavn.
    const mondayActive = await planRow((await activeOf(monday.id)) as string)
    assert.equal(mondayActive.solver, "manual")
    assert.match(mondayActive.fingerprint, /\|depot=12\.60000,55\.64000\|/)
    assert.deepEqual(await stopsOf(mondayActive.id), dispatcherOrder)
    assert.equal(await jobCount(), jobs + 2, "a job each; the routes beyond changed depot and were asked nothing")
    assert.deepEqual(await plansOf(nextMonday.id), [])
  })

  test("a failing enqueue never fails the run: the routes it wrote stand, the route's Plan rolls back with its send, and the failure is a line in the log", async () => {
    // Fridays join the Tuesday round, and every routing send is refused.
    await owner.db.update(routeScheme).set({ serviceDays: ["tuesday", "friday"] }).where(eq(routeScheme.id, a.plainScheme))
    await owner.db.update(collectionGroup).set({ days: ["tuesday", "friday"] }).where(eq(collectionGroup.id, a.plainGroup))
    const refusing = contextOf(undefined, {
      send: async (queue, data, options) => {
        if (queue.startsWith("routing.")) throw new Error("the routing queue refused the send")
        return boss.send(queue, data, options ?? {})
      },
    })
    const outcome = await generate(a.plainScheme, TWO_WEEKS, refusing)
    assert.equal(outcome.counts.routesCreated, 2, "the Fridays, inside the horizon and beyond it")
    const friday = (await routesOf(a.plainScheme)).find((row) => row.operatingDate === "2026-10-09")
    assert.equal(friday?.status, "planned")
    assert.deepEqual(await plansOf(friday?.id as string), [], "its Plan went with the refused send")
    assert.ok(
      lines.some((line) => line.includes(friday?.id as string) && line.includes("the routing queue refused the send")),
      lines.slice(-3).join("\n"),
    )
  })

  test("the sweep, as wms_worker across companies, asks exactly for the window's planned and ready routes of active projects with no active Plan or a stale one, nearest date first; every other route is left as it was", async () => {
    const at = (bin: string, house: string) => ({ containerId: bin, propertyId: house, fractionId: a.residual })
    const tomorrow = await handMade(a, { operatingDate: "2026-10-04", status: "ready", depot: true, stops: [at(a.bin1, a.parkvej)] })
    const lastDay = await handMade(a, { operatingDate: "2026-10-10", stops: [at(a.bin2, a.havnegade)] })
    const stale = await handMade(a, { operatingDate: "2026-10-08", depot: true, stops: [at(a.bin1, a.parkvej), at(a.bin2, a.havnegade)] })
    // The stale one carries a dispatcher's order naming only its first stop: the second joined after it.
    const dispatchers = testId()
    await owner.db.insert(plan).values({ id: dispatchers, companyId: a.company, projectId: a.project, routeId: stale.id, solver: "manual", status: "ready", trip: "stops-only", provider: "fake", fingerprint: "hand-made", distanceMetres: 0, durationSeconds: 0 })
    await owner.db.insert(planStop).values({ companyId: a.company, projectId: a.project, routeId: stale.id, planId: dispatchers, pickupId: stale.pickupIds[0], position: 1 })
    await owner.db.update(route).set({ activePlanId: dispatchers }).where(eq(route.id, stale.id))
    const elsewhere = await handMade(b, { operatingDate: "2026-10-05", stops: [{ containerId: b.bin1, propertyId: b.parkvej, fractionId: b.residual }] })
    const untouched = [
      // Today's route is already operating, and today + 8 lies beyond the horizon.
      await handMade(a, { operatingDate: "2026-10-03", stops: [at(a.bin1, a.parkvej)] }),
      await handMade(a, { operatingDate: "2026-10-11", stops: [at(a.bin1, a.parkvej)] }),
      // A route cancelled or started has no order left to plan; one with nothing open, nothing to plan.
      await handMade(a, { operatingDate: "2026-10-06", status: "cancelled", stops: [at(a.bin1, a.parkvej)] }),
      await handMade(a, { operatingDate: "2026-10-06", status: "active", stops: [at(a.bin2, a.havnegade)] }),
      await handMade(a, { operatingDate: "2026-10-07", stops: [{ ...at(a.bin1, a.parkvej), open: false }] }),
      // A project still onboarding is not an active one.
      await handMade(b, { projectId: b.onboarding, schemeId: b.onboardingScheme, operatingDate: "2026-10-05", stops: [{ containerId: b.onboardingBin, propertyId: b.onboardingHouse, fractionId: b.residual }] }),
    ]
    const friday = (await routesOf(a.plainScheme)).find((row) => row.operatingDate === "2026-10-09")
    assert.ok(friday, "the Friday whose Plan went with the refused send")
    const generated = [...(await routesOf(a.residualScheme)), ...(await routesOf(a.plainScheme)), ...(await routesOf(a.hospitalScheme)), ...(await routesOf(a.paperScheme))].filter((row) => row.id !== friday.id)
    const plansBefore = new Map(await Promise.all(generated.map(async (row) => [row.id, (await plansOf(row.id)).length] as const)))

    const outcome = await sweepHorizon(contextOf())
    assert.deepEqual(outcome.asked, [tomorrow.id, elsewhere.id, stale.id, friday.id, lastDay.id], "nearest date first")
    const newest = async (routeId: string) => (await plansOf(routeId)).at(-1) as typeof plan.$inferSelect
    const readings = []
    for (const routeId of outcome.asked) {
      const latest = await newest(routeId)
      const [job, ...more] = await jobsOf([latest.id])
      assert.deepEqual(more, [], "one job a Plan")
      readings.push([latest.solver, (await activeOf(routeId)) === latest.id, job.name, job.data.companyId, job.data.class, job.priority])
    }
    assert.deepEqual(readings, [
      ["optimiser", false, ROUTING_OPTIMISE_QUEUE, a.company, "batch", batchPriority["2026-10-04"]],
      ["baseline", true, ROUTING_MEASURE_QUEUE, b.company, "batch", batchPriority["2026-10-05"]],
      ["manual", true, ROUTING_MEASURE_QUEUE, a.company, "batch", batchPriority["2026-10-08"]],
      ["baseline", true, ROUTING_MEASURE_QUEUE, a.company, "batch", batchPriority["2026-10-09"]],
      ["baseline", true, ROUTING_MEASURE_QUEUE, a.company, "batch", batchPriority["2026-10-10"]],
    ])
    assert.deepEqual(await stopsOf((await newest(stale.id)).id), stale.pickupIds, "the dispatcher's order, extended by the stop that joined")
    for (const row of untouched) assert.deepEqual(await plansOf(row.id), [], `route ${row.id} is not the horizon's`)
    for (const row of generated) assert.equal((await plansOf(row.id)).length, plansBefore.get(row.id), `the ${row.operatingDate} route: fresh, or beyond the horizon`)
  })

  test("the sweep re-sends the job of a calculating Plan more than a day old whose job is gone, to its solver's queue, and leaves one whose job is live and one younger than a day", async () => {
    const [, , nextMonday, nextThursday] = await routesOf(a.residualScheme)
    const [, nextTuesday] = await routesOf(a.plainScheme)
    const calculating = async (routeId: string, solver: "manual" | "optimiser", createdAt: Date) => {
      const planId = testId()
      await owner.db.insert(plan).values({ id: planId, companyId: a.company, projectId: a.project, routeId, solver, status: "calculating", trip: "full", provider: "fake", fingerprint: `aged ${planId}`, createdAt })
      return planId
    }
    const aDayAndAnHourAgo = new Date(NOW.getTime() - DAY_MS - HOUR_MS)
    const lostMeasurement = await calculating(nextMonday.id, "manual", aDayAndAnHourAgo)
    const lostOptimisation = await calculating(nextThursday.id, "optimiser", aDayAndAnHourAgo)
    const held = await calculating(nextMonday.id, "manual", aDayAndAnHourAgo)
    await boss.send(ROUTING_MEASURE_QUEUE, { planId: held, companyId: a.company, class: "batch" } satisfies RoutingJobData, { singletonKey: held })
    const young = await calculating(nextTuesday.id, "manual", new Date(NOW.getTime() - 8 * HOUR_MS))

    const outcome = await sweepHorizon(contextOf())
    assert.deepEqual(outcome.recovered, [lostMeasurement, lostOptimisation])
    assert.deepEqual(
      (await jobsOf([lostMeasurement, lostOptimisation])).map((job) => [job.singleton_key, job.name, job.state, job.data, job.priority]),
      [
        [lostMeasurement, ROUTING_MEASURE_QUEUE, "created", { planId: lostMeasurement, companyId: a.company, class: "batch" }, batchPriority["2026-10-12"]],
        [lostOptimisation, ROUTING_OPTIMISE_QUEUE, "created", { planId: lostOptimisation, companyId: a.company, class: "batch" }, batchPriority["2026-10-15"]],
      ],
    )
    assert.equal((await jobsOf([held])).length, 1, "a live job is left to itself")
    assert.equal((await jobsOf([young])).length, 0, "and a Plan younger than a day is not recovered")
  })

  test("a route whose optimisation fails finally costs at most one batch call a night while inside the horizon, and nothing once outside it", async () => {
    const far = await handMade(a, { operatingDate: "2026-10-05", depot: true, stops: [{ containerId: a.farBin, propertyId: a.unreachable, fractionId: a.residual }] })
    let refusals = 0
    const fake = new FakeProvider()
    const unreachable: RoutingProvider = {
      name: fake.name,
      maxWaypoints: fake.maxWaypoints,
      measure: (request) => fake.measure(request),
      optimise: async (request) => {
        if (!request.stops.some(([longitude, latitude]) => longitude === UNREACHABLE[0] && latitude === UNREACHABLE[1])) return fake.optimise(request)
        refusals += 1
        return { kind: "refused", status: 404, sentence: UNROUTABLE, quota: null }
      },
    }
    const answerOptimisations = () => drain(ROUTING_OPTIMISE_QUEUE, contextOf(engineOf({}, unreachable).engine))
    try {
      // The first night: asked, twice over if the sweep runs twice, and one waiting request stands for both.
      const first = await sweepHorizon(contextOf())
      const again = await sweepHorizon(contextOf())
      assert.ok(first.asked.includes(far.id) && again.asked.includes(far.id))
      assert.equal((await plansOf(far.id)).length, 1)
      await answerOptimisations()
      assert.deepEqual(
        (await plansOf(far.id)).map((row) => [row.status, row.failureReason]),
        [["failed", UNROUTABLE]],
      )
      assert.equal(await activeOf(far.id), null, "a failed optimisation leaves the route as it was")
      assert.equal(refusals, 1)
      // The next night the route is still inside the horizon: asked once more, one call more.
      clock.now = new Date(NOW.getTime() + DAY_MS)
      assert.ok((await sweepHorizon(contextOf())).asked.includes(far.id))
      await answerOptimisations()
      assert.equal(refusals, 2)
      assert.deepEqual(
        (await plansOf(far.id)).map((row) => row.status),
        ["failed", "failed"],
      )
      // The night after, it operates today: the horizon asks nothing of it.
      clock.now = new Date(NOW.getTime() + 2 * DAY_MS)
      assert.ok(!(await sweepHorizon(contextOf())).asked.includes(far.id))
      await answerOptimisations()
      assert.equal(refusals, 2)
      assert.equal((await plansOf(far.id)).length, 2)
    } finally {
      clock.now = NOW
    }
  })
})
