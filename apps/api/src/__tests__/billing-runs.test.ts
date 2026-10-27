import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { BillableEvent } from "@waste/contracts/billable-events"
import { BillingRun, BillingRunDetail, BillingRunPreview, PERIOD_ENDS_BY_TODAY, PERIOD_ORDERED } from "@waste/contracts/billing"
import { InvoiceDetail } from "@waste/contracts/invoices"
import { Page } from "@waste/contracts/pagination"
import { DAY_WINDOW_ORDERED } from "@waste/contracts/queries"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { product } from "@waste/db/schema/catalogue"
import { customer } from "@waste/db/schema/customers"
import { outboxEvent } from "@waste/db/schema/execution"
import { billableEvent, billingRun, billingRunExclusion, invoice, invoiceLine } from "@waste/db/schema/finance"
import { company, project } from "@waste/db/schema/organisation"
import { withCompany } from "@waste/db/tenant"
import { and, asc, count, eq, inArray, sql } from "drizzle-orm"

import { createApp } from "../app"
import { newId, type IdMinter } from "../ids"
import { notCancelled } from "../routes/billable-events"
import { BILLING_RUN_MAX_EVENTS, runBilling, selectBilling, tooManyEvents } from "../routes/billing-runs"
import { lockRow } from "../routes/shared"
import { pickupEvent, reversalEvent, seedBilling, type BillingFixtures } from "./billing-fixtures"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { seedExecution, type ExecutionFixtures } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning } from "./scheme-fixtures"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the proofs the fixtures append and the invoices and lines the runs write, which `wms_api` may not delete. */
const owner = ownerUnderTest()
const RunPage = Page(BillingRun)

const MODULE = "commercial.billing"

/** The request's clock, pinned: noon on the fixtures' Monday, so "today" on Copenhagen's clock is that Monday and every stamp is known. */
/** The instant the suite's clock stands at: past every period it runs, since a run is for a closed period (M14 of #293). */
const NOON = new Date("2027-02-05T12:00:00Z")

