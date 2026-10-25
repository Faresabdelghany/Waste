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
// has ended is refused, and once ended November alone; a blocked
// hire is repriced as the run priced it, a hire product keeps its day, and a
// work order's job blocked for its product takes one sold by the job, priced
// on the office's ad-hoc route under no scheme. Skipped with the
// reason when `DATABASE_URL` or `DATABASE_ADMIN_URL` is unset, failed under
// `REQUIRE_DATABASE`.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { BillableEvent } from "@waste/contracts/billable-events"
import { FREE_DAYS_ARE_A_HIRES, Product } from "@waste/contracts/catalogue"
import { BillingRunDetail, BillingRunPreview, PERIOD_ENDS_BY_TODAY } from "@waste/contracts/billing"
import { InvoiceDetail } from "@waste/contracts/invoices"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { agreement, subscription, subscriptionPause } from "@waste/db/schema/agreements"
import { containerType, product } from "@waste/db/schema/catalogue"
import { container, containerServicePlacement } from "@waste/db/schema/containers"
import { pickup, route } from "@waste/db/schema/execution"
import { billableEvent, priceListRow } from "@waste/db/schema/finance"
import { withCompany } from "@waste/db/tenant"
import { and, asc, eq, inArray, sql } from "drizzle-orm"

import { HELD_FOR_REVIEW } from "@waste/db/commands/billable-writes"

