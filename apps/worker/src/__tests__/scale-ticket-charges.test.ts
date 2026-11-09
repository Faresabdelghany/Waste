// A Scale Ticket's charges through the consumer (M16b of #293): an account's
// completed ticket is a `scale-ticket` event per line, priced per tonne under
// its agreement on the weighed-out day at the tier its weight meets; the same
// event twice records nothing more; a walk-in's records nothing; and the void
// cancels each live charge with the consumer's reason.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import type { ScaleTicket } from "@waste/contracts/scale-house"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { product } from "@waste/db/schema/catalogue"
import { billableEvent, priceListRow } from "@waste/db/schema/finance"
import { unloadingStation } from "@waste/db/schema/places"
import { scaleTicket, scaleTicketLine } from "@waste/db/schema/scale-house"
import { withCompany } from "@waste/db/tenant"
import { and, eq } from "drizzle-orm"

import type { JobContext } from "../runtime/definition"
import { recordBillableEventFor } from "../finance/record-billable-events"
import type { RelayedEvent } from "../runtime/outbox"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { at, dropFinanceTenant, FIXTURE_DAY, seedFinanceTenant, testId, type FinanceTenant } from "./finance-tenant"

const database = databaseUnderTest()
const owner = ownerUnderTest()
const skip = database.skip || owner.skip
const NOON = new Date("2026-10-06T12:00:00Z")

