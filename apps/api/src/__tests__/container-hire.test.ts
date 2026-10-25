// Container hire in a billing run (M14 of #293), through the API's billing
// doors over a tenant of the suite's own: a product sold by the day with
// seven free days, its default row and a dearer one for a 10 m³ skip, and
// skips placed under its subscriptions — one from 25 September and on site
// still, its subscription paused for ten days of October; one from 3 to 13
// October; one from 28 October; one under a product no list prices; one under
// a draft agreement; one under a manual cadence and one under a cancelled
// agreement, which a run leaves alone. A preview plans October's run and the
// run mints exactly that, each month charged in arrears once over, its
// placement's first seven days free across the months, at the day's price
// for its container's type, the days the quantity; the invoice says the month
// and the days; October again mints nothing, a run over November before it
// has ended charges none of it, and once ended November alone; a blocked
// hire is repriced as the run priced it, a hire product keeps its day, and a
// work order's job blocked for its product takes one sold by the job, priced
// on the office's ad-hoc route under no scheme. Skipped with the
// reason when `DATABASE_URL` or `DATABASE_ADMIN_URL` is unset, failed under
// `REQUIRE_DATABASE`.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { BillableEvent } from "@waste/contracts/billable-events"
import { BillingRunDetail, BillingRunPreview } from "@waste/contracts/billing"
import { InvoiceDetail } from "@waste/contracts/invoices"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { agreement, subscription, subscriptionPause } from "@waste/db/schema/agreements"
import { containerType, product } from "@waste/db/schema/catalogue"
import { container, containerServicePlacement } from "@waste/db/schema/containers"
import { pickup, route } from "@waste/db/schema/execution"
import { billableEvent, priceListRow } from "@waste/db/schema/finance"
import { withCompany } from "@waste/db/tenant"
import { and, asc, eq, inArray, sql } from "drizzle-orm"

