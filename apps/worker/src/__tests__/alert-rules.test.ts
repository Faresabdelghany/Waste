// The worker's alert rules (O4 of #290), on a database of their own since
// they read across companies: a tick raises one alert per occurrence — a
// route not started half an hour after its planned start, a running route's
// device silent, an active driver's licence running out or run out, an open
// ticket past its due date — and raises nothing twice; a condition that clears
// resolves its alert with no account and the rule's note; a person's resolve
// holds while the condition does; and a new occurrence is a new alert. A
// quiet tick reads nothing and writes nothing.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { createDb, type Database } from "@waste/db/client"
import { openTicket } from "@waste/db/commands/open-ticket"
import { migrateDatabase } from "@waste/db/migrate"
import { route, session } from "@waste/db/schema/execution"
import { driver } from "@waste/db/schema/fleet"
import { alert, ticket } from "@waste/db/schema/resolution"
import { withCompany } from "@waste/db/tenant"
import { CLEARED_NOTES } from "@waste/domain/resolution/alert-rules"
import { and, asc, eq } from "drizzle-orm"

import { isEvenCadence } from "../cadence"
import { alertRulesJob, alertsToClear, ALERT_RULES_INTERVAL_SECONDS, occurrencesToRaise, rulesSchedule, runAlertRules } from "../jobs/alert-rules"
import type { JobContext } from "../jobs/definition"
import { JOBS, jobsWithRulesEvery } from "../jobs/index"
import { at, seedConsumerTenant, seedRoute, testId, type ConsumerTenant, type SeededRoute } from "./consumer-fixtures"
import { rolesUnderTest, withDatabaseName } from "./database"

const roles = rolesUnderTest()

describe("the rules' cadence", () => {
  test("five minutes unless the knob says otherwise, on an even cadence alone: whole minutes that divide an hour, whole hours that divide a day", () => {
    assert.equal(ALERT_RULES_INTERVAL_SECONDS, 300)
    assert.equal(alertRulesJob.schedule, "*/5 * * * *")
    assert.deepEqual([60, 120, 300, 900, 1800, 3600, 7200, 21_600, 86_400].map(rulesSchedule), ["* * * * *", "*/2 * * * *", "*/5 * * * *", "*/15 * * * *", "*/30 * * * *", "0 * * * *", "0 */2 * * *", "0 */6 * * *", "0 0 * * *"])
    // A cron's */N starts again every hour or day: 7 minutes would leave a 4-minute gap at the hour, 45 a 15-minute one.
    for (const seconds of [30, 90, 420, 2700, 18_000, 172_800]) {
      assert.equal(isEvenCadence(seconds), false, String(seconds))
      assert.throws(() => rulesSchedule(seconds), /no even cadence/, String(seconds))
    }
    assert.equal(alertRulesJob.scheduleOptions?.missed, "skip", "a missed tick is the next tick's to read")
  })

  test("the knob moves the rules' schedule and nothing else of the registry", () => {
    assert.equal(jobsWithRulesEvery(undefined), JOBS)
    const moved = jobsWithRulesEvery(900)
    for (const [index, job] of moved.entries()) assert.equal(job.schedule, job.queue === alertRulesJob.queue ? "*/15 * * * *" : JOBS[index].schedule, job.queue)
  })
})