describe("the billing run endpoints", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let ex: ExecutionFixtures
  let fx: BillingFixtures
  let app: ReturnType<typeof createApp>
  let olivia: Call
  /** The custom role, granted the module, with Project Access to Copenhagen Central only. */
  let viewer: Call
  /** The Service Provider Manager, granted the module: a role that reaches no project of the company. */
  let lars: Call
  let other: Call
  let ungranted: Call
  let copenhagen: string
  let harbor: string

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    copenhagen = a.projects.copenhagen.id
    harbor = a.projects.harbor.id
    const fleet = await seedFleet(pool, a, await seedPlanning(pool, a))
    ex = await seedExecution(pool, a, fleet)
    fx = await seedBilling(pool, a, ex)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: MODULE, actions: ["view", "create"] }, { moduleKey: "commercial.invoices", actions: ["view"] }])
    await grantRole(pool, a.companyId, a.roles.providerManager.id, [{ moduleKey: MODULE, actions: ["view", "create"] }])
    app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOON })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    lars = callingAs(app, keys, a.users.lars, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    ungranted = callingAs(app, keys, b.users.viewer, b.companyId)
  })

  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    if (b) await dropTenant(pool, b.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }

  const manual = (overrides: Record<string, unknown> = {}) => ({ projectId: copenhagen, agreementId: fx.agreements.housingDkk.id, productId: fx.products.residual.id, quantity: 1, serviceDate: fx.day, ...overrides })

  const entered = async (body: Record<string, unknown>): Promise<BillableEvent> => {
    const response = await olivia("/billable-events", { method: "POST", body })
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    return BillableEvent.parse(await response.json())
  }

  const readEvent = async (id: string): Promise<BillableEvent> => {
    const response = await olivia(`/billable-events/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return BillableEvent.parse(await response.json())
  }

  const readInvoice = async (id: string, call: Call = olivia): Promise<InvoiceDetail> => {
    const response = await call(`/invoices/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return InvoiceDetail.parse(await response.json())
  }

  const period = (periodFrom: string, periodTo: string = periodFrom, projectId: string = copenhagen) => ({ projectId, periodFrom, periodTo })

  const run = async (body: Record<string, unknown>, call: Call = olivia): Promise<BillingRunDetail> => created(call, "/billing-runs", await call("/billing-runs", { method: "POST", body }), BillingRunDetail)

  const preview = async (body: Record<string, unknown>, call: Call = olivia): Promise<BillingRunPreview> => {
    const response = await call("/billing-runs/preview", { method: "POST", body })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return BillingRunPreview.parse(await response.json())
  }

  /** The outbox rows about one document, oldest first, read as `wms_api` under the fence. */
  const eventsAbout = async (aggregateId: string) =>
    withCompany(pool.db, a.companyId, (tx: Tx) =>
      tx
        .select({ kind: outboxEvent.kind, aggregateKind: outboxEvent.aggregateKind, projectId: outboxEvent.projectId, occurredAt: outboxEvent.occurredAt, payload: outboxEvent.payload })
        .from(outboxEvent)
        .where(and(eq(outboxEvent.companyId, a.companyId), eq(outboxEvent.aggregateId, aggregateId)))
        .orderBy(asc(outboxEvent.id)),
    )

  /** What the company has written so far: runs, invoices, invoice events, and the counter — to prove a preview and a refused run write nothing. */
  const written = () =>
    withCompany(pool.db, a.companyId, async (tx: Tx) => {
      const [runs] = await tx.select({ rows: count() }).from(billingRun).where(eq(billingRun.companyId, a.companyId))
      const [invoices] = await tx.select({ rows: count() }).from(invoice).where(eq(invoice.companyId, a.companyId))
      const [issued] = await tx.select({ rows: count() }).from(outboxEvent).where(and(eq(outboxEvent.companyId, a.companyId), eq(outboxEvent.kind, "invoice-issued")))
      const [counter] = await tx.select({ next: company.nextInvoiceNumber }).from(company).where(eq(company.id, a.companyId))
      return { runs: runs?.rows ?? 0, invoices: invoices?.rows ?? 0, issued: issued?.rows ?? 0, next: counter?.next }
    })

  const byId = (x: { id: string }, y: { id: string }) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)

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

  describe("catch-up (#447)", () => {
    test("takes an event released from a hold and one repriced after their month's run into the next month's run, each exactly once, and the preview lists them as catch-up lines", async () => {
      const july = period("2026-07-01", "2026-07-31")
      const august = period("2026-08-01", "2026-08-31")
      const own = await entered(manual({ serviceDate: "2026-07-01" }))
      const held = await entered(manual({ agreementId: fx.agreements.anna.id, serviceDate: "2026-07-14" }))
      assert.equal((await olivia(`/billable-events/${held.id}/hold`, { method: "POST", body: { reason: "Checked with the customer" } })).status, 200)
      const blocked = await entered(manual({ productId: fx.products.bulky.id, serviceDate: "2026-07-15" }))
      assert.deepEqual([blocked.status, blocked.blockReason], ["blocked", "no-vat-rate"])

      const first = await run(july)
      assert.deepEqual([first.eventCount, first.invoiceCount], [1, 1], "July's run takes its one ready event and passes over the held and the blocked")
      assert.equal((await readEvent(own.id)).status, "invoiced")

      // After July's run: the hold released, the bulky product given its rate and the event repriced.
      assert.equal((await olivia(`/billable-events/${held.id}/release`, { method: "POST", body: {} })).status, 200)
      await withCompany(pool.db, a.companyId, async (tx: Tx) => {
        await tx.update(product).set({ vatPercent: 25 }).where(and(eq(product.companyId, a.companyId), eq(product.id, fx.products.bulky.id)))
      })
      try {
        const repriced = await olivia(`/billable-events/${blocked.id}/reprice`, { method: "POST", body: {} })
        assert.equal(repriced.status, 200, JSON.stringify(await repriced.clone().json()))
        assert.equal(BillableEvent.parse(await repriced.json()).status, "ready")
      } finally {
        await withCompany(pool.db, a.companyId, async (tx: Tx) => {
          await tx.update(product).set({ vatPercent: null }).where(and(eq(product.companyId, a.companyId), eq(product.id, fx.products.bulky.id)))
        })
      }
      const ownAugust = await entered(manual({ agreementId: fx.agreements.anna.id, serviceDate: "2026-08-03" }))

      const before = await written()
      const previewed = await preview(august)
      assert.deepEqual(await written(), before, "a preview writes nothing")
      assert.deepEqual([previewed.eventCount, previewed.invoiceCount, previewed.catchUpDeferredCount], [3, 2, 0])
      assert.deepEqual(previewed.catchUp, [
        { billableEventId: held.id, kind: "manual", customerId: fx.customers.anna.id, description: "Restaffald 240 L · 2026-07-14", serviceDate: "2026-07-14", currency: "DKK", netMinor: 12_000, vatMinor: 3_000 },
        { billableEventId: blocked.id, kind: "manual", customerId: fx.customers.housing.id, description: "Bulky pickup · 2026-07-15", serviceDate: "2026-07-15", currency: "DKK", netMinor: 35_000, vatMinor: 8_750 },
      ])
      assert.deepEqual(previewed.totals, [{ currency: "DKK", netMinor: 12_000 + 35_000 + 12_000, vatMinor: 3_000 + 8_750 + 3_000 }], "the caught up count in the totals")

      const second = await run(august)
      assert.deepEqual([second.eventCount, second.invoiceCount, second.netMinor], [3, 2, 59_000])
      const invoices = await Promise.all(second.invoiceIds.map((id) => readInvoice(id)))
      const lines = invoices.flatMap((issued) => issued.lines.map((line) => [issued.customerId, line.billableEventId, line.serviceDate]))
      assert.deepEqual(
        lines.sort(),
        [
          [fx.customers.anna.id, held.id, "2026-07-14"],
          [fx.customers.anna.id, ownAugust.id, "2026-08-03"],
          [fx.customers.housing.id, blocked.id, "2026-07-15"],
        ].sort(),
        "each on its payer's invoice beside the month's own",
      )
      for (const event of [held, blocked, ownAugust]) assert.equal((await readEvent(event.id)).status, "invoiced")

      const september = await run(period("2026-09-01", "2026-09-30"))
      assert.deepEqual([september.eventCount, september.invoiceCount], [0, 0], "the next month's run finds them invoiced")
      const again = await run(august)
      assert.deepEqual([again.eventCount, again.invoiceCount], [0, 0], "and so does a second run over August")
      assert.deepEqual((await preview(period("2026-09-01", "2026-09-30"))).catchUp, [])
    })

    test("judges a caught-up event on the row a cancellation committed while the run waited on its lock: it is not invoiced", async () => {
      // A cancellation holds the event's lock, its `cancelled_at` written and not yet committed, when the run's selection reaches the row: the run waits, and once the cancellation commits Postgres re-reads the run's `where` over the row it wrote. The ids the catch-up chose before the lock are not enough to name it.
      const event = await entered(manual({ serviceDate: "2026-06-10" }))
      const scope = { companyId: a.companyId, projectId: copenhagen }
      const window = { periodFrom: "2026-06-15", periodTo: "2026-06-30" }
      const commit = Promise.withResolvers<void>()
      const written = Promise.withResolvers<number>()
      const cancelling = withCompany(pool.db, a.companyId, async (tx: Tx) => {
        const [{ pid }] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)
        await tx.update(billableEvent).set({ cancelledAt: NOON, cancelReason: "duplicate", cancelledBy: a.users.olivia.id }).where(and(eq(billableEvent.companyId, a.companyId), eq(billableEvent.id, event.id)))
        written.resolve(pid)
        await commit.promise
      })
      let selecting: Promise<string[]> | undefined
      try {
        const pid = await written.promise
        selecting = withCompany(pool.db, a.companyId, async (tx: Tx) => (await selectBilling(tx, scope, window, { lock: true })).events.map((ready) => ready.id))
        const blocked = async (): Promise<boolean> => (await pool.sql`select pid from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`).length > 0
        const deadline = Date.now() + 10_000
        while (!(await blocked())) {
          assert.ok(Date.now() < deadline, "the selection never waited on the cancellation's lock")
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
      } finally {
        commit.resolve()
        await cancelling
      }
      assert.ok(selecting, "the selection was made")
      assert.ok(!(await selecting).includes(event.id), "a cancelled event is not caught up")
      assert.equal((await readEvent(event.id)).status, "cancelled")
    })

    test("reaches back twelve months from the period's first day and no further", async () => {
      const inside = await entered(manual({ serviceDate: "2026-02-01" }))
      const outside = await entered(manual({ serviceDate: "2026-01-31" }))
      try {
        const caughtUp = (await preview(period("2027-02-01", "2027-02-05"))).catchUp.map((line) => line.billableEventId)
        assert.ok(caughtUp.includes(inside.id), "twelve months before 2027-02-01 is 2026-02-01, the window's first day")
        assert.ok(!caughtUp.includes(outside.id), "the day before it is past the reach")
      } finally {
        for (const event of [inside, outside]) assert.equal((await olivia(`/billable-events/${event.id}/cancel`, { method: "POST", body: { reason: "duplicate" } })).status, 200)
      }
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

  describe("the ceiling, the lock and the scope", () => {
    test("refuses a selection above the ceiling as one transaction, writing nothing, on the run and on the preview alike", async () => {
      assert.equal(BILLING_RUN_MAX_EVENTS, 5_000)
      const day = "2027-01-05"
      const rows = Array.from({ length: BILLING_RUN_MAX_EVENTS + 1 }, () => ({
        id: testId(),
        companyId: a.companyId,
        projectId: copenhagen,
        kind: "manual",
        serviceDate: day,
        agreementId: fx.agreements.anna.id,
        productId: fx.products.residual.id,
        quantity: 1,
        unitPriceMinor: 12_000,
        netMinor: 12_000,
        vatPercent: 25,
        vatMinor: 3_000,
        currency: "DKK",
        priceListRowId: fx.rows.residual.id,
        createdBy: a.users.olivia.id,
      }))
      await withCompany(pool.db, a.companyId, async (tx: Tx) => {
        for (let start = 0; start < rows.length; start += 500) await tx.insert(billableEvent).values(rows.slice(start, start + 500))
      })
      const before = await written()
      const tooMany = await refused(await olivia("/billing-runs", { method: "POST", body: period("2027-01-01", "2027-01-31") }), 409)
      assert.equal(tooMany.detail, tooManyEvents(BILLING_RUN_MAX_EVENTS + 1))
      assert.equal(tooMany.detail, "5 001 ready events fall in the period; narrow it — a run is one transaction")
      assert.equal((await refused(await olivia("/billing-runs/preview", { method: "POST", body: period("2027-01-01", "2027-01-31") }), 409)).detail, tooMany.detail)
      assert.deepEqual(await written(), before, "a refused run leaves nothing behind, the counter included")
      const narrower = await run(period("2027-01-04"))
      assert.deepEqual([narrower.eventCount, narrower.invoiceCount], [1, 1], "the day before holds nothing of its own, and catches up the one earlier event left ready (#447)")
      assert.deepEqual((await readInvoice(narrower.invoiceIds[0])).lines.map((line) => line.serviceDate), ["2026-10-20"])

      // The period's own come first under the ceiling (#447): the catch-up takes the room they leave, oldest first, and the rest wait for the next run.
      const own = await Promise.all([1, 2, 3].map(() => entered(manual({ serviceDate: "2027-01-20" }))))
      const after = period("2027-01-06", "2027-01-31")
      const previewed = await preview(after)
      assert.deepEqual([previewed.eventCount, previewed.catchUp.length, previewed.catchUpDeferredCount], [BILLING_RUN_MAX_EVENTS, BILLING_RUN_MAX_EVENTS - 3, 4])
      const filled = await run(after)
      assert.equal(filled.eventCount, BILLING_RUN_MAX_EVENTS)
      for (const event of own) assert.equal((await readEvent(event.id)).status, "invoiced", "the period's own are never crowded out")
      const rest = await run(period("2027-02-01", "2027-02-05"))
      assert.deepEqual([rest.eventCount, rest.invoiceCount], [4, 1], "the next run takes the four left")
    })

    test("serialises two runs of one project on the project's lock: the second finds only what the first left", async () => {
      const day = "2026-11-02"
      await entered(manual({ serviceDate: day }))
      await entered(manual({ serviceDate: day, agreementId: fx.agreements.anna.id }))
      const [first, second] = await Promise.all([olivia("/billing-runs", { method: "POST", body: period("2026-11-01", "2026-11-03") }), olivia("/billing-runs", { method: "POST", body: period("2026-11-01", "2026-11-03") })])
      assert.deepEqual([first.status, second.status], [201, 201])
      const counts = [BillingRunDetail.parse(await first.json()).invoiceCount, BillingRunDetail.parse(await second.json()).invoiceCount].sort()
      assert.deepEqual(counts, [0, 2], "one run issued both invoices and the other none")
    })

    test("locks the events it invoices: a cancellation sent while a run holds them waits for the run and is then refused as invoiced, so no event is both invoiced and cancelled", async () => {
      // The run is hand-driven to its selection — the project locked and the ready events read `for update` the way `runBilling` reads them, the transaction held open — so a cancellation that found the row unlocked would stamp `cancelled_at` on an event the run is about to invoice (READ COMMITTED: the run's line is invisible until it commits), a line the customer pays for a row the office thinks is gone. With the lock the cancellation waits: the run goes on to its invoices and commits only once Postgres reports the cancellation blocked behind it (`pg_blocking_pids`, the driver suite's precedent), and the cancellation then reads the line the run wrote.
      const day = "2026-12-07"
      const event = await entered(manual({ serviceDate: day }))
      assert.equal(event.status, "ready")
      const scope = { companyId: a.companyId, projectId: copenhagen }
      const window = { periodFrom: day, periodTo: day }
      const proceed = Promise.withResolvers<void>()
      const selected = Promise.withResolvers<number>()
      const running = withCompany(pool.db, a.companyId, async (tx: Tx) => {
        const [{ pid }] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)
        await lockRow(tx, project, { companyId: a.companyId, id: copenhagen })
        const selection = await selectBilling(tx, scope, window, { lock: true })
        assert.deepEqual(
          selection.events.map((ready) => ready.id),
          [event.id],
          "the one ready event of the day",
        )
        selected.resolve(pid)
        await proceed.promise
        return await runBilling(tx, { ...scope, ...window, note: null, requestedBy: a.users.olivia.id, newId, now: () => NOON })
      })
      /** Rejects if the run ends before it is let go — a statement refused, say — so a broken run fails the test instead of hanging it on the pid. */
      const endedEarly = running.then(() => Promise.reject(new Error("the run's transaction ended before it was released")))
      void endedEarly.catch(() => undefined)
      // The cancellation is sent once the selection is made and held, so what it meets is the lock and not the timing.
      let cancelling: Promise<Response> | undefined
      try {
        const pid = await Promise.race([selected.promise, endedEarly])
        cancelling = olivia(`/billable-events/${event.id}/cancel`, { method: "POST", body: { reason: "not-delivered" } })
        // Postgres names the backends a process blocks: the cancellation is waiting on the run's transaction once this answers a row, and not before.
        const blocked = async (): Promise<boolean> => (await pool.sql`select pid from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`).length > 0
        const deadline = Date.now() + 10_000
        while (!(await blocked())) {
          assert.ok(Date.now() < deadline, "the cancellation never waited on the run: the selection took no lock on the events")
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
      } finally {
        proceed.resolve()
        await running.catch(() => undefined)
        await cancelling?.catch(() => undefined)
      }
      const done = await running
      assert.ok(cancelling, "the cancellation was sent")
      assert.deepEqual([done.run.eventCount, done.invoiceIds.length], [1, 1], "the run invoiced the event")
      assert.equal((await refused(await cancelling, 409)).detail, notCancelled(event.id, "invoiced"), "the cancellation read the line the run wrote")
      const charged = await readEvent(event.id)
      assert.deepEqual([charged.status, charged.cancelledAt, charged.cancelReason, charged.invoiceLineId !== null], ["invoiced", null, null, true], "invoiced and never cancelled")
    })

    test("is one transaction: a run that fails after its first invoice is written leaves no run, invoice, line, exclusion, event or number behind, and the events stay ready", async () => {
      // The failure is provoked at the second invoice's id: a minter that gives out after the run's id, the first invoice's and its one line's, so the first document — row, line and `invoice-issued` — has been written when the run dies, and everything the transaction holds has to go with it.
      const day = "2026-12-14"
      const housing = await entered(manual({ serviceDate: day }))
      const anna = await entered(manual({ serviceDate: day, agreementId: fx.agreements.anna.id }))
      /** The exclusion rows and the lines naming the two events: what `written` does not count. */
      const rest = () =>
        withCompany(pool.db, a.companyId, async (tx: Tx) => {
          const [exclusions] = await tx.select({ rows: count() }).from(billingRunExclusion).where(eq(billingRunExclusion.companyId, a.companyId))
          const [lines] = await tx.select({ rows: count() }).from(invoiceLine).where(and(eq(invoiceLine.companyId, a.companyId), inArray(invoiceLine.billableEventId, [housing.id, anna.id])))
          return { exclusions: exclusions?.rows ?? 0, lines: lines?.rows ?? 0 }
        })
      const before = { ...(await written()), ...(await rest()) }
      assert.equal(before.lines, 0)
      let minted = 0
      const givesOut: IdMinter = () => {
        if (++minted > 3) throw new Error("the minter gave out")
        return newId()
      }
      await assert.rejects(
        withCompany(pool.db, a.companyId, (tx: Tx) => runBilling(tx, { companyId: a.companyId, projectId: copenhagen, periodFrom: day, periodTo: day, note: null, requestedBy: a.users.olivia.id, newId: givesOut, now: () => NOON })),
        /the minter gave out/,
      )
      assert.equal(minted, 4, "the run's id, the first invoice's, its line's, and the second invoice's: the first document was written before the run died")
      assert.deepEqual({ ...(await written()), ...(await rest()) }, before, "no run, no invoice, no line, no exclusion, no invoice-issued, and the counter where it was")
      assert.deepEqual([(await readEvent(housing.id)).status, (await readEvent(anna.id)).status], ["ready", "ready"], "neither event is on a line")
      const done = await run(period(day))
      assert.deepEqual([done.eventCount, done.invoiceCount], [2, 2], "the same run, with a minter that lasts, issues both")
    })

    test("holds the body to the caller's projects and its period to its order, and refuses a member the server owns", async () => {
      const outside = await refused(await viewer("/billing-runs", { method: "POST", body: period("2026-10-01", "2026-10-10", harbor) }), 400)
      assert.deepEqual(outside.errors?.map((error) => error.path), ["projectId"])
      const none = await refused(await lars("/billing-runs", { method: "POST", body: period("2026-10-01", "2026-10-10") }), 400)
      assert.deepEqual(none.errors?.map((error) => error.path), ["projectId"])
      const backwards = await refused(await olivia("/billing-runs", { method: "POST", body: period("2026-10-10", "2026-10-01") }), 400)
      assert.deepEqual(backwards.errors, [{ path: "periodTo", message: PERIOD_ORDERED }])
      const owned = await refused(await olivia("/billing-runs", { method: "POST", body: { ...period("2026-10-01"), status: "completed" } }), 400)
      assert.deepEqual(owned.errors?.map((error) => error.path), ["status"])
      await refused(await ungranted("/billing-runs", { method: "POST", body: period("2026-10-01") }), 403)
    })

    test("lists the runs of the caller's projects by status and by a window over the period's start, reads one, and is the family's 404 across tenants", async () => {
      const harbors = await run(period("2026-10-01", "2026-10-31", harbor))
      const listed = await olivia("/billing-runs?status=completed&limit=200")
      assert.equal(listed.status, 200)
      const page = RunPage.parse(await listed.json())
      assert.ok(page.items.some((item) => item.id === harbors.id))
      assert.ok(page.items.every((item) => item.status === "completed"))
      assert.deepEqual([...page.items].sort(byId).map((item) => item.id), page.items.map((item) => item.id), "oldest first")

      const viewers = await viewer("/billing-runs?limit=200")
      assert.equal(viewers.status, 200)
      const viewed = RunPage.parse(await viewers.json())
      assert.ok(viewed.items.length > 0 && viewed.items.every((item) => item.projectId === copenhagen), "Copenhagen Central only")
      assert.ok(!viewed.items.some((item) => item.id === harbors.id))
      await refused(await viewer(`/billing-runs/${harbors.id}`), 404)
      await refused(await other(`/billing-runs/${harbors.id}`), 404)
      await refused(await ungranted(`/billing-runs/${harbors.id}`), 403)

      const windowed = await olivia("/billing-runs?from=2026-10-01&to=2026-10-01&limit=200")
      assert.ok(RunPage.parse(await windowed.json()).items.every((item) => item.periodFrom === "2026-10-01"))
      const backwards = await refused(await olivia("/billing-runs?from=2026-10-10&to=2026-10-01"), 400)
      assert.deepEqual(backwards.errors, [{ path: "to", message: DAY_WINDOW_ORDERED }])
      const larsPage = await lars("/billing-runs")
      assert.equal(larsPage.status, 200)
      assert.deepEqual(await larsPage.json(), { items: [], nextCursor: null })
    })
  })
})