import { createApp } from "../app"
import { FREE_DAYS_KEEP_THE_DAY } from "../routes/products"
import { MONTH_PRODUCT_IS_NOT_TICKET_WORK } from "../routes/ticket-charges"
import { A_JOB_IS_SOLD_BY_THE_JOB } from "../routes/work-order-charges"
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
  /** The named case a hire is of; null for a placement a test adds of its own. */
  const caseOf = (id: string | null): Case | null => CASES.find((name) => placements[name] === id) ?? null

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
  const byCase = <T extends { case: Case | null }>(rows: T[]): T[] => [...rows].filter((row) => row.case !== null).sort((x, y) => CASES.indexOf(x.case as Case) - CASES.indexOf(y.case as Case))

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
      heldEventCount: 0,
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
    // Asked on the 20th, November has not ended: a run over it is refused, since a run is for a closed period, and the month waits for a run once it has.
    clock = ON.november20
    const early = await olivia("/billing-runs", { method: "POST", body: period("2026-11-01", "2026-11-30") })
    assert.equal(early.status, 400)
    assert.deepEqual((await readProblem(early)).errors, [{ path: "periodTo", message: PERIOD_ENDS_BY_TODAY }])
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

  test("a month a run to a day before it ended left undue is charged by the next run, and a month whose charge the office cancelled is never charged again", async () => {
    // A skip from 1 March 2027 under the housing association's hire, its free week spent on the 7th.
    const march = { container: testId(), placement: testId() }
    await withCompany(pool.db, a.companyId, async (tx: Tx) => {
      const [{ subscriptionId }] = await tx.select({ subscriptionId: containerServicePlacement.subscriptionId }).from(containerServicePlacement).where(eq(containerServicePlacement.id, placements.whole))
      await tx.insert(container).values({ id: march.container, companyId: a.companyId, projectId: copenhagen, label: "SKIP-9", containerTypeId: ex.containerTypes.bin.id, ownership: "company" })
      await tx.insert(containerServicePlacement).values({ id: march.placement, companyId: a.companyId, projectId: copenhagen, containerId: march.container, subscriptionId, wasteFractionId: ex.fractions.residual.id, validFrom: "2027-03-01" })
    })
    const hiresOf = async (placementId: string) => (await hires()).filter((row) => row.placementId === placementId).map((row) => [row.periodFrom, row.days, row.net, row.block])
    // A run to the 25th of March, on the 25th: March has not ended, so nothing of it is charged.
    clock = new Date("2027-03-25T12:00:00Z")
    await run(period("2027-03-01", "2027-03-25"))
    assert.deepEqual(await hiresOf(march.placement), [])
    // The run over the rest of March and April, asked once April has ended, charges March — left to it — and April, and invoices both.
    clock = new Date("2027-05-01T12:00:00Z")
    const april = await run(period("2027-03-26", "2027-04-30"))
    assert.deepEqual(await hiresOf(march.placement), [["2027-03-01", 24, 108_000, null], ["2027-04-01", 30, 135_000, null]])
    const invoicedHere = await withCompany(pool.db, a.companyId, (tx: Tx) =>
      tx.execute<{ count: number }>(sql`select count(*)::int as count from wms.invoice_line l join wms.billable_event e on e.company_id = l.company_id and e.id = l.billable_event_id where l.company_id = ${a.companyId} and e.placement_id = ${march.placement}`),
    )
    assert.equal(invoicedHere[0].count, 2, "both on the run's invoice")
    assert.ok(april.eventCount >= 2)

    // Bo's draft January hire, blocked, cancelled by the office: the cancel stands — a run over January again keeps it, as a recurring charge's key does (#291 C2), and a month cancelled by mistake is entered again by hand.
    const [draftJanuary] = (await hires(["2027-01-01"])).filter((row) => row.case === "draft")
    const cancelled = await olivia(`/billable-events/${draftJanuary.id}/cancel`, { method: "POST", body: { reason: "other", note: "Days counted wrong" } })
    assert.equal(cancelled.status, 200, JSON.stringify(await cancelled.clone().json()))
    await run(period("2027-01-15", "2027-02-14"))
    const draftMonths = (await hires(["2027-01-01"])).filter((row) => row.case === "draft")
    assert.deepEqual(draftMonths.map((row) => row.id), [draftJanuary.id], "no second charge of the month")
  })

  test("a hire product carries its free days on the wire: set on a create and a patch, a product sold by anything but the day refused them at the field, and cleared before it leaves the day", async () => {
    const body = { projectId: copenhagen, name: "Roll-off hire", kind: "recurring-service", status: "active", unit: "day", vatPercent: 25, freeDays: 14 }
    const made = await olivia("/products", { method: "POST", body })
    assert.equal(made.status, 201, JSON.stringify(await made.clone().json()))
    const rollOff = Product.parse(await made.json())
    assert.deepEqual([rollOff.unit, rollOff.freeDays], ["day", 14])
    assert.equal(Product.parse(await (await olivia(`/products/${products.hire}`)).json()).freeDays, 7, "the suite's skip hire reads its seven")
    const notAHire = await olivia("/products", { method: "POST", body: { ...body, name: "Wash with free days", unit: "job" } })
    assert.equal(notAHire.status, 400)
    assert.deepEqual((await readProblem(notAHire)).errors, [{ path: "freeDays", message: FREE_DAYS_ARE_A_HIRES }])
    const patched = await olivia(`/products/${rollOff.id}`, { method: "PATCH", body: { freeDays: 10 } })
    assert.equal(Product.parse(await patched.json()).freeDays, 10)
    const onAPickup = await olivia(`/products/${fx.products.residual.id}`, { method: "PATCH", body: { freeDays: 3 } })
    assert.equal(onAPickup.status, 400)
    assert.deepEqual((await readProblem(onAPickup)).errors, [{ path: "freeDays", message: FREE_DAYS_ARE_A_HIRES }])
    const cleared = await olivia(`/products/${rollOff.id}`, { method: "PATCH", body: { freeDays: null, unit: "month" } })
    assert.equal(cleared.status, 200, JSON.stringify(await cleared.clone().json()))
    assert.deepEqual([Product.parse(await cleared.json()).unit, (await olivia(`/products/${rollOff.id}`).then((response) => response.json()) as { freeDays: number | null }).freeDays], ["month", null], "cleared with the unit's move, in one patch")
  })

  test("a project that holds its hires for review has each priced hire written held with no person, which a run passes over and its preview counts, until the office releases it", async () => {
    const patched = await olivia(`/projects/${copenhagen}`, { method: "PATCH", body: { holdForReview: true } })
    assert.equal(patched.status, 200, JSON.stringify(await patched.clone().json()))
    assert.equal(((await patched.json()) as { holdForReview: boolean }).holdForReview, true)
    try {
      clock = new Date("2027-07-02T12:00:00Z")
      const june = period("2027-06-01", "2027-06-30")
      const previewed = await preview(june)
      const done = await run(june)
      // The run over June charges May too, the month before it, which no earlier run reached.
      const minted = (await hires(["2027-05-01", "2027-06-01"])).filter((row) => row.block === null)
      assert.ok(minted.length > 0)
      const events = await Promise.all(minted.map(async (row) => BillableEvent.parse(await (await olivia(`/billable-events/${row.id}`)).json())))
      assert.ok(events.every((event) => event.status === "held" && event.hold?.by === null && event.hold.reason === HELD_FOR_REVIEW), "held by the project, with its reason")
      assert.equal(done.eventCount, 0, "the run passes over every held hire")
      // The preview told it before the run minted a hire: each priced one counted held, none ready, as the run then wrote them.
      assert.deepEqual([previewed.eventCount, previewed.heldEventCount], [0, minted.length])
      assert.equal((await preview(june)).heldEventCount, minted.length)
      // Released, the next run over the month invoices it.
      const released = await olivia(`/billable-events/${events[0].id}/release`, { method: "POST", body: {} })
      assert.equal(BillableEvent.parse(await released.json()).status, "ready")
      assert.equal((await run(june)).eventCount, 1)
    } finally {
      await olivia(`/projects/${copenhagen}`, { method: "PATCH", body: { holdForReview: false } })
    }
  })

  test("a job blocked as it was charged is held once the office prices it, where its project holds its jobs for review", async () => {
    const blockedJob = { route: testId(), pickup: testId(), event: testId() }
    await withCompany(pool.db, a.companyId, async (tx: Tx) => {
      await tx.insert(route).values({ id: blockedJob.route, companyId: a.companyId, projectId: copenhagen, routeSchemeId: null, collectionGroupId: null, serviceDate: ex.day, operatingDate: ex.day, status: "planned", number: 990_002 })
      await tx.insert(pickup).values({ id: blockedJob.pickup, companyId: a.companyId, projectId: copenhagen, routeId: blockedJob.route, containerId: ex.containers.bin1.id, position: 1, status: "planned", origin: "office", service: "wash", propertyId: ex.properties.parkvej.id, wasteFractionId: ex.fractions.residual.id })
      await tx.insert(billableEvent).values({ id: blockedJob.event, companyId: a.companyId, projectId: copenhagen, kind: "job", serviceDate: ex.day, agreementId: fx.agreements.housingDkk.id, subscriptionId: fx.subscriptions.housingResidual.id, productId: null, quantity: 1, blockReason: "no-product", routeId: blockedJob.route, pickupId: blockedJob.pickup, sourceEventId: testId() })
    })
    assert.equal((await olivia(`/projects/${copenhagen}`, { method: "PATCH", body: { holdForReview: true } })).status, 200)
    try {
      const response = await olivia(`/billable-events/${blockedJob.event}/reprice`, { method: "POST", body: { productId: products.wash } })
      assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
      const priced = BillableEvent.parse(await response.json())
      assert.deepEqual([priced.status, priced.netMinor, priced.hold?.by, priced.hold?.reason], ["held", 30_000, null, HELD_FOR_REVIEW])
    } finally {
      await olivia(`/projects/${copenhagen}`, { method: "PATCH", body: { holdForReview: false } })
    }
  })
})