import { createApp } from "../app"
import { A_JOB_IS_SOLD_BY_THE_JOB } from "../routes/billable-events"
import { FREE_DAYS_KEEP_THE_DAY } from "../routes/products"
import { MONTH_PRODUCT_IS_NOT_TICKET_WORK } from "../routes/ticket-charges"
import { seedBilling, type BillingFixtures } from "./billing-fixtures"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { seedExecution, type ExecutionFixtures } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning } from "./scheme-fixtures"
import { dropTenant, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the invoices and lines the runs write, which `wms_api` may not delete. */
const owner = ownerUnderTest()

const NOON = new Date("2026-11-02T12:00:00Z")
/** The days the runs are asked on: each a day after the months they charge have ended. */
const ON = { november20: new Date("2026-11-20T12:00:00Z"), december2: new Date("2026-12-02T12:00:00Z"), february20: new Date("2027-02-20T12:00:00Z") }

/** The skips of the suite, each a case of the rule. */
type Case = "whole" | "returned" | "late" | "unpriced" | "draft" | "manual" | "cancelled"
const CASES: readonly Case[] = ["whole", "returned", "late", "unpriced", "draft", "manual", "cancelled"]

describe("container hire in a billing run", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let ex: ExecutionFixtures
  let fx: BillingFixtures
  let olivia: Call
  let copenhagen: string
  const products = { hire: testId(), unpriced: testId(), wash: testId() }
  let clock = NOON
  const skipType = testId()
  const agreements = { manual: testId(), cancelled: testId() }
  const placements = Object.fromEntries(CASES.map((name) => [name, testId()])) as Record<Case, string>
  const caseOf = (id: string | null): Case => {
    const found = CASES.find((name) => placements[name] === id)
    if (found === undefined) throw new Error(`hire of placement ${id}, none of the suite's`)
    return found
  }

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    copenhagen = a.projects.copenhagen.id
    ex = await seedExecution(pool, a, await seedFleet(pool, a, await seedPlanning(pool, a)))
    fx = await seedBilling(pool, a, ex)
    const { companyId } = a
    await withCompany(pool.db, companyId, async (tx: Tx) => {
      // Skip hire at 45.00 kr a day, 55.00 kr for a 10 m³ skip, its first seven days free; and a crane skip no list prices.
      await tx.insert(containerType).values({ id: skipType, companyId, name: "10 m³ skip", volumeLitres: 10_000 })
      await tx.insert(product).values([
        { id: products.hire, companyId, projectId: copenhagen, name: "Skip hire", kind: "recurring-service", status: "active", unit: "day", invoiceName: "Containerleje", vatPercent: 25, freeDays: 7 },
        { id: products.unpriced, companyId, projectId: copenhagen, name: "Crane skip hire", kind: "recurring-service", status: "active", unit: "day", vatPercent: 25 },
        { id: products.wash, companyId, projectId: copenhagen, name: "Bin wash", kind: "additional-service", status: "active", unit: "job", vatPercent: 25 },
      ])
      await tx.insert(priceListRow).values({ id: testId(), companyId, projectId: copenhagen, priceListId: fx.priceLists.default.id, productId: products.wash, unitPriceMinor: 30_000, validFrom: "2026-01-01" })
      const row = (unitPriceMinor: number, containerTypeId: string | null = null) => ({ id: testId(), companyId, projectId: copenhagen, priceListId: fx.priceLists.default.id, productId: products.hire, unitPriceMinor, containerTypeId, validFrom: "2026-01-01" })
      await tx.insert(priceListRow).values([row(4_500), row(5_500, skipType)])
      const anna = (id: string, number: string, billingCadence: string, status = "active") => ({ id, companyId, projectId: copenhagen, number, customerId: fx.customers.anna.id, payerCustomerId: fx.customers.anna.id, status, billingCadence, currency: "DKK", validFrom: "2026-01-01" })
      await tx.insert(agreement).values([anna(agreements.manual, "AGR-120", "manual"), anna(agreements.cancelled, "AGR-121", "monthly", "cancelled")])
      const subscriptions = { housing: testId(), unpriced: testId(), draft: testId(), manual: testId(), cancelled: testId() }
      const sold = (id: string, agreementId: string, productId = products.hire) => ({ id, companyId, projectId: copenhagen, agreementId, productId, propertyId: ex.properties.havnegade.id, quantity: 1, validFrom: "2026-01-01" })
      await tx.insert(subscription).values([
        sold(subscriptions.housing, fx.agreements.housingDkk.id),
        sold(subscriptions.unpriced, fx.agreements.anna.id, products.unpriced),
        sold(subscriptions.draft, fx.agreements.draft.id),
        sold(subscriptions.manual, agreements.manual),
        sold(subscriptions.cancelled, agreements.cancelled),
      ])
      // Paused from the 10th to the 20th of October: a hire's days run on, since the skip still stands there.
      await tx.insert(subscriptionPause).values({ id: testId(), companyId, projectId: copenhagen, subscriptionId: subscriptions.housing, validFrom: "2026-10-10", validTo: "2026-10-21" })
      const skips = Object.fromEntries(CASES.map((name) => [name, testId()])) as Record<Case, string>
      await tx.insert(container).values(CASES.map((name, index) => ({ id: skips[name], companyId, projectId: copenhagen, label: `SKIP-${index + 1}`, containerTypeId: name === "whole" ? skipType : ex.containerTypes.bin.id, ownership: "company" })))
      const placed = (name: Case, subscriptionId: string, validFrom: string, validTo: string | null = null) => ({ id: placements[name], companyId, projectId: copenhagen, containerId: skips[name], subscriptionId, wasteFractionId: ex.fractions.residual.id, validFrom, validTo })
      await tx.insert(containerServicePlacement).values([
        placed("whole", subscriptions.housing, "2026-09-25"),
        placed("returned", subscriptions.housing, "2026-10-03", "2026-10-13"),
        placed("late", subscriptions.housing, "2026-10-28"),
        placed("unpriced", subscriptions.unpriced, "2026-10-01"),
        placed("draft", subscriptions.draft, "2026-10-01"),
        placed("manual", subscriptions.manual, "2026-10-01"),
        placed("cancelled", subscriptions.cancelled, "2026-10-01"),
      ])
    })
    const app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => clock })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
  })

  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  const period = (periodFrom: string, periodTo: string) => ({ projectId: copenhagen, periodFrom, periodTo })
  const october = () => period("2026-10-01", "2026-10-31")
  const run = async (body: Record<string, unknown>): Promise<BillingRunDetail> => created(olivia, "/billing-runs", await olivia("/billing-runs", { method: "POST", body }), BillingRunDetail)
  const preview = async (body: Record<string, unknown>): Promise<BillingRunPreview> => {
    const response = await olivia("/billing-runs/preview", { method: "POST", body })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return BillingRunPreview.parse(await response.json())
  }

  /** Every hire of the company, by case and month, as the table holds it. */
  const hires = (from?: readonly string[]) =>
    withCompany(pool.db, a.companyId, async (tx: Tx) =>
      (
        await tx
          .select({
            id: billableEvent.id,
            placementId: billableEvent.placementId,
            containerId: billableEvent.containerId,
            subscriptionId: billableEvent.subscriptionId,
            periodFrom: billableEvent.chargePeriodFrom,
            periodTo: billableEvent.chargePeriodTo,
            days: billableEvent.chargedDays,
            of: billableEvent.periodDays,
            quantity: billableEvent.quantity,
            serviceDate: billableEvent.serviceDate,
            unit: billableEvent.unitPriceMinor,
            net: billableEvent.netMinor,
            vat: billableEvent.vatMinor,
            block: billableEvent.blockReason,
            createdBy: billableEvent.createdBy,
            sourceEventId: billableEvent.sourceEventId,
          })
          .from(billableEvent)
          .where(and(eq(billableEvent.companyId, a.companyId), eq(billableEvent.kind, "hire"), from === undefined ? undefined : inArray(billableEvent.chargePeriodFrom, [...from])))
          .orderBy(asc(billableEvent.chargePeriodFrom), asc(billableEvent.placementId))
      ).map((row) => ({ ...row, case: caseOf(row.placementId) })),
    )
  const readings = async (from?: readonly string[]) => (await hires(from)).map(({ case: name, periodFrom, days, of, quantity, serviceDate, unit, net, vat, block }) => ({ case: name, periodFrom, days, of, quantity, serviceDate, unit, net, vat, block }))
  const priced = (name: Case, periodFrom: string, days: number, of: number, serviceDate: string, unit: number, net: number, vat: number) => ({ case: name, periodFrom, days, of, quantity: days, serviceDate, unit, net, vat, block: null })
  const blocked = (name: Case, periodFrom: string, days: number, of: number, serviceDate: string, block: string) => ({ case: name, periodFrom, days, of, quantity: days, serviceDate, unit: null, net: null, vat: null, block })
  const byCase = <T extends { case: Case }>(rows: T[]): T[] => [...rows].sort((x, y) => CASES.indexOf(x.case) - CASES.indexOf(y.case))

  test("a preview plans October's hires and writes nothing; the run then mints and invoices exactly what it planned", async () => {
    const planned = await preview(october())
    assert.deepEqual(await hires(), [], "a preview mints nothing")
    // The housing association's two priced hires on one invoice; Anna's unpriced hire and Bo's draft block, and both are excluded.
    const excluded = [fx.customers.anna.id, fx.customers.bo.id].sort()
    assert.deepEqual(planned, {
      eventCount: 2,
      invoiceCount: 1,
      totals: [{ currency: "DKK", netMinor: 178_500, vatMinor: 44_625 }],
      exclusions: excluded.map((customerId) => ({ customerId, eventCount: 1, reason: "all-events-blocked" })),
    })
    const done = await run(october())
    assert.deepEqual(
      { eventCount: done.eventCount, invoiceCount: done.invoiceCount, netMinor: done.netMinor, vatMinor: done.vatMinor, exclusions: done.exclusions.map(({ customerId, eventCount }) => ({ customerId, eventCount })) },
      { eventCount: 2, invoiceCount: 1, netMinor: 178_500, vatMinor: 44_625, exclusions: excluded.map((customerId) => ({ customerId, eventCount: 1 })) },
      "the run is what its preview said",
    )
  })

  test("charges each placement its days on site in the month, in arrears, the first seven free across the months, at the day's price for its container's type — a pause stops nothing, and a manual cadence or a cancelled agreement is charged nothing", async () => {
    assert.deepEqual(byCase(await readings()), [
      // On site since 25 September, free to 1 October: 30 days at the 10 m³ skip's 55.00 kr, the pause notwithstanding.
      priced("whole", "2026-10-01", 30, 31, "2026-10-02", 5_500, 165_000, 41_250),
      // 3 to 12 October: ten days, seven of them free.
      priced("returned", "2026-10-01", 3, 31, "2026-10-10", 4_500, 13_500, 3_375),
      // No free days, no row: blocked for the office to price.
      blocked("unpriced", "2026-10-01", 31, 31, "2026-10-01", "no-price-row"),
      blocked("draft", "2026-10-01", 24, 31, "2026-10-08", "agreement-draft"),
    ])
    const rows = await hires()
    assert.ok(rows.every((row) => row.createdBy === null && row.sourceEventId === null), "the run's own: no person and no outbox event")
    assert.ok(rows.every((row) => row.containerId !== null), "a hire names its container beside its placement")
  })

  test("invoices a hire as a line of its product, its month by its first and last days and the days charged, the days its quantity", async () => {
    const [issued] = await withCompany(pool.db, a.companyId, (tx: Tx) => tx.execute<{ id: string }>(sql`select id from wms.invoice where company_id = ${a.companyId} and customer_id = ${fx.customers.housing.id}`))
    const response = await olivia(`/invoices/${issued.id}`)
    assert.equal(response.status, 200)
    const invoice = InvoiceDetail.parse(await response.json())
    assert.deepEqual(
      invoice.lines.map((line) => [line.description, line.serviceDate, line.quantity, line.unitPriceMinor, line.netMinor]),
      [
        ["Containerleje · 2026-10-01 – 2026-10-31 · 30 of 31 days", "2026-10-02", 30, 5_500, 165_000],
        ["Containerleje · 2026-10-01 – 2026-10-31 · 3 of 31 days", "2026-10-10", 3, 4_500, 13_500],
      ],
    )
  })

  test("charges no day twice: October again mints and invoices nothing, and November charges November alone — the late skip's free days run out on the 4th", async () => {
    const before = await hires()
    const again = await run(october())
    assert.equal(again.invoiceCount, 0)
    assert.deepEqual(await hires(), before, "nothing minted")
    // Asked on the 20th, November has not ended: no day still to come is charged, and the month waits for a run once it has.
    clock = ON.november20
    assert.equal((await preview(period("2026-11-01", "2026-11-30"))).eventCount, 0)
    clock = ON.december2
    const november = await run(period("2026-11-01", "2026-11-30"))
    assert.deepEqual(byCase(await readings(["2026-11-01"])), [
      priced("whole", "2026-11-01", 30, 30, "2026-11-01", 5_500, 165_000, 41_250),
      priced("late", "2026-11-01", 27, 30, "2026-11-04", 4_500, 121_500, 30_375),
      blocked("unpriced", "2026-11-01", 30, 30, "2026-11-01", "no-price-row"),
      blocked("draft", "2026-11-01", 30, 30, "2026-11-01", "agreement-draft"),
    ])
    assert.deepEqual([november.eventCount, november.invoiceCount, november.netMinor], [2, 1, 286_500])
    const keys = (await hires()).map((row) => `${row.placementId}/${row.periodFrom}`)
    assert.equal(new Set(keys).size, keys.length, "one hire per placement and month")
  })

  test("prices a blocked hire again as the run priced it: its stored days at the day's price, under its container's type", async () => {
    await withCompany(pool.db, a.companyId, (tx: Tx) => tx.insert(priceListRow).values({ id: testId(), companyId: a.companyId, projectId: copenhagen, priceListId: fx.priceLists.default.id, productId: products.unpriced, unitPriceMinor: 2_000, validFrom: "2026-01-01" }))
    const [unpriced] = (await hires(["2026-10-01"])).filter((row) => row.case === "unpriced")
    const response = await olivia(`/billable-events/${unpriced.id}/reprice`, { method: "POST", body: {} })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    const repriced = BillableEvent.parse(await response.json())
    assert.deepEqual(
      [repriced.kind, repriced.status, repriced.quantity, repriced.unitPriceMinor, repriced.netMinor, repriced.vatMinor, repriced.charge],
      ["hire", "ready", 31, 2_000, 62_000, 15_500, { periodFrom: "2026-10-01", periodTo: "2026-11-01", chargedDays: 31, periodDays: 31 }],
    )
  })

  test("a run over part of a month invoices the month it charges, though its first day charged falls before the run's period", async () => {
    // A skip from 2 to 20 January 2027: 12 days charged after its free week, the first on the 9th.
    const mid = { container: testId(), placement: testId() }
    await withCompany(pool.db, a.companyId, async (tx: Tx) => {
      const [{ subscriptionId }] = await tx.select({ subscriptionId: containerServicePlacement.subscriptionId }).from(containerServicePlacement).where(eq(containerServicePlacement.id, placements.whole))
      await tx.insert(container).values({ id: mid.container, companyId: a.companyId, projectId: copenhagen, label: "SKIP-8", containerTypeId: ex.containerTypes.bin.id, ownership: "company" })
      await tx.insert(containerServicePlacement).values({ id: mid.placement, companyId: a.companyId, projectId: copenhagen, containerId: mid.container, subscriptionId, wasteFractionId: ex.fractions.residual.id, validFrom: "2027-01-02", validTo: "2027-01-21" })
    })
    clock = ON.february20
    const done = await run(period("2027-01-15", "2027-02-14"))
    // January for the 10 m³ skip, the late one and the mid one, and Anna's crane skip now its product has a row; Bo's still blocked.
    assert.deepEqual([done.eventCount, done.invoiceCount, done.netMinor], [4, 2, 426_000])
    const [issued] = await withCompany(pool.db, a.companyId, (tx: Tx) => tx.execute<{ id: string }>(sql`select id from wms.invoice where company_id = ${a.companyId} and customer_id = ${fx.customers.housing.id} and period_from = '2027-01-15'`))
    const response = await olivia(`/invoices/${issued.id}`)
    const invoice = InvoiceDetail.parse(await response.json())
    // The two whole months share a day and a product, so they stand in the placements' id order, which the suite mints at random: compared by amount.
    assert.deepEqual(
      invoice.lines.map((line) => [line.description, line.serviceDate, line.quantity, line.netMinor]).sort((x, y) => String(x[1]).localeCompare(String(y[1])) || Number(y[3]) - Number(x[3])),
      [
        ["Containerleje · 2027-01-01 – 2027-01-31", "2027-01-01", 31, 170_500],
        ["Containerleje · 2027-01-01 – 2027-01-31", "2027-01-01", 31, 139_500],
        ["Containerleje · 2027-01-01 – 2027-01-31 · 12 of 31 days", "2027-01-09", 12, 54_000],
      ],
    )
  })

  test("a hire product keeps its day while it has free days: a patch to another unit is refused at the field, the database's check never reached", async () => {
    const response = await olivia(`/products/${products.hire}`, { method: "PATCH", body: { unit: "month" } })
    assert.equal(response.status, 400)
    assert.deepEqual((await readProblem(response)).errors, [{ path: "unit", message: FREE_DAYS_KEEP_THE_DAY }])
    // Nor is a hire product a ticket's work: a billing run charges it by its days.
    const charged = await olivia("/ticket-charges", { method: "PUT", body: { projectId: copenhagen, charges: [{ kind: "container-request", productId: products.hire }] } })
    assert.equal(charged.status, 400)
    assert.deepEqual((await readProblem(charged)).errors, [{ path: "charges.0.productId", message: MONTH_PRODUCT_IS_NOT_TICKET_WORK }])
  })

  test("a work order's job blocked for its product takes one sold by the job, and is priced on the office's ad-hoc route, which has no scheme", async () => {
    const adHoc = { route: testId(), pickup: testId(), event: testId() }
    await withCompany(pool.db, a.companyId, async (tx: Tx) => {
      await tx.insert(route).values({ id: adHoc.route, companyId: a.companyId, projectId: copenhagen, routeSchemeId: null, collectionGroupId: null, serviceDate: ex.day, operatingDate: ex.day, status: "planned", number: 990_001 })
      await tx.insert(pickup).values({ id: adHoc.pickup, companyId: a.companyId, projectId: copenhagen, routeId: adHoc.route, containerId: ex.containers.bin1.id, position: 1, status: "planned", origin: "office", service: "wash", propertyId: ex.properties.parkvej.id, wasteFractionId: ex.fractions.residual.id })
      // As the worker records a wash mapped to a product it will not charge at.
      await tx.insert(billableEvent).values({ id: adHoc.event, companyId: a.companyId, projectId: copenhagen, kind: "job", serviceDate: ex.day, agreementId: fx.agreements.housingDkk.id, subscriptionId: fx.subscriptions.housingResidual.id, productId: null, quantity: 1, blockReason: "no-product", routeId: adHoc.route, pickupId: adHoc.pickup, sourceEventId: testId() })
    })
    const reprice = (productId: string) => olivia(`/billable-events/${adHoc.event}/reprice`, { method: "POST", body: { productId } })
    const refused = await reprice(fx.products.residual.id)
    assert.equal(refused.status, 400)
    assert.deepEqual((await readProblem(refused)).errors, [{ path: "productId", message: A_JOB_IS_SOLD_BY_THE_JOB }])
    const response = await reprice(products.wash)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    const priced = BillableEvent.parse(await response.json())
    assert.deepEqual([priced.kind, priced.status, priced.productId, priced.unitPriceMinor, priced.netMinor, priced.vatMinor], ["job", "ready", products.wash, 30_000, 30_000, 7_500])
  })
})
