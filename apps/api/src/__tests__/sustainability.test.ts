// The customer sustainability report (M13 of #293): a waste fraction's
// emission factor added, ended and refused where it overlaps another; and a
// Customer's report over a completed route — a stop weighed by its own weight
// proof, two sharing the route's unloaded kilograms less that by volume
// whoever's they are, a fraction with no unload unmeasured, a load the
// station refused and a rejected unload counting for nothing, and a stop with no container counted at its site as
// not attributed — with the CO₂e of the weighed kilograms, the recycling
// rate, its file, and its two grants.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Page } from "@waste/contracts/pagination"
import { SustainabilityReport, WasteFractionEmissionFactor } from "@waste/contracts/sustainability"
import { Unload } from "@waste/contracts/unloads"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { agreement, subscription } from "@waste/db/schema/agreements"
import { product, wasteFraction } from "@waste/db/schema/catalogue"
import { containerServicePlacement } from "@waste/db/schema/containers"
import { customer } from "@waste/db/schema/customers"
import { pickup } from "@waste/db/schema/execution"
import { wasteFractionEmissionFactor } from "@waste/db/schema/sustainability"
import { withCompany } from "@waste/db/tenant"
import { eq } from "drizzle-orm"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { at, seedExecution, seedRoute, type ExecutionFixtures, type SeededRoute } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, type FleetFixtures } from "./scheme-fixtures"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys } from "./tokens"

const database = databaseUnderTest()
/** The fixtures write proofs and unloads, ledgers `wms_api` may not delete. */
const owner = ownerUnderTest()

const DAY = "2026-10-12"
const NOON = new Date(`${DAY}T10:00:00Z`)
const SOURCE = "A national register of waste emission factors, 2025 edition"

