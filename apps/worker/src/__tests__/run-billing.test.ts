// The scheduled billing run against Postgres (Issue #112 part B): the handler
// of `finance.run-billing` run directly with pools of this suite's own — the
// worker role's for the sweep, as the process hands it, and the API role's
// for the runs — over a tenant minted here (finance-tenant.ts) on a database
// of this file's own, since the sweep crosses every company and a sweep on
// the shared local database would bill every other suite's projects out from
// under it (the relay test's reason, database.ts; the two application roles
// reach the fresh database with the cluster-wide logins bootstrap gave them).
// The sweep finds the tenant's active project and not its `onboarding` one;
// the run bills the calendar month before the day on the project's clock,
// issuing one invoice per payer and currency through the same `runBilling`
// the API's `POST /billing-runs` runs, with `requested_by` and `issued_by`
// null; a second sweep over the same month issues nothing, which is what
// makes a retry safe; a run sent by hand names one project and a day; and a
// project whose run refuses is one failure among the others' successes, the
// job failing at the end with the project named. Skipped with the reason when
// `DATABASE_URL`, `WORKER_DATABASE_URL` or `DATABASE_ADMIN_URL` is unset,
// failed under `REQUIRE_DATABASE`.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { createDb, type Database } from "@waste/db/client"
import { recordBillableEvent } from "@waste/db/commands/billable-writes"
import { runBilling } from "@waste/db/commands/billing-runs"
import { eventOf, eventsFrom, invoiceColumns, runColumns } from "@waste/db/commands/billing-shapes"
import { dayInTimezone } from "@waste/db/commands/days"
import { newId } from "@waste/db/ids"
import { migrateDatabase } from "@waste/db/migrate"
import { outboxEvent } from "@waste/db/schema/execution"
import { billableEvent, billingRun, invoice } from "@waste/db/schema/finance"
import { withCompany } from "@waste/db/tenant"
import type { BillableEventDraft } from "@waste/domain/finance/from-event"
import { monthBefore } from "@waste/domain/finance/periods"
import type { Job } from "pg-boss"
import { and, asc, eq } from "drizzle-orm"

import type { JobContext } from "../jobs"
import { runScheduledBilling, type ProjectRun, type RunBillingData } from "../jobs/run-billing"
import { rolesUnderTest, withDatabaseName } from "./database"
import { seedFinanceTenant, testId, type FinanceTenant } from "./finance-tenant"

const roles = rolesUnderTest()
const skip = roles.skip

/** The first of October at 12:00 UTC, the schedule's own instant: 14:00 on Copenhagen's clock, 07:00 in Chicago, so the day is the first on both and the month before is September. */
const FIRST_OF_OCTOBER = new Date("2026-10-01T12:00:00Z")

