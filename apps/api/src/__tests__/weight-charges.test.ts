// A weight charge (O28 of #290, C32 of #291) through the API's doors: the
// office reprices a blocked one at the day's price per tonne over its stored
// kilograms, may not cancel one with the consumer's `weight-revised`, and a
// settlement pays the provider its own price per tonne over the same
// kilograms, a reversal over those of the charge it undoes. The charge itself
// is the Finance consumer's (apps/worker), so here it is written as the
// consumer writes it, on the settlement fixtures' served route.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { BillableEvent } from "@waste/contracts/billable-events"
import { SettlementDetail } from "@waste/contracts/settlements"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { product } from "@waste/db/schema/catalogue"
import { unload } from "@waste/db/schema/execution"
import { billableEvent, priceListRow, serviceProviderPrice } from "@waste/db/schema/finance"
import { withCompany } from "@waste/db/tenant"
import { tonnesAt } from "@waste/domain/finance/tonnage"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { at, seedExecution, type ExecutionFixtures } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, type FleetFixtures } from "./scheme-fixtures"
import { seedSettlementFixtures, type SettlementFixtures } from "./settlement-fixtures"
import { dropTenant, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys } from "./tokens"

const database = databaseUnderTest()
const owner = ownerUnderTest()

const MORNING = new Date("2026-11-03T09:00:00Z")
/** The customer's price per tonne, 512.50 kr, and NordRen's, 300.00 kr. */
const CUSTOMER_RATE = 51_250
const PROVIDER_RATE = 30_000
/** The stop's share of the Unload's reviewed net. */
const SHARE_KG = 2_500

describe("a weight charge through the API", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let a: Tenant
  let fleet: FleetFixtures
  let ex: ExecutionFixtures
  let fx: SettlementFixtures
  let olivia: Call
  const tonneProductId = testId()
  const unloadId = testId()
  const chargeId = testId()
  const reversalId = testId()

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    const keys = await signingKeys()
    a = await seedTenant(pool)
    const planning = await seedPlanning(pool, a)
    fleet = await seedFleet(pool, a, planning)
    ex = await seedExecution(pool, a, fleet)
    fx = await seedSettlementFixtures(pool, a, planning, fleet, ex)
    olivia = callingAs(createApp({ probe: pool, pool, verifier: keys.verifier, now: () => MORNING }), keys, a.users.olivia, a.companyId)
    const { companyId } = a
    const projectId = a.projects.copenhagen.id
    const served = fx.events.early.route
    if (served === null) throw new Error("the early event has its route")
    await withCompany(pool.db, companyId, async (tx: Tx) => {
      await tx.insert(product).values({ id: tonneProductId, companyId, projectId, name: "Residual waste · per tonne", kind: "container-collection", status: "active", unit: "tonne", vatPercent: 25 })
      await tx.insert(serviceProviderPrice).values({ id: testId(), companyId, projectId, serviceAreaAssignmentId: fx.assignments.nordren.id, productId: tonneProductId, bidMinor: PROVIDER_RATE, unitPriceMinor: PROVIDER_RATE, currency: "DKK", validFrom: "2026-07-01" })
      await tx.insert(unload).values({
        id: unloadId,
        companyId,
        projectId,
        routeId: served.id,
        unloadingStationId: fleet.stations.amager.id,
        wasteFractionId: ex.fractions.residual.id,
        source: "dispatch",
        occurredAt: at(fx.events.early.serviceDate, "09:00"),
        recordedBy: a.users.olivia.id,
        netKg: SHARE_KG,
      })
      const load = tonnesAt(CUSTOMER_RATE, SHARE_KG)
      const charge = { companyId, projectId, serviceDate: fx.events.early.serviceDate, agreementId: fx.agreement.id, subscriptionId: null, productId: tonneProductId, quantity: 1, currency: "DKK", vatPercent: 25, createdBy: null }
      await tx.insert(billableEvent).values([
        // The consumer's charge of the stop's share, priced: the weighed load's amount, the row its rate came from.
        { ...charge, id: chargeId, kind: "weight", unitPriceMinor: load, netMinor: load, vatMinor: Math.round(load / 4), priceListRowId: fx.rows.collection.id, blockReason: null, routeId: served.id, pickupId: served.pickupIds[0], unloadId, weightKg: SHARE_KG, sourceEventId: testId() },
        // Its reversal, as a later review undoes an invoiced charge: nothing of its own, the original named.
        { ...charge, id: reversalId, kind: "reversal", unitPriceMinor: load, netMinor: -load, vatMinor: -Math.round(load / 4), priceListRowId: null, blockReason: null, reversesEventId: chargeId, sourceEventId: testId() },
      ])
    })
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  const post = (path: string, body: unknown = {}) => olivia(path, { method: "POST", body })

  test("a settlement pays the provider its price per tonne over the charge's kilograms, and the reversal's over the charge it undoes", async () => {
    const opened = await created(olivia, "/settlements", await post("/settlements", { serviceAreaAssignmentId: fx.assignments.nordren.id, validFrom: "2026-09-01", validTo: "2026-10-01" }), SettlementDetail)
    const response = await post(`/settlements/${opened.id}/calculate`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    const calculated = SettlementDetail.parse(await response.json())
    const lineOf = (eventId: string) => {
      const line = calculated.lines.find((candidate) => candidate.billableEventId === eventId)
      assert.ok(line, `a line for ${eventId}`)
      return [line.quantity, line.unitPriceMinor, line.netMinor]
    }
    // 2,500 kg at 300.00 kr a tonne is 750.00 kr.
    assert.deepEqual(lineOf(chargeId), [1, 75_000, 75_000])
    assert.deepEqual(lineOf(reversalId), [1, 75_000, -75_000])
  })

  test("the office cancels a weight charge for its own reasons, never the consumer's weight-revised", async () => {
    const consumers = await post(`/billable-events/${chargeId}/cancel`, { reason: "weight-revised" })
    assert.equal(consumers.status, 400)
    assert.deepEqual((await readProblem(consumers)).errors?.map((error) => error.path), ["reason"])
  })

  test("a blocked weight charge is priced again at the day's price per tonne over its stored kilograms", async () => {
    const blockedId = testId()
    const served = fx.events.early.route!
    const projectId = a.projects.copenhagen.id
    await withCompany(pool.db, a.companyId, async (tx: Tx) => {
      await tx.insert(billableEvent).values({ id: blockedId, companyId: a.companyId, projectId, kind: "weight", serviceDate: fx.events.early.serviceDate, agreementId: fx.agreement.id, productId: tonneProductId, quantity: 1, blockReason: "no-price-row", routeId: served.id, pickupId: served.pickupIds[0], unloadId, weightKg: 8_240, sourceEventId: testId() })
      // The office mends the list: the tonne's row, open-ended from January.
      await tx.insert(priceListRow).values({ id: testId(), companyId: a.companyId, projectId, priceListId: fx.priceList.id, productId: tonneProductId, unitPriceMinor: CUSTOMER_RATE, validFrom: "2026-01-01" })
    })
    const response = await post(`/billable-events/${blockedId}/reprice`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    const priced = BillableEvent.parse(await response.json())
    // 8,240 kg at 512.50 kr a tonne is 4,223.00 kr; its VAT 1,055.75 kr.
    assert.deepEqual([priced.status, priced.quantity, priced.weightKg, priced.unitPriceMinor, priced.netMinor, priced.vatMinor, priced.links.unloadId], ["ready", 1, 8_240, 422_300, 422_300, 105_575, unloadId])
  })
})