describe("resolution.alert-rules", { skip: roles.skip }, () => {
  const name = `waste_worker_rules_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  let admin: Database
  let api: Database
  let worker: Database
  let tenant: ConsumerTenant
  let late: SeededRoute
  let onTime: SeededRoute
  let stale: SeededRoute
  let running: SeededRoute
  let sessionId: string
  let expiredDriverId: string
  let suspendedDriverId: string
  let overdueTicketId: string
  let laterTicketId: string
  const lines: string[] = []
  /** The tick's clock: 07:10 on the fixtures' Monday, Copenhagen's. */
  let NOW = at("07:10")
  const context = () => ({ api, worker, now: () => NOW, log: (line: string) => void lines.push(line) }) as JobContext

  const alerts = () => withCompany(api.db, tenant.companyId, (tx) => tx.select().from(alert).where(eq(alert.companyId, tenant.companyId)).orderBy(asc(alert.id)))
  const alertOf = async (rule: string, subjectId: string) => (await alerts()).filter((row) => row.rule === rule && [row.routeId, row.driverId, row.ticketId].includes(subjectId))
  const setRoute = (id: string, values: Partial<typeof route.$inferInsert>) => withCompany(api.db, tenant.companyId, (tx) => tx.update(route).set(values).where(and(eq(route.companyId, tenant.companyId), eq(route.id, id))))
  const openTicketDue = async (dueAt: Date | null, subject: string): Promise<string> => {
    const { row } = await withCompany(api.db, tenant.companyId, (tx) =>
      openTicket(tx, {
        companyId: tenant.companyId,
        draft: {
          projectId: tenant.projectId,
          kind: "complaint",
          priority: "high",
          source: "phone",
          subject,
          description: "Called in by the resident",
          occurredAt: at("05:00"),
          dueAt,
          assigneeUserAccountId: null,
          links: { routeId: null, pickupId: null, containerId: null, propertyId: null, sharedCollectionPointId: null, customerId: null, agreementId: null, driverId: null, parentTicketId: null },
          alertId: null,
        },
        createdBy: tenant.officeUserId,
        sourceEventId: null,
        newId: testId,
        now: () => at("05:00"),
      }),
    )
    return row.id
  }

  before(async () => {
    if (roles.skip) return
    admin = createDb(roles.adminUrl, { max: 1 })
    await admin.sql.unsafe(`create database "${name}"`)
    await migrateDatabase(withDatabaseName(roles.adminUrl, name))
    api = createDb(withDatabaseName(roles.apiUrl, name), { max: 2 })
    worker = createDb(withDatabaseName(roles.workerUrl, name), { max: 2 })
    tenant = await seedConsumerTenant(api)

    // Four planned routes on the fixtures' Monday: one late, one not yet due, one planned two days ago and never started, one running with a device.
    late = await seedRoute(api, tenant, { status: "planned", pickups: [{ container: "bin1", status: "planned" }] })
    await setRoute(late.id, { plannedStartTime: "06:30" })
    onTime = await seedRoute(api, tenant, { status: "planned", pickups: [{ container: "bin1", status: "planned" }] })
    await setRoute(onTime.id, { plannedStartTime: "07:15" })
    stale = await seedRoute(api, tenant, { status: "planned", pickups: [{ container: "bin1", status: "planned" }] })
    await setRoute(stale.id, { plannedStartTime: "06:30", operatingDate: "2026-10-03", serviceDate: "2026-10-03" })
    running = await seedRoute(api, tenant, { status: "active", pickups: [{ container: "bin2", status: "planned" }] })
    await setRoute(running.id, { plannedStartTime: "06:00" })
    sessionId = testId()
    await withCompany(api.db, tenant.companyId, (tx) =>
      tx.insert(session).values({ id: sessionId, companyId: tenant.companyId, projectId: tenant.projectId, routeId: running.id, driverId: tenant.driverId, vehicleId: tenant.vehicleId, deviceId: "device-1", startedAt: at("06:05"), lastSeenAt: at("06:50") }),
    )

    // The licences: Freja's runs out in fifteen days, a third driver's ran out, and a suspended driver's ran out but plans nothing.
    expiredDriverId = testId()
    suspendedDriverId = testId()
    await withCompany(api.db, tenant.companyId, async (tx) => {
      await tx.update(driver).set({ licenceExpiry: "2026-10-20" }).where(and(eq(driver.companyId, tenant.companyId), eq(driver.id, tenant.otherDriverId)))
      await tx.insert(driver).values([
        { id: expiredDriverId, companyId: tenant.companyId, projectId: tenant.projectId, name: "Ole Berg", employment: "employee", licenceClass: "c", licenceExpiry: "2026-10-01", status: "active" },
        { id: suspendedDriverId, companyId: tenant.companyId, projectId: tenant.projectId, name: "Sara Lund", employment: "employee", licenceClass: "c", licenceExpiry: "2026-09-01", status: "suspended" },
      ])
    })

    // The tickets: one an hour past due, one due later, one without a due date.
    overdueTicketId = await openTicketDue(at("06:00"), "Bin left on the pavement")
    laterTicketId = await openTicketDue(at("12:00"), "Lid broken")
    await openTicketDue(null, "Question about the calendar")
  })

  after(async () => {
    await Promise.allSettled([api?.close(), worker?.close()])
    try {
      await admin?.sql.unsafe(`drop database if exists "${name}" with (force)`)
    } finally {
      await admin?.close()
    }
  })

  test("a tick raises one alert per occurrence: the late route, the silent device, the two licences and the overdue ticket, each in its words", async () => {
    assert.deepEqual(await runAlertRules(context()), { raised: 5, cleared: 0 })
    const raised = await alerts()
    assert.deepEqual(
      raised.map((row) => [row.rule, row.kind, row.severity, row.source, row.status]).sort(),
      [
        ["licence-expiring", "resource", "high", "rule", "new"],
        ["licence-expiring", "resource", "medium", "rule", "new"],
        ["route-not-started", "route-exception", "high", "rule", "new"],
        ["session-silent", "route-exception", "medium", "execution", "new"],
        ["ticket-overdue", "service-risk", "high", "rule", "new"],
      ],
    )
    const [lateAlert] = await alertOf("route-not-started", late.id)
    assert.deepEqual([lateAlert.title, lateAlert.details, lateAlert.ruleKey, lateAlert.driverId, lateAlert.vehicleId], [`${late.label} has not started`, "Planned to start at 06:30 on 2026-10-05, and still not started 30 minutes later.", `route-not-started:${late.id}:2026-10-05T06:30`, tenant.driverId, tenant.vehicleId])
    assert.deepEqual([lateAlert.raisedBy, lateAlert.detectedAt.toISOString(), lateAlert.projectId], [null, NOW.toISOString(), tenant.projectId])
    const [silent] = await alertOf("session-silent", running.id)
    assert.equal(silent.title, `Mads Jensen's device is silent on ${running.label}`)
    assert.equal(silent.details, "Last heard from at 06:50, and nothing from the Driver App for 15 minutes since.")
    assert.match(silent.ruleKey ?? "", new RegExp(`^session-silent:${sessionId}:2026-10-05T04:50:00\\.000000Z$`))
    const [expired] = await alertOf("licence-expiring", expiredDriverId)
    assert.deepEqual([expired.title, expired.ruleKey], ["Ole Berg's licence has expired", `licence-expiring:${expiredDriverId}:2026-10-01:expired`])
    const [expiring] = await alertOf("licence-expiring", tenant.otherDriverId)
    assert.deepEqual([expiring.title, expiring.details], ["Freja Holm's licence expires on 2026-10-20", "Renew it before 2026-10-20, or the driver cannot be planned on a route after it."])
    const [overdue] = await alertOf("ticket-overdue", overdueTicketId)
    assert.deepEqual([overdue.title, overdue.details, overdue.routeId, overdue.driverId], [`T-${(await ticketNumber(overdueTicketId))} is overdue`, "Bin left on the pavement was due 2026-10-05 06:00.", null, null])
    // Not yet late, planned two days ago, not yet due, and suspended: nothing.
    for (const quiet of [onTime.id, stale.id, laterTicketId, suspendedDriverId]) assert.ok(!raised.some((row) => [row.routeId, row.driverId, row.ticketId].includes(quiet)), quiet)
    assert.equal(lines.at(-1), "alert rules: raised 5, cleared 0")
  })

  test("the next tick raises nothing twice and reads nothing: a quiet tick is five empty results and no write", async () => {
    assert.deepEqual(await occurrencesToRaise(worker, NOW), [])
    assert.deepEqual(await alertsToClear(worker, NOW), [])
    const before = lines.length
    assert.deepEqual(await runAlertRules(context()), { raised: 0, cleared: 0 })
    assert.equal(lines.length, before, "a quiet tick says nothing")
    assert.equal((await alerts()).length, 5)
  })

  test("a condition that clears resolves its alert with no account and the rule's note: the route started, the device heard from, the ticket re-dated", async () => {
    await setRoute(late.id, { status: "cancelled", cancelledAt: at("07:12") })
    await withCompany(api.db, tenant.companyId, (tx) => tx.update(session).set({ lastSeenAt: at("07:11") }).where(and(eq(session.companyId, tenant.companyId), eq(session.id, sessionId))))
    await withCompany(api.db, tenant.companyId, (tx) => tx.update(ticket).set({ dueAt: at("18:00") }).where(and(eq(ticket.companyId, tenant.companyId), eq(ticket.id, overdueTicketId))))
    NOW = at("07:12")
    assert.deepEqual(await runAlertRules(context()), { raised: 0, cleared: 3 })
    for (const [rule, subject] of [["route-not-started", late.id], ["session-silent", running.id], ["ticket-overdue", overdueTicketId]] as const) {
      const [row] = await alertOf(rule, subject)
      assert.deepEqual([row.status, row.resolvedBy, row.resolutionNote, row.resolvedAt?.toISOString()], ["resolved", null, CLEARED_NOTES[rule], NOW.toISOString()], rule)
    }
  })

  test("a device silent again is a new occurrence and a new alert; a person's resolve holds while its condition does", async () => {
    NOW = at("07:30")
    assert.deepEqual(await runAlertRules(context()), { raised: 1, cleared: 0 })
    const silences = await alertOf("session-silent", running.id)
    assert.deepEqual(silences.map((row) => row.status), ["resolved", "new"])
    assert.match(silences[1].ruleKey ?? "", /:2026-10-05T05:11:00\.000000Z$/)

    const [expired] = await alertOf("licence-expiring", expiredDriverId)
    await withCompany(api.db, tenant.companyId, (tx) => tx.update(alert).set({ status: "resolved", resolvedAt: NOW, resolvedBy: tenant.officeUserId, resolutionNote: "Licence renewal booked" }).where(and(eq(alert.companyId, tenant.companyId), eq(alert.id, expired.id))))
    NOW = at("07:40")
    assert.deepEqual(await runAlertRules(context()), { raised: 0, cleared: 0 })
    assert.equal((await alertOf("licence-expiring", expiredDriverId)).length, 1, "resolved by a person, not raised again")
  })

  test("a route moved to another start clears its alert, and its new start, once missed, is a new one", async () => {
    await setRoute(onTime.id, { plannedStartTime: "06:00" })
    assert.deepEqual(await runAlertRules(context()), { raised: 1, cleared: 0 })
    await setRoute(onTime.id, { plannedStartTime: "07:20" })
    assert.deepEqual(await runAlertRules(context()), { raised: 0, cleared: 1 }, "moved to 07:20, it is not late at 07:40")
    NOW = at("07:55")
    assert.deepEqual(await runAlertRules(context()), { raised: 1, cleared: 0 })
    const moved = await alertOf("route-not-started", onTime.id)
    assert.deepEqual(
      moved.map((row) => [row.ruleKey, row.status]),
      [
        [`route-not-started:${onTime.id}:2026-10-05T06:00`, "resolved"],
        [`route-not-started:${onTime.id}:2026-10-05T07:20`, "new"],
      ],
    )
  })

  test("a condition the worker cleared that comes back is raised again: a ticket re-dated and dated back", async () => {
    await withCompany(api.db, tenant.companyId, (tx) => tx.update(ticket).set({ dueAt: at("06:00") }).where(and(eq(ticket.companyId, tenant.companyId), eq(ticket.id, overdueTicketId))))
    assert.deepEqual(await runAlertRules(context()), { raised: 1, cleared: 0 })
    assert.deepEqual((await alertOf("ticket-overdue", overdueTicketId)).map((row) => row.status), ["resolved", "new"])
  })

  test("a licence that runs out while warned of clears its warning and is raised again as expired; one renewed clears", async () => {
    await withCompany(api.db, tenant.companyId, (tx) => tx.update(driver).set({ licenceExpiry: "2026-10-04" }).where(and(eq(driver.companyId, tenant.companyId), eq(driver.id, tenant.otherDriverId))))
    assert.deepEqual(await runAlertRules(context()), { raised: 1, cleared: 1 })
    const [warning, expired] = await alertOf("licence-expiring", tenant.otherDriverId)
    assert.deepEqual([warning.status, warning.resolutionNote, expired.severity, expired.title], ["resolved", CLEARED_NOTES["licence-expiring"], "high", "Freja Holm's licence has expired"])
    await withCompany(api.db, tenant.companyId, (tx) => tx.update(driver).set({ licenceExpiry: "2031-10-20" }).where(and(eq(driver.companyId, tenant.companyId), eq(driver.id, tenant.otherDriverId))))
    assert.deepEqual(await runAlertRules(context()), { raised: 0, cleared: 1 })
    assert.deepEqual((await alertOf("licence-expiring", tenant.otherDriverId)).map((row) => row.status), ["resolved", "resolved"])
  })

  async function ticketNumber(id: string): Promise<number> {
    const [row] = await withCompany(api.db, tenant.companyId, (tx) => tx.select({ number: ticket.number }).from(ticket).where(and(eq(ticket.companyId, tenant.companyId), eq(ticket.id, id))))
    return row.number
  }
})
