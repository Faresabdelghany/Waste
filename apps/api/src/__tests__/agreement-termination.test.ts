// What a termination leaves on the routes (#291, slice 10): its containers
// leave service on the day, so generation's planned routes from then stop at
// them no more once a run reads them again, and the termination asks one run
// of each scheme whose planned routes do — from the day, or the project's
// today, or the scheme's first day, whichever is latest, through the last such
// route — as `release-hold` asks one (#245): under the scheme's key, absorbed
// by a run already queued, only for a caller who may ask a run of the scheme,
// and never a refusal where no worker has made the queue yet. The stops no
// run will take away — on a dispatched route, or the office's own on a planned
// one — come back in the answer for the office to remove by hand. A route
// before the day is history and is neither asked about nor answered. What the
// run does with the routes is the worker's (apps/worker generation.test.ts);
// the routes here are written by hand, as generation would write them.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Agreement, AgreementTerminated, Subscription } from "@waste/contracts/agreements"
import { ContainerType, Product, WasteFraction } from "@waste/contracts/catalogue"
import { ContainerServicePlacement } from "@waste/contracts/containers"
import { Customer, Property } from "@waste/contracts/customers"
import { GenerationRun } from "@waste/contracts/generation"
import { Page } from "@waste/contracts/pagination"
import { RouteScheme } from "@waste/contracts/route-schemes"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { GENERATE_ROUTES_QUEUE } from "@waste/db/commands/generation"
import { QueueMissing, type Send } from "@waste/db/jobs"
import { pickup, route } from "@waste/db/schema/execution"
import { company } from "@waste/db/schema/organisation"
import { withCompany } from "@waste/db/tenant"
import type { PickupOrigin } from "@waste/domain/execution/vocabulary"
import { eq, sql } from "drizzle-orm"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { seedFleet, seedPlanning, type FleetFixtures, type PlanningFixtures } from "./scheme-fixtures"
import { stocked, warehouseIn } from "./stock-fixtures"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the ledger rows the stocked containers write, which `wms_api` may not delete. */
const owner = ownerUnderTest()

/** The request's clock: Monday 5 October 2026, noon. */
const NOON = new Date("2026-10-05T12:00:00Z")
const TODAY = "2026-10-05"
/** The termination's day, a Saturday: the routes from the Monday after stop at containers no longer in service. */
const ON = "2026-10-10"
const MONDAYS = ["2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02"] as const

