import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { BillableEvent } from "@waste/contracts/billable-events"
import { BillingRunDetail, BillingRunPreview } from "@waste/contracts/billing"
import { InvoiceDetail } from "@waste/contracts/invoices"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { mintRecurringCharges } from "@waste/db/commands/recurring-charges"
import { agreement, subscription, subscriptionPause } from "@waste/db/schema/agreements"
import { product } from "@waste/db/schema/catalogue"
import { billableEvent, priceListRow } from "@waste/db/schema/finance"
import { withCompany } from "@waste/db/tenant"
import { and, asc, eq, inArray, sql } from "drizzle-orm"

import { createApp } from "../app"
import { newId } from "../ids"
import { AMOUNT_TOO_LARGE } from "../routes/billable-events"
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

const NOON = new Date("2026-10-05T12:00:00Z")

/** The month-sold subscriptions of the suite, each a case of the rule (#291 C2). */
type Case = "whole" | "late" | "paused" | "quarterly" | "manual" | "cancelled" | "unpriced" | "draft" | "huge"

describe("recurring charges in a billing run", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let ex: ExecutionFixtures
  let fx: BillingFixtures
  let olivia: Call
  let copenhagen: string
  const products = { rental: testId(), unpriced: testId() }
  const agreements = { quarterly: testId(), manual: testId(), cancelled: testId() }
  const subscriptions = Object.fromEntries((["whole", "late", "paused", "quarterly", "manual", "cancelled", "unpriced", "draft", "huge"] as const).map((name) => [name, testId()])) as Record<Case, string>
  const caseOf = (id: string | null): Case | "pickup" => (Object.entries(subscriptions).find(([, sub]) => sub === id)?.[0] as Case | undefined) ?? "pickup"

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
      // Two products sold by the month: a container's rental at 300.00 kr a month on the default list, and a garden bin no list prices yet.
      await tx.insert(product).values([
        { id: products.rental, companyId, projectId: copenhagen, name: "Container rental", kind: "recurring-service", status: "active", unit: "month", invoiceName: "Containerleje 660 L", vatPercent: 25 },
        { id: products.unpriced, companyId, projectId: copenhagen, name: "Garden bin rental", kind: "recurring-service", status: "active", unit: "month", vatPercent: 25 },
      ])
      await tx.insert(priceListRow).values({ id: testId(), companyId, projectId: copenhagen, priceListId: fx.priceLists.default.id, productId: products.rental, unitPriceMinor: 30_000, validFrom: "2026-01-01" })
      const anna = (id: string, number: string, billingCadence: string, status = "active") => ({ id, companyId, projectId: copenhagen, number, customerId: fx.customers.anna.id, payerCustomerId: fx.customers.anna.id, status, billingCadence, currency: "DKK", validFrom: "2026-01-01" })
      await tx.insert(agreement).values([anna(agreements.quarterly, "AGR-110", "quarterly"), anna(agreements.manual, "AGR-111", "manual"), anna(agreements.cancelled, "AGR-112", "monthly", "cancelled")])
      const sold = (name: Case, agreementId: string, options: { productId?: string; quantity?: number; validFrom?: string; propertyId?: string } = {}) => ({
        id: subscriptions[name],
        companyId,
        projectId: copenhagen,
        agreementId,
        productId: options.productId ?? products.rental,
        propertyId: options.propertyId ?? ex.properties.parkvej.id,
        quantity: options.quantity ?? 1,
        validFrom: options.validFrom ?? "2026-01-01",
      })
      // Anna's three rentals under one agreement stand at three places: one product at one place under one agreement is one subscription at a time.
      await tx.insert(subscription).values([
        sold("whole", fx.agreements.housingDkk.id, { quantity: 2 }),
        sold("late", fx.agreements.anna.id, { validFrom: "2026-10-16", propertyId: ex.properties.havnegade.id }),
        sold("paused", fx.agreements.anna.id),
        sold("quarterly", agreements.quarterly),
        sold("manual", agreements.manual),
        sold("cancelled", agreements.cancelled),
        sold("unpriced", fx.agreements.anna.id, { productId: products.unpriced, validFrom: "2026-10-11" }),
        sold("draft", fx.agreements.draft.id),
        // 80 000 rentals at 300.00 kr are 2 400 000 000 øre, past the integer an event holds.
        sold("huge", fx.agreements.anna.id, { quantity: 80_000, propertyId: ex.properties.norrebrogade.id }),
      ])
      // Paused the first week of November: the 8th is the first day served again.
      await tx.insert(subscriptionPause).values({ id: testId(), companyId, projectId: copenhagen, subscriptionId: subscriptions.paused, validFrom: "2026-11-01", validTo: "2026-11-08" })
    })
    const app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOON })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
  })

  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  const period = (periodFrom: string, periodTo: string) => ({ projectId: copenhagen, periodFrom, periodTo })
  const run = async (body: Record<string, unknown>): Promise<BillingRunDetail> => created(olivia, "/billing-runs", await olivia("/billing-runs", { method: "POST", body }), BillingRunDetail)
  const preview = async (body: Record<string, unknown>): Promise<BillingRunPreview> => {
    const response = await olivia("/billing-runs/preview", { method: "POST", body })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return BillingRunPreview.parse(await response.json())
  }
  const readInvoice = async (id: string): Promise<InvoiceDetail> => {
    const response = await olivia(`/invoices/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return InvoiceDetail.parse(await response.json())
  }

  /** Every recurring charge of the company, by case and period, as the table holds it. */
  const charges = (from?: readonly string[]) =>
    withCompany(pool.db, a.companyId, async (tx: Tx) =>
      (
        await tx
          .select({
            id: billableEvent.id,
            subscriptionId: billableEvent.subscriptionId,
            periodFrom: billableEvent.chargePeriodFrom,
            periodTo: billableEvent.chargePeriodTo,
            days: billableEvent.chargedDays,
            of: billableEvent.periodDays,
            serviceDate: billableEvent.serviceDate,
            unit: billableEvent.unitPriceMinor,
            net: billableEvent.netMinor,
            vat: billableEvent.vatMinor,
            block: billableEvent.blockReason,
            createdBy: billableEvent.createdBy,
            sourceEventId: billableEvent.sourceEventId,
          })
          .from(billableEvent)
          .where(and(eq(billableEvent.companyId, a.companyId), eq(billableEvent.kind, "subscription"), from === undefined ? undefined : inArray(billableEvent.chargePeriodFrom, [...from])))
          .orderBy(asc(billableEvent.chargePeriodFrom), asc(billableEvent.subscriptionId))
      ).map((row) => ({ ...row, case: caseOf(row.subscriptionId) })),
    )

  /** The month the suite first runs: built once the tenant is, since the project is its. */
  const october = () => period("2026-10-01", "2026-10-31")

  test("a preview plans October's run and writes nothing; the run then mints and invoices exactly what it planned: October never charged and November in advance", async () => {
    const planned = await preview(october())
    assert.deepEqual(await charges(), [], "a preview mints nothing")
    // Seven priced charges for two payers in DKK; Bo's draft agreement blocks both of his, and he is excluded.
    assert.deepEqual(planned, {
      eventCount: 7,
      invoiceCount: 2,
      totals: [{ currency: "DKK", netMinor: 308_484, vatMinor: 77_121 }],
      exclusions: [{ customerId: fx.customers.bo.id, eventCount: 2, reason: "all-events-blocked" }],
    })
    const done = await run(october())
    assert.deepEqual(
      { eventCount: done.eventCount, invoiceCount: done.invoiceCount, netMinor: done.netMinor, vatMinor: done.vatMinor, exclusions: done.exclusions.map(({ customerId, eventCount }) => ({ customerId, eventCount })) },
      { eventCount: planned.eventCount, invoiceCount: planned.invoiceCount, netMinor: 308_484, vatMinor: 77_121, exclusions: [{ customerId: fx.customers.bo.id, eventCount: 2 }] },
      "the run is what its preview said",
    )
  })

  test("charges by the cadence's calendar periods, in advance, prorated by the days in force and not paused, the period's months at the month's price — and nothing for a product sold by the pickup, a manual cadence or a cancelled agreement", async () => {
    const rows = (await charges()).map(({ case: name, periodFrom, periodTo, days, of, serviceDate, unit, net, vat, block }) => ({ case: name, periodFrom, periodTo, days, of, serviceDate, unit, net, vat, block }))
    const priced = (name: Case, periodFrom: string, periodTo: string, days: number, of: number, serviceDate: string, unit: number, net: number, vat: number) => ({ case: name, periodFrom, periodTo, days, of, serviceDate, unit, net, vat, block: null })
    const blocked = (name: Case, periodFrom: string, periodTo: string, days: number, of: number, serviceDate: string, block: string) => ({ case: name, periodFrom, periodTo, days, of, serviceDate, unit: null, net: null, vat: null, block })
    const expected = [
      priced("whole", "2026-10-01", "2026-11-01", 31, 31, "2026-10-01", 30_000, 60_000, 15_000),
      // From the 16th: 16 of 31 days, 15 483.87 øre rounded half away from zero.
      priced("late", "2026-10-01", "2026-11-01", 16, 31, "2026-10-16", 15_484, 15_484, 3_871),
      priced("paused", "2026-10-01", "2026-11-01", 31, 31, "2026-10-01", 30_000, 30_000, 7_500),
      // A quarter is three months, charged whole by the run whose window touches its first day.
      priced("quarterly", "2026-10-01", "2027-01-01", 92, 92, "2026-10-01", 90_000, 90_000, 22_500),
      blocked("unpriced", "2026-10-01", "2026-11-01", 21, 31, "2026-10-11", "no-price-row"),
      blocked("draft", "2026-10-01", "2026-11-01", 31, 31, "2026-10-01", "agreement-draft"),
      blocked("huge", "2026-10-01", "2026-11-01", 31, 31, "2026-10-01", "amount-too-large"),
      priced("whole", "2026-11-01", "2026-12-01", 30, 30, "2026-11-01", 30_000, 60_000, 15_000),
      priced("late", "2026-11-01", "2026-12-01", 30, 30, "2026-11-01", 30_000, 30_000, 7_500),
      // Paused to the 8th: 23 of 30 days, priced on the first of them.
      priced("paused", "2026-11-01", "2026-12-01", 23, 30, "2026-11-08", 23_000, 23_000, 5_750),
      blocked("unpriced", "2026-11-01", "2026-12-01", 30, 30, "2026-11-01", "no-price-row"),
      blocked("draft", "2026-11-01", "2026-12-01", 30, 30, "2026-11-01", "agreement-draft"),
      blocked("huge", "2026-11-01", "2026-12-01", 30, 30, "2026-11-01", "amount-too-large"),
    ]
    const order = (row: { periodFrom: string | null; case: string }) => `${row.periodFrom}/${Object.keys(subscriptions).indexOf(row.case)}`
    assert.deepEqual([...rows].sort((x, y) => order(x).localeCompare(order(y))), [...expected].sort((x, y) => order(x).localeCompare(order(y))))
    // The run's own: no person and no outbox event.
    assert.ok((await charges()).every((row) => row.createdBy === null && row.sourceEventId === null))
  })

  test("invoices a charge as a line of its product, its charge period by its first and last days, and how many of its days where it charged fewer", async () => {
    const [done] = await withCompany(pool.db, a.companyId, (tx: Tx) => tx.execute<{ id: string }>(sql`select id from wms.invoice where company_id = ${a.companyId} and customer_id = ${fx.customers.anna.id}`))
    const invoice = await readInvoice(done.id)
    assert.deepEqual(
      invoice.lines.map((line) => [line.description, line.serviceDate, line.quantity, line.unitPriceMinor, line.netMinor]),
      [
        ["Containerleje 660 L · 2026-10-01 – 2026-10-31", "2026-10-01", 1, 30_000, 30_000],
        ["Containerleje 660 L · 2026-10-01 – 2026-10-31 · 16 of 31 days", "2026-10-16", 1, 15_484, 15_484],
        ["Containerleje 660 L · 2026-11-01 – 2026-11-30", "2026-11-01", 1, 30_000, 30_000],
        ["Containerleje 660 L · 2026-11-01 – 2026-11-30 · 23 of 30 days", "2026-11-08", 1, 23_000, 23_000],
        ["Containerleje 660 L · 2026-10-01 – 2026-12-31", "2026-10-01", 1, 90_000, 90_000],
      ],
      "AGR-102's lines by service date, then AGR-110's quarter",
    )
  })

  test("charges nothing twice: October again mints and invoices nothing, and November mints December alone, the quarter already charged", async () => {
    const before = await charges()
    const again = await run(october())
    assert.equal(again.invoiceCount, 0)
    assert.deepEqual(await charges(), before, "nothing minted")
    const november = await run(period("2026-11-01", "2026-11-30"))
    const december = await charges(["2026-12-01"])
    assert.deepEqual(december.map((row) => [row.case, row.days, row.of, row.net, row.block]).sort(), [
      ["draft", 31, 31, null, "agreement-draft"],
      ["huge", 31, 31, null, "amount-too-large"],
      ["late", 31, 31, 30_000, null],
      ["paused", 31, 31, 30_000, null],
      ["unpriced", 31, 31, null, "no-price-row"],
      ["whole", 31, 31, 60_000, null],
    ])
    assert.equal((await charges()).length, before.length + 6)
    assert.deepEqual([november.eventCount, november.invoiceCount, november.netMinor], [3, 2, 120_000], "December's three priced charges; November's were invoiced in October")
  })

  test("prices a blocked charge again as the run priced it — one month on its first day charged, prorated to its stored days — and refuses one still past what an event holds", async () => {
    await withCompany(pool.db, a.companyId, (tx: Tx) => tx.insert(priceListRow).values({ id: testId(), companyId: a.companyId, projectId: copenhagen, priceListId: fx.priceLists.default.id, productId: products.unpriced, unitPriceMinor: 12_000, validFrom: "2026-01-01" }))
    const [unpriced] = (await charges(["2026-10-01"])).filter((row) => row.case === "unpriced")
    const response = await olivia(`/billable-events/${unpriced.id}/reprice`, { method: "POST", body: {} })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    const repriced = BillableEvent.parse(await response.json())
    // 21 of October's 31 days of 120.00 kr: 8 129.03 øre.
    assert.deepEqual([repriced.status, repriced.unitPriceMinor, repriced.netMinor, repriced.vatMinor, repriced.charge], ["ready", 8_129, 8_129, 2_032, { periodFrom: "2026-10-01", periodTo: "2026-11-01", chargedDays: 21, periodDays: 31 }])
    const [huge] = (await charges(["2026-10-01"])).filter((row) => row.case === "huge")
    const refused = await olivia(`/billable-events/${huge.id}/reprice`, { method: "POST", body: {} })
    assert.equal(refused.status, 409)
    assert.equal((await readProblem(refused)).detail, AMOUNT_TOO_LARGE)
  })

  test("serialises two runs of one project on the project's lock: one mints and invoices, the other finds every charge minted and invoiced", async () => {
    const march = period("2027-03-01", "2027-03-31")
    const [first, second] = await Promise.all([olivia("/billing-runs", { method: "POST", body: march }), olivia("/billing-runs", { method: "POST", body: march })])
    assert.deepEqual([first.status, second.status], [201, 201])
    const counts = [BillingRunDetail.parse(await first.json()).eventCount, BillingRunDetail.parse(await second.json()).eventCount].sort((x, y) => x - y)
    // March and April for the five monthly cases priced now, the garden bin included; the first and second quarters of 2027.
    assert.deepEqual(counts, [0, 10])
    const minted = await charges(["2027-01-01", "2027-03-01", "2027-04-01"])
    const keys = minted.map((row) => `${row.subscriptionId}/${row.periodFrom}`)
    assert.equal(new Set(keys).size, keys.length, "one charge per subscription and period")
    assert.equal(minted.length, 14, "the six monthly cases twice and the quarterly twice")
  })

  test("holds one charge per subscription and period without the project's lock too: a second mint racing the first waits on the index and writes nothing", async () => {
    const june = { periodFrom: "2027-06-01", periodTo: "2027-06-30" }
    const scope = { companyId: a.companyId, projectId: copenhagen }
    let release = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    let minted = () => {}
    const mintedOnce = new Promise<void>((resolve) => (minted = resolve))
    const first = withCompany(pool.db, a.companyId, async (tx: Tx) => {
      const written = await mintRecurringCharges(tx, scope, june, newId)
      minted()
      await held
      return written
    })
    await mintedOnce
    const second = withCompany(pool.db, a.companyId, (tx: Tx) => mintRecurringCharges(tx, scope, june, newId))
    // The second plans what the first has not committed, so its insert waits on the first's keys.
    let waited = false
    for (let tries = 0; tries < 50 && !waited; tries += 1) {
      const [waiting] = await pool.db.execute<{ waiting: number }>(sql`select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike 'insert into "wms"."billable_event"%'`)
      waited = waiting.waiting > 0
      if (!waited) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    release()
    const [one, other] = await Promise.all([first, second])
    assert.ok(waited, "the second's insert waited on the first's uncommitted keys")
    assert.ok(one > 0)
    assert.equal(other, 0, "every row the second planned met the first's on the index")
    assert.equal((await charges(["2027-06-01", "2027-07-01"])).length, one)
  })
})
