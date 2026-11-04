// The fill-driven emptying (O26 of #290), on a database of its own
// since the rules read across companies: a container whose pairing books an
// emptying, read past its threshold, gets the office's emptying on the
// earliest route of its round ahead of its next scheduled one — once, however
// many ticks and fillings follow while it is planned — and the alert says so;
// a container with no emptying to bring forward, or a pairing that books
// none, is told or left alone.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { routeLabel } from "@waste/contracts/execution"
import { createDb, type Database } from "@waste/db/client"
import { nextNumber } from "@waste/db/commands/shared"
import { migrateDatabase } from "@waste/db/migrate"
import { pickup, route } from "@waste/db/schema/execution"
import { alert } from "@waste/db/schema/resolution"
import { fillReading, sensor, sensorPairing } from "@waste/db/schema/sensors"
import { withCompany } from "@waste/db/tenant"
import { and, asc, eq } from "drizzle-orm"

import type { JobContext } from "../jobs/definition"
import { runAlertRules } from "../jobs/alert-rules"
import { at, seedConsumerTenant, seedRoute, testId, type ConsumerTenant, type SeededRoute } from "./consumer-fixtures"
import { rolesUnderTest, withDatabaseName } from "./database"

const roles = rolesUnderTest()

describe("the fill-driven emptying", { skip: roles.skip }, () => {
  const name = `waste_worker_fill_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  let admin: Database
  let api: Database
  let worker: Database
  let tenant: ConsumerTenant
  /** BIN-1's next scheduled emptying, on Friday the 9th. */
  let next: SeededRoute
  /** The round's routes before it: Wednesday's and Tuesday's. */
  const ahead = { tuesday: { id: testId(), number: 0 }, wednesday: { id: testId(), number: 0 } }
  const pairings = { bin1: testId(), bin2: testId() }
  const sensors = { bin1: testId(), bin2: testId() }
  let NOW = at("09:00")
  const context = () => ({ api, worker, now: () => NOW, log: (line: string) => void line }) as JobContext

  const reads = (which: keyof typeof pairings, time: string, fillPercent: number) =>
    withCompany(api.db, tenant.companyId, (tx) => tx.insert(fillReading).values({ companyId: tenant.companyId, projectId: tenant.projectId, sensorId: sensors[which], pairingId: pairings[which], measuredAt: at(time), fillPercent }))
  const officeStops = (routeId: string) =>
    withCompany(api.db, tenant.companyId, (tx) =>
      tx.select().from(pickup).where(and(eq(pickup.companyId, tenant.companyId), eq(pickup.routeId, routeId), eq(pickup.origin, "office"))).orderBy(asc(pickup.position)),
    )
  const fillAlerts = (containerId: string) =>
    withCompany(api.db, tenant.companyId, (tx) => tx.select().from(alert).where(and(eq(alert.companyId, tenant.companyId), eq(alert.containerId, containerId), eq(alert.rule, "fill-threshold"))).orderBy(asc(alert.id)))

  before(async () => {
    if (roles.skip) return
    admin = createDb(roles.adminUrl, { max: 1 })
    await admin.sql.unsafe(`create database "${name}"`)
    await migrateDatabase(withDatabaseName(roles.adminUrl, name))
    api = createDb(withDatabaseName(roles.apiUrl, name), { max: 2 })
    worker = createDb(withDatabaseName(roles.workerUrl, name), { max: 2 })
    tenant = await seedConsumerTenant(api)

    next = await seedRoute(api, tenant, { status: "planned", pickups: [{ container: "bin1", status: "planned" }] })
    await withCompany(api.db, tenant.companyId, async (tx) => {
      await tx.update(route).set({ operatingDate: "2026-10-09", serviceDate: "2026-10-09" }).where(and(eq(route.companyId, tenant.companyId), eq(route.id, next.id)))
      for (const [day, row] of [["2026-10-07", ahead.wednesday], ["2026-10-06", ahead.tuesday]] as const) {
        row.number = await nextNumber(tx, tenant.companyId, "nextRouteNumber")
        await tx.insert(route).values({ id: row.id, companyId: tenant.companyId, projectId: tenant.projectId, routeSchemeId: tenant.schemeId, collectionGroupId: next.collectionGroupId, serviceDate: day, operatingDate: day, status: "planned", number: row.number, plannedDriverId: tenant.driverId, plannedVehicleId: tenant.vehicleId })
      }
      for (const which of ["bin1", "bin2"] as const) {
        await tx.insert(sensor).values({ id: sensors[which], companyId: tenant.companyId, projectId: tenant.projectId, identifier: `S-${which}`, network: "lorawan", status: "active" })
        await tx.insert(sensorPairing).values({ id: pairings[which], companyId: tenant.companyId, projectId: tenant.projectId, sensorId: sensors[which], containerId: tenant.containers[which].id, fullThresholdPercent: 85, booksEmptying: true, validFrom: "2026-10-01" })
      }
    })
  })

  after(async () => {
    await Promise.allSettled([api?.close(), worker?.close()])
    try {
      await admin?.sql.unsafe(`drop database if exists "${name}" with (force)`)
    } finally {
      await admin?.close()
    }
  })

  test("a filling books the office's emptying on the round's earliest route before the next scheduled one, and the alert says so", async () => {
    await reads("bin1", "08:00", 40)
    await reads("bin1", "08:30", 92)
    await runAlertRules(context())
    const [stop, ...more] = await officeStops(ahead.tuesday.id)
    assert.deepEqual(more, [])
    assert.deepEqual([stop?.service, stop?.status, stop?.containerId, stop?.propertyId, stop?.wasteFractionId, stop?.position], ["empty", "planned", tenant.containers.bin1.id, tenant.properties.parkvej.id, tenant.fractionId, 1])
    assert.equal(stop?.note, "Emptying brought forward: sensor S-bin1 read 92% at 2026-10-05 08:30.")
    assert.deepEqual(await officeStops(ahead.wednesday.id), [], "the earliest route alone")
    const [raised] = await fillAlerts(tenant.containers.bin1.id)
    assert.match(raised?.details ?? "", new RegExp(`An emptying is booked on ${routeLabel(ahead.tuesday.number)} on 2026-10-06\\.$`))
  })

  test("is booked once: the next tick books nothing more, and a new filling while the stop is planned finds it booked", async () => {
    NOW = at("09:05")
    await runAlertRules(context())
    assert.equal((await officeStops(ahead.tuesday.id)).length, 1)
    await reads("bin1", "09:10", 30)
    NOW = at("09:11")
    await runAlertRules(context())
    await reads("bin1", "09:20", 95)
    NOW = at("09:21")
    await runAlertRules(context())
    assert.equal((await officeStops(ahead.tuesday.id)).length, 1, "the planned stop is this filling's too")
    const alerts = await fillAlerts(tenant.containers.bin1.id)
    assert.deepEqual(alerts.map((row) => row.status), ["resolved", "new"])
    assert.match(alerts[1]?.details ?? "", /An emptying is booked on/)
  })

  test("a container with no emptying planned to bring forward is told so, and a pairing that books none is only alerted", async () => {
    await reads("bin2", "09:30", 90)
    NOW = at("09:31")
    await runAlertRules(context())
    const [told] = await fillAlerts(tenant.containers.bin2.id)
    assert.match(told?.details ?? "", /No emptying is booked: no emptying of it is planned to bring forward\.$/)

    await withCompany(api.db, tenant.companyId, (tx) => tx.update(sensorPairing).set({ booksEmptying: false }).where(and(eq(sensorPairing.companyId, tenant.companyId), eq(sensorPairing.id, pairings.bin2))))
    await reads("bin2", "09:40", 10)
    await reads("bin2", "09:50", 99)
    NOW = at("09:51")
    await runAlertRules(context())
    const [, quiet] = await fillAlerts(tenant.containers.bin2.id)
    assert.match(quiet?.details ?? "", /empty it before it overflows\.$/, "no word of an emptying")
  })

  test("a next emptying soon enough books nothing and says when it is", async () => {
    // Moved to run tomorrow (its service date stays Friday's, a route's identity): soon enough.
    await withCompany(api.db, tenant.companyId, (tx) => tx.update(route).set({ operatingDate: "2026-10-06" }).where(and(eq(route.companyId, tenant.companyId), eq(route.id, next.id))))
    await reads("bin1", "10:00", 20)
    NOW = at("10:01")
    await runAlertRules(context())
    await reads("bin1", "10:10", 88)
    NOW = at("10:11")
    await runAlertRules(context())
    const latest = (await fillAlerts(tenant.containers.bin1.id)).at(-1)
    assert.match(latest?.details ?? "", new RegExp(`No emptying is booked: its next emptying is on ${next.label} on 2026-10-06\\.$`))
  })
})
