import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { BillableEvent } from "@waste/contracts/billable-events"
import { BillingRunDetail, PERIOD_ENDS_BY_TODAY } from "@waste/contracts/billing"
import { InvoiceDetail } from "@waste/contracts/invoices"
import { type Database, type Tx } from "@waste/db/client"
import { customer } from "@waste/db/schema/customers"
import { withCompany } from "@waste/db/tenant"
import { and, eq } from "drizzle-orm"

import { pickupEvent, reversalEvent, type BillingFixtures } from "./billing-fixtures"
import { billingRunCalls, NOON, setUpBillingRuns, tearDownBillingRuns, type BillingRunSuite } from "./billing-run-suite"
import { type Call } from "./calls"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { type ExecutionFixtures } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { type Tenant } from "./tenant"

const database = databaseUnderTest()
/** The owner sweeps the proofs the fixtures append and the invoices and lines the runs write, which `wms_api` may not delete. */
const owner = ownerUnderTest()

// The ceiling, the lock and the scope are billing-run-ceiling.test.ts, the batches billing-run-batches.test.ts (#329).
describe("the billing run endpoints", { skip: database.skip || owner.skip }, () => {
  let suite: BillingRunSuite
  let pool: Database
  let a: Tenant
  let ex: ExecutionFixtures
  let fx: BillingFixtures
  let olivia: Call
  let lars: Call
  let copenhagen: string

  before(async () => {
    suite = await setUpBillingRuns(database.url, owner.url)
    ;({ pool, a, ex, fx, olivia, lars, copenhagen } = suite)
  })

  after(() => tearDownBillingRuns(suite))

  const { refused, manual, entered, readEvent, readInvoice, period, run, preview, eventsAbout, written } = billingRunCalls(() => suite)

  describe("held for review (M14 of #293)", () => {
    test("excludes a payer whose events are all held, or each blocked or held, with the reason its events give: the preview counts the held, and the run writes each exclusion", async () => {
      const day = "2026-11-16"
      const hold = async (event: BillableEvent) => assert.equal((await olivia(`/billable-events/${event.id}/hold`, { method: "POST", body: { reason: "Checked with the customer" } })).status, 200)
      await hold(await entered(manual({ agreementId: fx.agreements.anna.id, serviceDate: day })))
      await hold(await entered(manual({ serviceDate: day })))
      const blocked = await entered(manual({ agreementId: fx.agreements.housingEur.id, productId: fx.products.bulky.id, serviceDate: day }))
      assert.equal(blocked.status, "blocked")
      await entered(manual({ agreementId: fx.agreements.draft.id, serviceDate: day }))
      const expected = [
        { customerId: fx.customers.anna.id, reason: "all-events-held", eventCount: 1 },
        { customerId: fx.customers.housing.id, reason: "all-events-blocked-or-held", eventCount: 2 },
        { customerId: fx.customers.bo.id, reason: "all-events-blocked", eventCount: 1 },
      ].sort((x, y) => (x.customerId < y.customerId ? -1 : 1))
      const previewed = await preview(period(day))
      assert.deepEqual([previewed.eventCount, previewed.invoiceCount, previewed.heldEventCount, previewed.exclusions], [0, 0, 2, expected])
      const done = await run(period(day))
      assert.deepEqual([done.invoiceCount, done.excludedCustomerCount], [0, 3])
      assert.deepEqual(
        done.exclusions.map(({ customerId, reason, eventCount }) => ({ customerId, reason, eventCount })),
        expected,
      )
    })
  })

  describe("a run over the seeded events", () => {
    /** The events of the Monday: what the run and the preview are proved against. */
    let e1: BillableEvent
    let e2: BillableEvent
    let e3: BillableEvent
    let e4: BillableEvent
    let cancelledLater: BillableEvent

    before(async () => {
      e1 = await pickupEvent(pool, a, fx, ex)
      e2 = await entered(manual({ quantity: 3 }))
      e3 = await entered(manual({ agreementId: fx.agreements.housingEur.id }))
      e4 = await entered(manual({ agreementId: fx.agreements.anna.id }))
      await entered(manual({ agreementId: fx.agreements.draft.id }))
      await entered(manual({ agreementId: fx.agreements.draft.id, quantity: 2 }))
      await entered(manual({ agreementId: fx.agreements.anna.id, serviceDate: "2026-10-20" }))
      cancelledLater = await entered(manual({ agreementId: fx.agreements.anna.id, quantity: 5 }))
      assert.equal((await olivia(`/billable-events/${cancelledLater.id}/cancel`, { method: "POST", body: { reason: "duplicate" } })).status, 200)
      await entered(manual({ agreementId: fx.agreements.housingEur.id, productId: fx.products.bulky.id }))
      // Anna goes inactive before the run: an invoice records delivered work, and no status gates the payer (§7.15).
      await withCompany(pool.db, a.companyId, async (tx: Tx) => {
        await tx.update(customer).set({ status: "inactive" }).where(and(eq(customer.companyId, a.companyId), eq(customer.id, fx.customers.anna.id)))
      })
    })

    test("runs and previews a closed period alone: a period ending after the project's today is refused at periodTo, and one ending today is taken (M14 of #293)", async () => {
      const before = await written()
      // The suite's clock stands at 2027-02-05, Copenhagen's day too.
      for (const path of ["/billing-runs", "/billing-runs/preview"]) {
        const ahead = await olivia(path, { method: "POST", body: period("2027-02-01", "2027-02-06") })
        assert.equal(ahead.status, 400, path)
        assert.deepEqual((await readProblem(ahead)).errors, [{ path: "periodTo", message: PERIOD_ENDS_BY_TODAY }], path)
      }
      assert.deepEqual(await written(), before, "nothing run")
      const today = await olivia("/billing-runs/preview", { method: "POST", body: period("2027-02-01", "2027-02-05") })
      assert.equal(today.status, 200, JSON.stringify(await today.clone().json()))
    })

    test("previews the counts, the totals per currency and the exclusions, and writes nothing", async () => {
      const before = await written()
      const previewed = await preview(period("2026-10-01", "2026-10-10"))
      assert.deepEqual(previewed, {
        eventCount: 4,
        invoiceCount: 3,
        totals: [
          { currency: "DKK", netMinor: 10_000 + 30_000 + 12_000, vatMinor: 2_500 + 7_500 + 3_000 },
          { currency: "EUR", netMinor: 1_600, vatMinor: 400 },
        ],
        exclusions: [{ customerId: fx.customers.bo.id, reason: "all-events-blocked", eventCount: 2 }],
        heldEventCount: 0,
        catchUp: [],
        catchUpDeferredCount: 0,
      })
      assert.deepEqual(await written(), before, "no run, no invoice, no event, no number taken")
      await refused(await lars("/billing-runs/preview", { method: "POST", body: period("2026-10-01", "2026-10-10") }), 400)
    })

    test("issues one invoice per payer and currency with consecutive numbers, the lines in the stated order, the exclusion for the payer whose events are all blocked, the counts and totals, and one invoice-issued per invoice with the detail the read answers", async () => {
      const done = await run(period("2026-10-01", "2026-10-10"))
      assert.deepEqual(
        [done.projectId, done.periodFrom, done.periodTo, done.status, done.requestedBy, done.completedAt, done.eventCount, done.invoiceCount, done.excludedCustomerCount, done.netMinor, done.vatMinor, done.note],
        [copenhagen, "2026-10-01", "2026-10-10", "completed", a.users.olivia.id, NOON.toISOString(), 4, 3, 1, 53_600, 13_400, null],
      )
      assert.deepEqual(done.exclusions.map((exclusion) => [exclusion.billingRunId, exclusion.customerId, exclusion.reason, exclusion.eventCount]), [[done.id, fx.customers.bo.id, "all-events-blocked", 2]])
      assert.equal(done.invoiceIds.length, 3)

      const invoices = await Promise.all(done.invoiceIds.map((id) => readInvoice(id)))
      assert.deepEqual(
        invoices.map((issued) => issued.number),
        [invoices[0].number, invoices[0].number + 1, invoices[0].number + 2],
        "consecutive numbers in numbering order",
      )
      const expectedOrder = [
        { customerId: fx.customers.housing.id, currency: "DKK" },
        { customerId: fx.customers.housing.id, currency: "EUR" },
        { customerId: fx.customers.anna.id, currency: "DKK" },
      ].sort((x, y) => (x.customerId < y.customerId ? -1 : x.customerId > y.customerId ? 1 : x.currency < y.currency ? -1 : 1))
      assert.deepEqual(
        invoices.map((issued) => ({ customerId: issued.customerId, currency: issued.currency })),
        expectedOrder,
        "grouped by payer and currency, numbered by payer then currency",
      )
      for (const issued of invoices) {
        assert.deepEqual(
          [issued.kind, issued.label, issued.projectId, issued.issuedOn, issued.dueOn, issued.periodFrom, issued.periodTo, issued.billingRunId, issued.creditsInvoiceId, issued.creditReason, issued.issuedBy, issued.grossMinor, issued.creditNotes],
          ["invoice", `INV-${issued.number}`, copenhagen, "2027-02-05", "2027-03-07", "2026-10-01", "2026-10-10", done.id, null, null, a.users.olivia.id, issued.netMinor + issued.vatMinor, []],
        )
        assert.deepEqual(issued.lines.map((line) => line.position), issued.lines.map((_, index) => index + 1))
        const outbox = await eventsAbout(issued.id)
        assert.deepEqual(outbox.map((event) => [event.kind, event.aggregateKind, event.projectId, event.occurredAt.toISOString()]), [["invoice-issued", "invoice", copenhagen, NOON.toISOString()]])
        assert.deepEqual(InvoiceDetail.parse(outbox[0].payload), issued, "the payload is the document as the read answers it")
      }

      const housingDkk = invoices.find((issued) => issued.customerId === fx.customers.housing.id && issued.currency === "DKK")!
      assert.deepEqual(
        housingDkk.lines.map((line) => [line.billableEventId, line.description, line.productId, line.serviceDate, line.quantity, line.unitPriceMinor, line.netMinor, line.vatPercent, line.vatMinor, line.creditsLineId]),
        [
          [e1.id, `Restaffald 240 L · ${fx.day}`, fx.products.residual.id, fx.day, 1, 10_000, 10_000, 25, 2_500, null],
          [e2.id, `Restaffald 240 L · ${fx.day}`, fx.products.residual.id, fx.day, 3, 10_000, 30_000, 25, 7_500, null],
        ],
        "one line per event — the pickup's, then the manual one, by event id under one agreement, day and product — with the product's invoice name and the day as its text",
      )
      assert.deepEqual([housingDkk.netMinor, housingDkk.vatMinor, housingDkk.grossMinor], [40_000, 10_000, 50_000])
      const housingEur = invoices.find((issued) => issued.currency === "EUR")!
      assert.deepEqual(housingEur.lines.map((line) => [line.billableEventId, line.netMinor]), [[e3.id, 1_600]])
      const anna = invoices.find((issued) => issued.customerId === fx.customers.anna.id)!
      assert.deepEqual(anna.lines.map((line) => [line.billableEventId, line.netMinor]), [[e4.id, 12_000]], "an inactive customer is still invoiced for the work delivered")

      for (const [event, issued] of [
        [e1, housingDkk],
        [e2, housingDkk],
        [e3, housingEur],
        [e4, anna],
      ] as const) {
        const charged = await readEvent(event.id)
        assert.equal(charged.status, "invoiced")
        assert.equal(charged.invoiceLineId, issued.lines.find((line) => line.billableEventId === event.id)?.id, "the event reads the line that charges for it")
      }
      assert.equal((await readEvent(cancelledLater.id)).status, "cancelled", "a cancelled event is left alone")

      const detail = await olivia(`/billing-runs/${done.id}`)
      assert.equal(detail.status, 200)
      assert.deepEqual(BillingRunDetail.parse(await detail.json()), done, "the read answers what the run answered")
    })

    test("issues nothing on a second run over the same period: the first left nothing ready, and every payer with blocked events and nothing ready is excluded — the housing association now too, its invoiced events counting for nothing here", async () => {
      const again = await run(period("2026-10-01", "2026-10-10"))
      assert.deepEqual([again.status, again.eventCount, again.invoiceCount, again.excludedCustomerCount, again.netMinor, again.vatMinor, again.invoiceIds], ["completed", 0, 0, 2, 0, 0, []])
      assert.deepEqual(
        again.exclusions.map((exclusion) => [exclusion.customerId, exclusion.eventCount]).sort(),
        [
          [fx.customers.bo.id, 2],
          [fx.customers.housing.id, 1],
        ].sort(),
        "Bo's two draft-agreement events, and the housing association's one bulky pickup the EUR list has no row for",
      )
    })

    test("puts a reversal on the payer's next invoice as a negative line — a reversal-only payer getting an invoice with a negative net — and the reversed original stays on its invoice", async () => {
      const reversal = await reversalEvent(pool, a, await readEvent(e1.id))
      assert.deepEqual([reversal.kind, reversal.status, reversal.netMinor, reversal.vatMinor, reversal.links.reversesEventId], ["reversal", "ready", -10_000, -2_500, e1.id])
      const next = await run(period("2026-10-01", "2026-10-10"))
      assert.deepEqual([next.eventCount, next.invoiceCount, next.netMinor, next.vatMinor], [1, 1, -10_000, -2_500])
      const issued = await readInvoice(next.invoiceIds[0])
      assert.deepEqual([issued.kind, issued.customerId, issued.currency, issued.netMinor, issued.vatMinor, issued.grossMinor], ["invoice", fx.customers.housing.id, "DKK", -10_000, -2_500, -12_500], "an invoice may carry a negative net when reversals outweigh")
      assert.deepEqual(issued.lines.map((line) => [line.billableEventId, line.quantity, line.unitPriceMinor, line.netMinor, line.vatMinor]), [[reversal.id, 1, 10_000, -10_000, -2_500]])
      assert.deepEqual([(await readEvent(e1.id)).status, (await readEvent(reversal.id)).status], ["reversed", "invoiced"])
    })
  })
})