describe("the sustainability report", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let a: Tenant
  let b: Tenant
  let fleet: FleetFixtures
  let ex: ExecutionFixtures
  let olivia: Call
  let other: Call
  /** Reads the customers and nothing of the stops. */
  let viewer: Call
  let collected: SeededRoute
  const anna = testId()

  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  const report = async (query: string, as: Call = olivia): Promise<SustainabilityReport> => {
    const response = await as(`/reports/sustainability?${query}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return SustainabilityReport.parse(await response.json())
  }

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    const keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    fleet = await seedFleet(pool, a, await seedPlanning(pool, a))
    ex = await seedExecution(pool, a, fleet)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: "customers.contacts", actions: ["view"] }])
    const app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOON })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)

    const scoped = { companyId: a.companyId, projectId: a.projects.copenhagen.id }
    await withCompany(pool.db, a.companyId, async (tx: Tx) => {
      const productId = testId()
      const agreementId = testId()
      const subscriptionId = testId()
      await tx.insert(customer).values({ id: anna, companyId: a.companyId, kind: "person", name: "Anna Andersen", status: "active" })
      await tx.insert(product).values({ id: productId, ...scoped, name: "Residual 240 L", kind: "container-collection", status: "active", unit: "pickup", containerTypeId: ex.containerTypes.bin.id, wasteFractionId: ex.fractions.residual.id })
      await tx.insert(agreement).values({ id: agreementId, ...scoped, validFrom: "2026-01-01", number: "AGR-M13", customerId: anna, payerCustomerId: anna, status: "active", billingCadence: "monthly", currency: "DKK" })
      await tx.insert(subscription).values({ id: subscriptionId, ...scoped, validFrom: "2026-01-01", agreementId, productId, propertyId: ex.properties.parkvej.id })
      // Anna's two bins; BIN-3 serves nobody's agreement.
      await tx.insert(containerServicePlacement).values([
        { id: testId(), ...scoped, validFrom: "2026-01-01", containerId: ex.containers.bin1.id, subscriptionId, wasteFractionId: ex.fractions.residual.id },
        { id: testId(), ...scoped, validFrom: "2026-01-01", containerId: ex.containers.bin2.id, subscriptionId, wasteFractionId: ex.fractions.residual.id },
      ])
      await tx.update(wasteFraction).set({ treatment: "energy-recovery" }).where(eq(wasteFraction.id, ex.fractions.residual.id))
      // Residual's factor since the year began: 400 kg CO₂e per tonne burnt, nothing avoided.
      await tx.insert(wasteFractionEmissionFactor).values({ id: testId(), companyId: a.companyId, wasteFractionId: ex.fractions.residual.id, footprintKgPerTonne: 400, source: SOURCE, validFrom: "2026-01-01" })
    })
    const done = { status: "completed" as const, outcomeAt: at(DAY, "09:00") }
    collected = await seedRoute(pool, a, fleet, ex, {
      status: "completed",
      operatingDate: DAY,
      pickups: [
        { containerId: ex.containers.bin1.id, propertyId: ex.properties.parkvej.id, ...done },
        { containerId: ex.containers.bin2.id, propertyId: ex.properties.havnegade.id, ...done },
        { containerId: ex.containers.bin3.id, propertyId: ex.properties.norrebrogade.id, ...done },
        { containerId: ex.containers.bin1.id, propertyId: ex.properties.parkvej.id, wasteFractionId: ex.fractions.glass.id, origin: "office", ...done },
        // A repair of Anna's BIN-2: a work order, not a collection — never counted, never a share of the weighbridge.
        { containerId: ex.containers.bin2.id, propertyId: ex.properties.havnegade.id, origin: "office", service: "repair", ...done },
      ],
      proofs: [{ kind: "weight", pickupIndex: 0, occurredAt: at(DAY, "08:10"), weightKg: 30 }],
    })
    // An address-only stop at Parkvej: no container, so no agreement's.
    await withCompany(pool.db, a.companyId, async (tx: Tx) => {
      await tx.insert(pickup).values({ id: testId(), companyId: a.companyId, projectId: a.projects.copenhagen.id, routeId: collected.id, containerId: null, position: 6, origin: "office", propertyId: ex.properties.parkvej.id, wasteFractionId: ex.fractions.residual.id, ...done })
    })
    // The weighbridge: 130 kg of residual counted, a glass load refused at the gate (O9 of #290), and a residual reading the office rejected.
    const capture = async (values: { wasteFractionId: string; netKg: number; refusal?: { reason: string } }) =>
      created(olivia, `/routes/${collected.id}/unloads`, await olivia(`/routes/${collected.id}/unloads`, { method: "POST", body: { unloadingStationId: fleet.stations.amager.id, occurredAt: at(DAY, "12:00").toISOString(), ...values } }), Unload, "/unloads")
    await capture({ wasteFractionId: ex.fractions.residual.id, netKg: 130 })
    await capture({ wasteFractionId: ex.fractions.glass.id, netKg: 50, refusal: { reason: "fraction-not-accepted" } })
    const misread = await capture({ wasteFractionId: ex.fractions.residual.id, netKg: 70 })
    assert.equal((await olivia(`/unloads/${misread.id}/reject`, { method: "POST", body: { note: "The weighbridge misread" } })).status, 201)
  })

  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    if (b) await dropTenant(pool, b.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  describe("a fraction's emission factor", () => {
    test("is added from a day with its source, refused over another of its fraction's periods, listed by the day, and ended", async () => {
      const body = { wasteFractionId: ex.fractions.glass.id, footprintKgPerTonne: 20, avoidedKgPerTonne: 300, source: SOURCE, validFrom: "2025-01-01" }
      const factor = await created(olivia, "/waste-fraction-emission-factors", await olivia("/waste-fraction-emission-factors", { method: "POST", body }), WasteFractionEmissionFactor)
      assert.deepEqual([factor.footprintKgPerTonne, factor.avoidedKgPerTonne, factor.validTo], [20, 300, null])
      const overlap = await refused(await olivia("/waste-fraction-emission-factors", { method: "POST", body: { ...body, validFrom: "2025-06-01" } }), 409)
      assert.match(overlap.detail ?? "", /Another factor for this waste fraction is in force/)
      const inForce = await olivia(`/waste-fraction-emission-factors?wasteFractionId=${ex.fractions.glass.id}&validOn=2025-10-12`)
      assert.deepEqual(Page(WasteFractionEmissionFactor).parse(await inForce.json()).items.map((item) => item.id), [factor.id])
      const ended = await olivia(`/waste-fraction-emission-factors/${factor.id}`, { method: "PATCH", body: { validTo: "2026-01-01" } })
      assert.equal(WasteFractionEmissionFactor.parse(await ended.json()).validTo, "2026-01-01")
    })

    test("names one of the company's fractions, and a patch moves the end and the source alone", async () => {
      const theirs = testId()
      await withCompany(pool.db, b.companyId, async (tx: Tx) => {
        await tx.insert(wasteFraction).values({ id: theirs, companyId: b.companyId, key: "theirs", name: "Theirs" })
      })
      const refusal = await refused(await olivia("/waste-fraction-emission-factors", { method: "POST", body: { wasteFractionId: theirs, footprintKgPerTonne: 10, source: SOURCE, validFrom: "2026-01-01" } }), 400)
      assert.deepEqual(refusal.errors?.map((error) => error.path), ["wasteFractionId"])
      const [residual] = Page(WasteFractionEmissionFactor).parse(await (await olivia(`/waste-fraction-emission-factors?wasteFractionId=${ex.fractions.residual.id}`)).json()).items
      await refused(await olivia(`/waste-fraction-emission-factors/${residual.id}`, { method: "PATCH", body: { footprintKgPerTonne: 401 } }), 400)
      await refused(await olivia(`/waste-fraction-emission-factors/${residual.id}`, { method: "PATCH", body: { validTo: "2026-01-01" } }), 400)
      await refused(await other(`/waste-fraction-emission-factors/${residual.id}`), 404)
    })
  })

  describe("a Customer's report", () => {
    test("weighs a stop by its proof, shares the route's unloaded kilograms over its other stops, and counts what it cannot weigh", async () => {
      const read = await report(`customerId=${anna}&from=2026-10-01&to=2026-10-31`)
      // The route's 130 kg of residual, less BIN-1's 30 kg weighed, is shared over its three other residual collections — BIN-2, nobody's
      // BIN-3 and the address-only stop — equally, since that one has no volume: 34, 33, 33 in the stop list's order. The glass load was
      // refused, and BIN-2's repair is a work order, no collection.
      // The fixtures' own completed route of 5 October stopped at BIN-1 too, with no unload: unmeasured.
      assert.deepEqual(
        read.sites.map((site) => [site.name, site.notAttributedStops, site.lines.map((line) => [line.name, line.treatment, line.kg, line.stops, line.footprintGrams, line.avoidedGrams])]),
        [
          ["Havnegade 3", 0, [["Residual waste", "energy-recovery", { measured: 0, apportioned: 34, estimated: 0 }, { measured: 0, apportioned: 1, estimated: 0, unmeasured: 0 }, 13_600, 0]]],
          [
            "Parkvej 18",
            1,
            [
              ["Glass", null, { measured: 0, apportioned: 0, estimated: 0 }, { measured: 0, apportioned: 0, estimated: 0, unmeasured: 1 }, 0, 0],
              ["Residual waste", "energy-recovery", { measured: 30, apportioned: 0, estimated: 0 }, { measured: 1, apportioned: 0, estimated: 0, unmeasured: 1 }, 12_000, 0],
            ],
          ],
        ],
      )
      assert.deepEqual(read.totals, { weighedKg: 64, recycledKg: 0, recyclingRate: 0, footprintGrams: 25_600, avoidedGrams: 0, unmeasuredStops: 2 })
      assert.deepEqual(read.warnings, [])
    })

    test("is empty outside the window, and refuses another company's customer at the query", async () => {
      const empty = await report(`customerId=${anna}&from=2026-11-01&to=2026-11-30`)
      assert.deepEqual([empty.sites, empty.totals.recyclingRate, empty.totals.unmeasuredStops], [[], null, 0])
      const refusal = await refused(await other(`/reports/sustainability?customerId=${anna}&from=2026-10-01&to=2026-10-31`), 400)
      assert.deepEqual(refusal.errors?.map((error) => error.path), ["customerId"])
    })

    test("files as CSV, a row per site and fraction and one for the stop with no container", async () => {
      const response = await olivia(`/reports/sustainability.csv?customerId=${anna}&from=2026-10-01&to=2026-10-31&separator=semicolon`)
      assert.equal(response.status, 200)
      assert.match(response.headers.get("content-type") ?? "", /^text\/csv/)
      const records = (await response.text()).slice(1).split("\r\n").filter((record) => record !== "")
      assert.equal(records.length, 1 + 3 + 1, "the header, three lines, Parkvej's not-attributed stop")
      assert.ok(records.some((record) => record.includes(";Residual waste;energy-recovery;30;0;0;1;12.000;0.000;")), "Parkvej's residual, in kilograms with their three decimals")
    })

    test("is held by the customers' grant and the stops'", async () => {
      assert.match((await refused(await viewer(`/reports/sustainability?customerId=${anna}&from=2026-10-01&to=2026-10-31`), 403)).detail ?? "", /route-studio\.pickups/)
    })
  })
})