describe("finance.run-billing against Postgres", { skip }, () => {
  const name = `waste_worker_billing_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  let api: Database
  let worker: Database
  let admin: Database
  let tenant: FinanceTenant
  const lines: string[] = []

  const context = (now = FIRST_OF_OCTOBER): JobContext => ({
    api,
    worker,
    now: () => now,
    log: (message) => void lines.push(message),
    send: async () => null,
  })

  before(async () => {
    admin = createDb(roles.adminUrl, { max: 1 })
    await admin.sql.unsafe(`create database "${name}"`)
    await migrateDatabase(withDatabaseName(roles.adminUrl, name))
    api = createDb(withDatabaseName(roles.apiUrl, name), { max: 4 })
    worker = createDb(withDatabaseName(roles.workerUrl, name), { max: 2 })
    tenant = await seedFinanceTenant(api)
  })
  after(async () => {
    await api?.close()
    await worker?.close()
    try {
      await admin.sql.unsafe(`drop database if exists "${name}" with (force)`)
    } finally {
      await admin.close()
    }
  })

  /** Runs the handler over one job, as pg-boss would hand it in, and answers the project runs it made. */
  const handle = async (data: RunBillingData, now = FIRST_OF_OCTOBER): Promise<ProjectRun[]> => {
    const job: Job<RunBillingData> = { id: testId(), name: runScheduledBilling.queue, data, expireInSeconds: 900, heartbeatSeconds: null, signal: new AbortController().signal }
    const output = (await runScheduledBilling.handler([job], context(now))) as { runs: ProjectRun[] }
    return output.runs
  }

  /** A manual event of Olivia's on a day, priced by hand: ready for a run. */
  const ready = async (agreementId: string, serviceDate: string, unitPriceMinor = 12_000): Promise<string> => {
    const draft: BillableEventDraft = {
      kind: "manual",
      serviceDate,
      agreementId,
      subscriptionId: null,
      productId: tenant.products.residual.id,
      quantity: 1,
      price: { priceListRowId: null, unitPriceMinor, netMinor: unitPriceMinor, vatPercent: 25, vatMinor: Math.round(unitPriceMinor / 4), currency: "DKK" },
      blockReason: null,
      links: { routeId: null, pickupId: null, ticketId: null, reversesEventId: null },
    }
    return await withCompany(api.db, tenant.companyId, async (tx) => (await recordBillableEvent(tx, { companyId: tenant.companyId, projectId: tenant.projects.copenhagen.id, draft, overrideReason: "Agreed by phone", note: null, createdBy: tenant.users.olivia.id, sourceEventId: null, newId })).answered.id)
  }

  /** The tenant's runs, oldest first, and its invoices. */
  const runs = () => withCompany(api.db, tenant.companyId, (tx) => tx.select(runColumns).from(billingRun).where(eq(billingRun.companyId, tenant.companyId)).orderBy(asc(billingRun.id)))
  const invoices = () => withCompany(api.db, tenant.companyId, (tx) => tx.select(invoiceColumns).from(invoice).where(eq(invoice.companyId, tenant.companyId)).orderBy(asc(invoice.id)))
  const statusOf = (id: string) => withCompany(api.db, tenant.companyId, async (tx) => eventOf((await eventsFrom(tx, tenant.companyId).query.where(and(eq(billableEvent.companyId, tenant.companyId), eq(billableEvent.id, id))))[0]).status)

  test("is scheduled on the first of each month at noon UTC — the first of the month on every clock from UTC−11 to UTC+11 at once — missed occurrences run once, and the schedule's data is the whole sweep", () => {
    assert.equal(runScheduledBilling.queue, "finance.run-billing")
    assert.equal(runScheduledBilling.schedule, "0 12 1 * *")
    assert.deepEqual(runScheduledBilling.scheduleData, { projectId: null, on: null })
    assert.deepEqual(runScheduledBilling.scheduleOptions, { tz: "UTC", missed: "once" })
    assert.ok(!runScheduledBilling.queue.startsWith("outbox."), "sent by the schedule, never by the relay")
    // The schedule's instant read on each clock: the first everywhere the system could serve, so `monthBefore` is the month that just ended. At 04:00 UTC (the earlier schedule) Chicago still read the 30th of September and would have billed August.
    const noon = new Date("2026-10-01T12:00:00Z")
    for (const timezone of ["Pacific/Pago_Pago", "America/Anchorage", "America/Chicago", "America/New_York", "Europe/Copenhagen", "Asia/Kolkata", "Asia/Tokyo", "Pacific/Noumea"]) {
      assert.equal(dayInTimezone(noon, timezone), "2026-10-01", `${timezone}: the first`)
      assert.deepEqual(monthBefore(dayInTimezone(noon, timezone)), { periodFrom: "2026-09-01", periodTo: "2026-09-30" }, `${timezone}: September`)
    }
    assert.equal(dayInTimezone(new Date("2026-10-01T04:00:00Z"), "America/Chicago"), "2026-09-30", "the case the reviewer computed: 04:00Z is 23:00 CDT on the 30th")
    assert.deepEqual(monthBefore(dayInTimezone(new Date("2026-10-01T04:00:00Z"), "America/Chicago")), { periodFrom: "2026-08-01", periodTo: "2026-08-31" }, "and would have billed a month late")
    assert.equal(dayInTimezone(new Date("2026-12-01T04:00:00Z"), "America/New_York"), "2026-11-30", "New York in winter too")
    // Beyond UTC+11 noon is already the second, which `monthBefore` reads the same way.
    assert.equal(dayInTimezone(noon, "Pacific/Auckland"), "2026-10-02")
    assert.deepEqual(monthBefore(dayInTimezone(noon, "Pacific/Auckland")), { periodFrom: "2026-09-01", periodTo: "2026-09-30" })
  })

  test("the sweep bills every active project over the calendar month before the day on its clock — one invoice per payer, nobody's request — and skips an onboarding project; a second sweep over the month issues nothing", async () => {
    const housing = await ready(tenant.agreements.housing.id, "2026-09-14")
    const anna = await ready(tenant.agreements.anna.id, "2026-09-28", 8_000)
    const october = await ready(tenant.agreements.anna.id, "2026-10-01")
    const before = (await runs()).length

    const outcomes = await handle({ projectId: null, on: null })
    // The sweep crosses every company on the database; this suite's is the one there, and its onboarding project is not among the runs.
    const own = outcomes.filter((run) => run.companyId === tenant.companyId)
    assert.equal(outcomes.length, 1, "the database holds this suite's tenant alone")
    assert.equal(own.length, 1, "the active project, and never the onboarding one")
    const [run] = own
    assert.deepEqual([run.projectId, run.periodFrom, run.periodTo, run.outcome], [tenant.projects.copenhagen.id, "2026-09-01", "2026-09-30", "completed"])
    assert.ok(run.outcome === "completed" && run.eventCount === 2 && run.invoiceCount === 2, JSON.stringify(run))

    const [written] = (await runs()).slice(before)
    assert.deepEqual([written.status, written.requestedBy, written.eventCount, written.invoiceCount, written.netMinor, written.vatMinor, written.periodFrom, written.periodTo], ["completed", null, 2, 2, 20_000, 5_000, "2026-09-01", "2026-09-30"])
    assert.equal(written.completedAt?.toISOString(), FIRST_OF_OCTOBER.toISOString(), "the run's instant is the job's clock")
    const issued = (await invoices()).filter((document) => document.billingRunId === written.id)
    assert.deepEqual(
      issued.map((document) => [document.kind, document.currency, document.issuedOn, document.dueOn, document.issuedBy, document.periodFrom, document.periodTo]).sort(),
      [
        ["invoice", "DKK", "2026-10-01", "2026-10-31", null, "2026-09-01", "2026-09-30"],
        ["invoice", "DKK", "2026-10-01", "2026-10-31", null, "2026-09-01", "2026-09-30"],
      ],
      "issued on the day on Copenhagen's clock, due thirty days on, by nobody",
    )
    assert.deepEqual(issued.map((document) => document.customerId).sort(), [tenant.customers.anna.id, tenant.customers.housing.id].sort())
    assert.deepEqual([await statusOf(housing), await statusOf(anna), await statusOf(october)], ["invoiced", "invoiced", "ready"], "September's events are on lines; October's waits for November's run")
    assert.match(lines.at(-1) ?? "", /finance\.run-billing: project .* 2026-09-01\.\.2026-09-30 → run .*, 2 events, 2 invoices/)
    // The `invoice-issued` events went into the outbox with the documents, as the API's run writes them.
    const published = await withCompany(api.db, tenant.companyId, (tx) => tx.select({ kind: outboxEvent.kind, aggregateId: outboxEvent.aggregateId }).from(outboxEvent).where(eq(outboxEvent.companyId, tenant.companyId)))
    assert.deepEqual(published.map((event) => event.kind), ["invoice-issued", "invoice-issued"])

    // Again: the schedule already ran over September for this project, so the retry (or the next occurrence) skips it — `already-run`, the first run named, no second row — and nobody is invoiced twice.
    const again = (await handle({ projectId: tenant.projects.copenhagen.id, on: null })).filter((run) => run.companyId === tenant.companyId)
    assert.equal(again.length, 1)
    assert.deepEqual(again[0], { companyId: tenant.companyId, projectId: tenant.projects.copenhagen.id, periodFrom: "2026-09-01", periodTo: "2026-09-30", outcome: "already-run", runId: written.id })
    assert.equal((await runs()).length, before + 1, "no second run row for a project the schedule already covered")
    assert.equal((await invoices()).length, 2)
    assert.match(lines.at(-1) ?? "", new RegExp(`finance\\.run-billing: project ${tenant.projects.copenhagen.id} 2026-09-01\\.\\.2026-09-30 → already-run \\(run ${written.id}; job `))
  })

  test("a person's run over the month is not the schedule's record: the schedule still runs once after it, writing its own completed run of zero invoices, and skips only its own", async () => {
    // The office ran November's billing by hand on the first of December (`requested_by` set), before the schedule fired.
    const november = await ready(tenant.agreements.housing.id, "2026-11-12", 7_000)
    const office = await withCompany(api.db, tenant.companyId, (tx) => runBilling(tx, { companyId: tenant.companyId, projectId: tenant.projects.copenhagen.id, periodFrom: "2026-11-01", periodTo: "2026-11-30", note: "By hand", requestedBy: tenant.users.olivia.id, newId, now: () => new Date("2026-12-01T09:00:00Z") }))
    assert.equal(office.run.invoiceCount, 1)
    assert.equal(await statusOf(november), "invoiced")
    const before = (await runs()).length
    // The schedule at noon on the first of December: it has no run of its own over November, so it runs — and finds nothing ready, a completed run of zero invoices, the record that it looked.
    const [scheduled] = await handle({ projectId: tenant.projects.copenhagen.id, on: null }, new Date("2026-12-01T12:00:00Z"))
    assert.ok(scheduled.outcome === "completed" && scheduled.eventCount === 0 && scheduled.invoiceCount === 0, JSON.stringify(scheduled))
    assert.equal((await runs()).length, before + 1)
    // Its retry: its own row is there now, so it skips.
    const [retried] = await handle({ projectId: tenant.projects.copenhagen.id, on: null }, new Date("2026-12-01T12:01:00Z"))
    assert.deepEqual([retried.outcome, retried.outcome === "already-run" ? retried.runId : null], ["already-run", scheduled.outcome === "completed" ? scheduled.runId : null])
    assert.equal((await runs()).length, before + 1, "still the one scheduled row beside the office's")
  })

  test("a run sent by hand names one project and a day, and bills the month before that day", async () => {
    const august = await ready(tenant.agreements.housing.id, "2026-08-03", 5_000)
    const outcomes = await handle({ projectId: tenant.projects.copenhagen.id, on: "2026-09-01" })
    assert.equal(outcomes.length, 1, "one project, named")
    const [run] = outcomes
    assert.deepEqual([run.companyId, run.projectId, run.periodFrom, run.periodTo, run.outcome], [tenant.companyId, tenant.projects.copenhagen.id, "2026-08-01", "2026-08-31", "completed"])
    assert.ok(run.outcome === "completed" && run.eventCount === 1 && run.invoiceCount === 1)
    assert.equal(await statusOf(august), "invoiced")
    const onboarding = await handle({ projectId: tenant.projects.onboarding.id, on: "2026-09-01" })
    assert.deepEqual(onboarding, [], "an onboarding project is not billed, named or not")
  })

  test("the day is read on the project's clock: at 23:30Z on the last of September it is already October in Copenhagen, and September is billed", async () => {
    await ready(tenant.agreements.anna.id, "2026-07-15")
    const lateOnTheThirtieth = new Date("2026-07-31T23:30:00Z")
    const [run] = await handle({ projectId: tenant.projects.copenhagen.id, on: null }, lateOnTheThirtieth)
    assert.deepEqual([run.periodFrom, run.periodTo], ["2026-07-01", "2026-07-31"], "01:30 on 1 August in Copenhagen: July is the month before")
    assert.ok(run.outcome === "completed" && run.eventCount === 1)
  })

  test("one project's refusal is not another's: a run that cannot run is a failure named in the job's error, the rest completed, and nothing of the failed one written", async () => {
    // A day that is not one is refused by the domain before anything is read for the project.
    await assert.rejects(handle({ projectId: tenant.projects.copenhagen.id, on: "2026-13-01" }), /1 of 1 project runs failed: .*is not a YYYY-MM-DD day/)
    const before = (await runs()).length
    await assert.rejects(handle({ projectId: tenant.projects.copenhagen.id, on: "not a day" }), /finance\.run-billing: 1 of 1 project runs failed/)
    assert.equal((await runs()).length, before, "a failed project leaves no run row: a run is one transaction or nothing")
    assert.match(lines.at(-1) ?? "", /→ failed: monthBefore/)
  })
})