describe("a termination's generation runs and the stops it leaves (#291, slice 10)", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let planning: PlanningFixtures
  let fleet: FleetFixtures
  let olivia: Call
  let residual: WasteFraction
  let bin: ContainerType
  let customer: Customer
  let collection: Product
  let warehouse: string

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    planning = await seedPlanning(pool, a)
    fleet = await seedFleet(pool, a, planning)
    olivia = callingAs(createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOON }), keys, a.users.olivia, a.companyId)
    residual = await create(olivia, "/waste-fractions", { key: "residual", name: "Residual waste" }, WasteFraction)
    bin = await create(olivia, "/container-types", { name: "240 L bin", volumeLitres: 240 }, ContainerType)
    customer = await create(olivia, "/customers", { kind: "organisation", name: "Acme Housing" }, Customer)
    collection = await create(olivia, "/products", { projectId: a.projects.copenhagen.id, name: "Residual collection", kind: "container-collection", unit: "pickup", status: "active" }, Product)
    warehouse = await warehouseIn(pool, a.companyId, a.projects.copenhagen.id, "WH-TERM")
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  type Schema<T> = { parse: (value: unknown) => T }
  async function create<T>(call: Call, path: string, values: unknown, schema: Schema<T>): Promise<T> {
    const response = await call(path, { method: "POST", body: values })
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    return schema.parse(await response.json())
  }

  type Sent = { name: string; singletonKey: unknown }
  /** The caller named — the office unless said otherwise — through an app whose job sender answers as `send` does, each send recorded. */
  const callerWith = (send: () => Promise<string | null>, user = a.users.olivia) => {
    const sent: Sent[] = []
    const jobs: { send: Send } = { send: (name, _data, options) => send().then((answer) => (sent.push({ name, singletonKey: options?.singletonKey }), answer)) }
    return { sent, call: callingAs(createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOON, jobs }), keys, user, a.companyId) }
  }
  const runsOf = async (schemeId: string) => Page(GenerationRun).parse(await (await olivia(`/route-schemes/${schemeId}/generation-runs?limit=200`)).json()).items

  /** A validated scheme of Copenhagen Central over Mondays, one rule group on the residual fraction. */
  const scheme = async (name: string): Promise<RouteScheme> => {
    const response = await olivia("/route-schemes", {
      method: "POST",
      body: {
        projectId: a.projects.copenhagen.id,
        name,
        serviceType: "container-collection",
        frequency: "weekly",
        serviceDays: ["monday"],
        status: "validated",
        planningAreaId: planning.areas.centrum.id,
        validFrom: "2026-01-01",
        plannedStartTime: "06:00",
        depotId: fleet.depots.nordhavn.id,
        unloadingStationId: fleet.stations.amager.id,
        collectionGroups: [{ name: "Round 1", days: ["monday"], stopSource: "rule", rule: { wasteFractionIds: [residual.id], containerTypeIds: [], vehicleTypeId: null } }],
      },
    })
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    return RouteScheme.parse(await response.json())
  }

  /** An agreement of its own with one subscription at a property of its own, a bin issued under it from January: what the termination ends. */
  const served = async (number: string) => {
    const agreement = await create(
      olivia,
      "/agreements",
      { projectId: a.projects.copenhagen.id, number, customerId: customer.id, payerCustomerId: customer.id, billingCadence: "monthly", currency: "DKK", validFrom: "2026-01-01" },
      Agreement,
    )
    const property = await create(olivia, "/properties", { projectId: a.projects.copenhagen.id, name: `${number} Allé`, address: `${number} Allé 1, 2100 København Ø`, kind: "residential" }, Property)
    const subscription = await create(olivia, `/agreements/${agreement.id}/subscriptions`, { productId: collection.id, propertyId: property.id, validFrom: "2026-01-01" }, Subscription)
    const container = await stocked(olivia, { projectId: a.projects.copenhagen.id, label: `BIN-${number}`, containerTypeId: bin.id }, warehouse)
    await create(olivia, `/containers/${container.id}/placements`, { subscriptionId: subscription.id, wasteFractionId: residual.id, validFrom: "2026-01-01" }, ContainerServicePlacement)
    return { agreement, property, container }
  }

  /** A route of the scheme's group on a day, in the status given, with one planned stop at the container, written as generation (or, for an office stop, the office) would write it. */
  const routeAt = async (of: RouteScheme, day: string, stop: { containerId: string; propertyId: string; origin?: PickupOrigin }, status: "planned" | "ready" = "planned") => {
    const id = testId()
    const pickupId = testId()
    await withCompany(pool.db, a.companyId, async (tx: Tx) => {
      const [{ next }] = await tx
        .update(company)
        .set({ nextRouteNumber: sql`${company.nextRouteNumber} + 1` })
        .where(eq(company.id, a.companyId))
        .returning({ next: company.nextRouteNumber })
      await tx.insert(route).values({
        id,
        companyId: a.companyId,
        projectId: of.projectId,
        routeSchemeId: of.id,
        collectionGroupId: of.collectionGroups[0].id,
        serviceDate: day,
        operatingDate: day,
        status,
        number: next - 1,
        plannedStartTime: "06:00",
        depotId: of.depotId,
        unloadingStationId: of.unloadingStationId,
        dispatchedAt: status === "ready" ? new Date(`${day}T05:30:00+02:00`) : null,
      })
      await tx.insert(pickup).values({
        id: pickupId,
        companyId: a.companyId,
        projectId: of.projectId,
        routeId: id,
        containerId: stop.containerId,
        position: 1,
        origin: stop.origin ?? "generation",
        propertyId: stop.propertyId,
        wasteFractionId: residual.id,
      })
    })
    return { id, pickupId }
  }

  const terminated = async (call: Call, agreementId: string): Promise<AgreementTerminated> => {
    const response = await call(`/agreements/${agreementId}/terminate`, { method: "POST", body: { on: ON } })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return AgreementTerminated.parse(await response.json())
  }

  test("asks one run of the scheme from the day through its last planned route there, and answers the stops no run will take away", async () => {
    const mondays = await scheme("Termination Mondays")
    const { agreement, property, container } = await served("AGR-7001")
    const stop = { containerId: container.id, propertyId: property.id }
    await routeAt(mondays, TODAY, stop)
    await routeAt(mondays, MONDAYS[0], stop)
    const ready = await routeAt(mondays, MONDAYS[1], stop, "ready")
    const office = await routeAt(mondays, MONDAYS[2], { ...stop, origin: "office" })
    await routeAt(mondays, MONDAYS[3], stop)

    const caller = callerWith(async () => testId())
    const before = await runsOf(mondays.id)
    const answer = await terminated(caller.call, agreement.id)
    assert.deepEqual(caller.sent, [{ name: GENERATE_ROUTES_QUEUE, singletonKey: mondays.id }], "one run, under the scheme's key")
    const asked = (await runsOf(mondays.id)).filter((run) => !before.some((earlier) => earlier.id === run.id))
    assert.deepEqual(
      asked.map((run) => [run.windowFrom, run.windowTo, run.trigger, run.status]),
      [[ON, MONDAYS[3], "on-demand", "queued"]],
      "from the day, after today, through the last planned route that stops there; today's route is history",
    )
    assert.deepEqual(
      answer.stopsToRemove.map((left) => [left.routeId, left.pickupId, left.operatingDate, left.containerId]),
      [
        [ready.id, ready.pickupId, MONDAYS[1], container.id],
        [office.id, office.pickupId, MONDAYS[2], container.id],
      ],
      "the dispatched route's stop and the office's own, by day",
    )
    assert.match(answer.stopsToRemove[0].routeLabel, /^RC-\d+$/)
  })

  test("asks no run for a role that may end agreements but not ask a run of a scheme, nor where no worker has made the queue yet: the termination stands and the stops are still answered", async () => {
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: "customers.agreements", actions: ["view", "edit"] }])
    const mondays = await scheme("Customer service Mondays")
    const ended = await served("AGR-7002")
    await routeAt(mondays, MONDAYS[0], { containerId: ended.container.id, propertyId: ended.property.id })
    const ready = await routeAt(mondays, MONDAYS[1], { containerId: ended.container.id, propertyId: ended.property.id }, "ready")
    const service = callerWith(async () => testId(), a.users.viewer)
    const before = await runsOf(mondays.id)
    const answer = await terminated(service.call, ended.agreement.id)
    assert.deepEqual(service.sent, [], "a run of a scheme is the schemes module's edit")
    assert.deepEqual(answer.stopsToRemove.map((left) => left.routeId), [ready.id])

    const unqueued = await served("AGR-7003")
    await routeAt(mondays, MONDAYS[2], { containerId: unqueued.container.id, propertyId: unqueued.property.id })
    const answered = await terminated(callerWith(async () => Promise.reject(new QueueMissing(GENERATE_ROUTES_QUEUE))).call, unqueued.agreement.id)
    assert.equal(answered.agreement.validTo, ON, "no queue: the termination stands, and the next run drops the stops")
    assert.deepEqual(await runsOf(mondays.id), before, "no run written for either")
  })
})