describe("a Scale Ticket's charges", { skip }, () => {
  let pool: Database
  let admin: Database
  let tenant: FinanceTenant
  const site = testId()
  const byTheTonne = testId()
  let number = 2000

  const context = (): Pick<JobContext, "api" | "log"> => ({ api: pool, log: () => undefined })

  before(async () => {
    pool = createDb(database.url, { max: 2 })
    admin = createDb(owner.url, { max: 1 })
    tenant = await seedFinanceTenant(pool)
    const { companyId } = tenant
    const projectId = tenant.projects.copenhagen.id
    await withCompany(pool.db, companyId, async (tx: Tx) => {
      await tx.insert(unloadingStation).values({ id: site, companyId, code: "SH-1", name: "Nordhavn genbrugsplads", address: "Sundkrogsgade 30", location: { type: "Point", coordinates: [12.59, 55.71] }, ownership: "company", weighbridge: true, status: "active" })
      await tx.insert(product).values({ id: byTheTonne, companyId, projectId, name: "Residual at the window", kind: "additional-service", status: "active", unit: "tonne", vatPercent: 25 })
      await tx.insert(priceListRow).values([
        { id: testId(), companyId, projectId, priceListId: tenant.priceList.id, productId: byTheTonne, unitPriceMinor: 60_000, validFrom: "2026-01-01" },
        { id: testId(), companyId, projectId, priceListId: tenant.priceList.id, productId: byTheTonne, unitPriceMinor: 50_000, fromQuantity: 2, validFrom: "2026-01-01" },
      ])
    })
  })
  after(async () => {
    await dropFinanceTenant(pool, admin, tenant.companyId)
    await pool.close()
    await admin.close()
  })

  /** A completed ticket, an account's under Anna's agreement or a walk-in's, with one line of the window's product sold by the tonne, and the ticket as the window answers it. */
  async function completedTicket(party: "account" | "cash", netKg: number): Promise<{ ticketId: string; lineId: string; answered: ScaleTicket }> {
    const ticketId = testId()
    const lineId = testId()
    const { companyId } = tenant
    const projectId = tenant.projects.copenhagen.id
    const account = party === "account" ? { customerId: tenant.customers.anna.id, agreementId: tenant.agreements.anna.id } : { customerId: null, agreementId: null }
    await withCompany(pool.db, companyId, async (tx: Tx) => {
      await tx.insert(scaleTicket).values({
        id: ticketId,
        companyId,
        projectId,
        number: number++,
        unloadingStationId: site,
        vehiclePlate: "AB 12 345",
        party,
        ...account,
        grossKg: netKg + 8_000,
        weighedInAt: at(FIXTURE_DAY, "09:40"),
        tareKg: 8_000,
        tareSource: "weighed",
        weighedOutAt: at(FIXTURE_DAY, "10:00"),
        netKg,
        status: "completed",
        recordedBy: tenant.users.olivia.id,
      })
      await tx.insert(scaleTicketLine).values({ id: lineId, companyId, projectId, ticketId, position: 1, wasteFractionId: tenant.fractions.residual.id, netKg, productId: byTheTonne })
    })
    const answered: ScaleTicket = {
      id: ticketId,
      createdAt: NOON.toISOString(),
      updatedAt: NOON.toISOString(),
      projectId,
      number: number - 1,
      unloadingStationId: site,
      vehiclePlate: "AB 12 345",
      trailerPlate: null,
      containerRef: null,
      vehicleId: null,
      party,
      ...account,
      visitorName: null,
      grossKg: netKg + 8_000,
      weighedInAt: at(FIXTURE_DAY, "09:40").toISOString(),
      tareKg: 8_000,
      tareSource: "weighed",
      vehicleTareId: null,
      weighedOutAt: at(FIXTURE_DAY, "10:00").toISOString(),
      netKg,
      status: "completed",
      lines: [{ id: lineId, position: 1, wasteFractionId: tenant.fractions.residual.id, originMunicipality: null, netKg, productId: byTheTonne, volumeLitres: null }],
      routeId: null,
      unloadId: null,
      unmatchedReason: null,
      voidReason: null,
      voidNote: null,
      voidedAt: null,
      note: null,
      recordedBy: tenant.users.olivia.id,
    }
    return { ticketId, lineId, answered }
  }

  const published = (kind: "scale-ticket-completed" | "scale-ticket-voided", answered: ScaleTicket): RelayedEvent<"scale-ticket-completed" | "scale-ticket-voided"> => ({
    id: testId(),
    companyId: tenant.companyId,
    projectId: tenant.projects.copenhagen.id,
    kind,
    aggregateKind: "scale-ticket",
    aggregateId: answered.id,
    occurredAt: NOON.toISOString(),
    payload: answered,
    publishedAt: null,
    createdAt: NOON.toISOString(),
    updatedAt: NOON.toISOString(),
  })
  const voidedOf = (answered: ScaleTicket): ScaleTicket => ({ ...answered, status: "voided", voidReason: "entered-in-error", voidedAt: NOON.toISOString() })
  const chargesOf = (lineId: string) =>
    admin.db
      .select({ id: billableEvent.id, kind: billableEvent.kind, agreementId: billableEvent.agreementId, weightKg: billableEvent.weightKg, unitPriceMinor: billableEvent.unitPriceMinor, netMinor: billableEvent.netMinor, serviceDate: billableEvent.serviceDate, cancelReason: billableEvent.cancelReason })
      .from(billableEvent)
      .where(and(eq(billableEvent.companyId, tenant.companyId), eq(billableEvent.scaleTicketLineId, lineId)))

  test("an account's completed ticket is a scale-ticket event per line at the tier its weight meets, once however often it is delivered", async () => {
    const { ticketId, lineId, answered } = await completedTicket("account", 2_340)
    const first = await recordBillableEventFor(published("scale-ticket-completed", answered), context())
    assert.equal(first.did, "recorded")
    const [charge] = await chargesOf(lineId)
    // 2.34 tonnes meet the tier from 2: 500.00 a tonne, 1,170.00 in all.
    assert.deepEqual([charge?.kind, charge?.agreementId, charge?.weightKg, charge?.unitPriceMinor, charge?.netMinor, charge?.serviceDate], ["scale-ticket", tenant.agreements.anna.id, 2_340, 117_000, 117_000, FIXTURE_DAY])
    const again = await recordBillableEventFor(published("scale-ticket-completed", answered), context())
    assert.equal(again.did, "nothing", "a ticket with live charges is charged already")
    assert.equal((await chargesOf(lineId)).length, 1)

    await withCompany(pool.db, tenant.companyId, (tx: Tx) => tx.update(scaleTicket).set({ status: "voided", voidReason: "entered-in-error", voidedAt: NOON, voidedBy: tenant.users.olivia.id }).where(eq(scaleTicket.id, ticketId)))
    const voided = await recordBillableEventFor(published("scale-ticket-voided", voidedOf(answered)), context())
    assert.equal(voided.did, "cancelled")
    assert.equal((await chargesOf(lineId))[0]?.cancelReason, "scale-ticket-voided")
  })

  test("a walk-in's ticket records nothing: its amount is the window's to show", async () => {
    const { lineId, answered } = await completedTicket("cash", 900)
    assert.equal((await recordBillableEventFor(published("scale-ticket-completed", answered), context())).did, "nothing")
    assert.equal((await chargesOf(lineId)).length, 0)
  })
})
