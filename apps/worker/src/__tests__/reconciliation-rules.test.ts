// The disposal-site reconciliation (M17 of #293, row 28.4), on a database of
// its own since the rules read across companies: an outbound load not received
// a day after it left, a receipt beyond the project's tolerance, a load over
// our vehicle's rated payload, and a completed route that planned a station and
// never tipped, each raised once about its load or its route; and each cleared
// by the worker once the receipt is recorded, the load reconciled or cancelled,
// or an unload recorded. A route that planned no station is not judged.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { createDb, type Database } from "@waste/db/client"
import { migrateDatabase } from "@waste/db/migrate"
import { route, unload } from "@waste/db/schema/execution"
import { vehicle } from "@waste/db/schema/fleet"
import { outboundLoad } from "@waste/db/schema/haul-out"
import { unloadingStation } from "@waste/db/schema/places"
import { alert } from "@waste/db/schema/resolution"
import { withCompany } from "@waste/db/tenant"
import { CLEARED_NOTES } from "@waste/domain/resolution/alert-rules"
import { and, asc, eq, isNotNull } from "drizzle-orm"

import type { JobContext } from "../jobs/definition"
import { runAlertRules } from "../jobs/alert-rules"
import { at, seedConsumerTenant, seedRoute, testId, type ConsumerTenant, type SeededRoute } from "./consumer-fixtures"
import { rolesUnderTest, withDatabaseName } from "./database"

const roles = rolesUnderTest()

const HOUR_MS = 3_600_000

describe("the disposal-site reconciliation", { skip: roles.skip }, () => {
  const name = `waste_worker_haul_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  let admin: Database
  let api: Database
  let worker: Database
  let tenant: ConsumerTenant
  /** Completed at 13:00 with a collected stop, planned to unload at the plant, and no unload. */
  let untipped: SeededRoute
  /** Completed the same way, but planning no station: not judged. */
  let unplanned: SeededRoute
  const stations = { transfer: testId(), plant: testId() }
  const loads = { unreceived: testId(), mismatched: testId(), overweight: testId() }
  /** Three hours after the routes ended. */
  let NOW = at("16:00")
  const context = () => ({ api, worker, now: () => NOW, log: (line: string) => void line }) as JobContext

  const ruleAlerts = () =>
    withCompany(api.db, tenant.companyId, (tx) =>
      tx
        .select({ rule: alert.rule, status: alert.status, routeId: alert.routeId, outboundLoadId: alert.outboundLoadId, vehicleId: alert.vehicleId, title: alert.title, note: alert.resolutionNote })
        .from(alert)
        .where(and(eq(alert.companyId, tenant.companyId), isNotNull(alert.rule)))
        .orderBy(asc(alert.rule), asc(alert.id)),
    )
  const setLoad = (id: string, values: Partial<typeof outboundLoad.$inferInsert>) =>
    withCompany(api.db, tenant.companyId, (tx) => tx.update(outboundLoad).set(values).where(and(eq(outboundLoad.companyId, tenant.companyId), eq(outboundLoad.id, id))))

  before(async () => {
    if (roles.skip) return
    admin = createDb(roles.adminUrl, { max: 1 })
    await admin.sql.unsafe(`create database "${name}"`)
    await migrateDatabase(withDatabaseName(roles.adminUrl, name))
    api = createDb(withDatabaseName(roles.apiUrl, name), { max: 2 })
    worker = createDb(withDatabaseName(roles.workerUrl, name), { max: 2 })
    tenant = await seedConsumerTenant(api)
    untipped = await seedRoute(api, tenant, { status: "completed", pickups: [{ container: "bin1", status: "completed" }] })
    unplanned = await seedRoute(api, tenant, { status: "completed", pickups: [{ container: "bin2", status: "completed" }] })
    const { companyId, projectId } = tenant
    await withCompany(api.db, companyId, async (tx) => {
      const place = (id: string, code: string, ownership: string, transfer: boolean) => ({ id, companyId, code, name: code, address: "Havnevej 2", location: { type: "Point" as const, coordinates: [12.6, 55.7] as [number, number] }, ownership, transfer, status: "active" })
      await tx.insert(unloadingStation).values([place(stations.transfer, "Kystbyen omlastestation", "company", true), place(stations.plant, "ARC Amager Bakke", "external", false)])
      await tx.update(route).set({ unloadingStationId: stations.plant }).where(and(eq(route.companyId, companyId), eq(route.id, untipped.id)))
      await tx.update(vehicle).set({ capacityKg: 26_000 }).where(and(eq(vehicle.companyId, companyId), eq(vehicle.id, tenant.vehicleId)))
      const load = (id: string, departedAt: Date, netKg: number, values: Partial<typeof outboundLoad.$inferInsert> = {}) => ({
        id,
        companyId,
        projectId,
        fromStationId: stations.transfer,
        toStationId: stations.plant,
        wasteFractionId: tenant.fractionId,
        vehicleRegistration: "AB 12 345",
        departedAt,
        netKg,
        status: "departed",
        ...values,
      })
      await tx.insert(outboundLoad).values([
        load(loads.unreceived, new Date(NOW.getTime() - 30 * HOUR_MS), 20_000),
        load(loads.mismatched, new Date(NOW.getTime() - 5 * HOUR_MS), 20_000, { status: "received", receivingTicket: "ARC-88123", receivedNetKg: 18_400, receivedAt: new Date(NOW.getTime() - 4 * HOUR_MS) }),
        load(loads.overweight, new Date(NOW.getTime() - HOUR_MS), 27_400, { vehicleId: tenant.vehicleId }),
      ])
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

  test("raises each occurrence once, about its load or its route, and leaves a route that planned no station alone", async () => {
    await runAlertRules(context())
    NOW = new Date(NOW.getTime() + 5 * 60_000)
    await runAlertRules(context())
    const raised = await ruleAlerts()
    assert.deepEqual(
      raised.map((row) => [row.rule, row.status, row.outboundLoadId, row.routeId]),
      [
        ["load-not-received", "new", loads.unreceived, null],
        ["load-overweight", "new", loads.overweight, null],
        ["load-weight-mismatch", "new", loads.mismatched, null],
        ["route-not-tipped", "new", null, untipped.id],
      ],
    )
    assert.equal(raised.find((row) => row.rule === "load-overweight")?.vehicleId, tenant.vehicleId)
    assert.equal(raised.find((row) => row.rule === "load-weight-mismatch")?.title, "ARC Amager Bakke weighed AB 12 345's load 1,600 kg lighter")
    assert.ok(!raised.some((row) => row.routeId === unplanned.id))
  })

  test("a receipt corrected beyond the tolerance again is a new occurrence, its predecessor cleared", async () => {
    await setLoad(loads.mismatched, { receivingTicket: "ARC-88124", receivedNetKg: 22_000 })
    await runAlertRules(context())
    const mismatches = (await ruleAlerts()).filter((row) => row.rule === "load-weight-mismatch")
    assert.deepEqual(
      mismatches.map((row) => row.status),
      ["resolved", "new"],
    )
  })

  test("clears each once the receipt is recorded, the load reconciled or cancelled, or an unload recorded", async () => {
    await setLoad(loads.unreceived, { status: "received", receivingTicket: "ARC-90001", receivedNetKg: 19_900, receivedAt: NOW })
    await setLoad(loads.mismatched, { status: "reconciled" })
    await setLoad(loads.overweight, { status: "cancelled", note: "Reloaded on two trucks" })
    await withCompany(api.db, tenant.companyId, (tx) =>
      tx.insert(unload).values({ companyId: tenant.companyId, projectId: tenant.projectId, routeId: untipped.id, unloadingStationId: stations.plant, wasteFractionId: tenant.fractionId, source: "dispatch", occurredAt: at("12:40"), recordedBy: tenant.officeUserId, netKg: 8_540 }),
    )
    await runAlertRules(context())
    const now = await ruleAlerts()
    assert.deepEqual(
      now.map((row) => [row.rule, row.status]),
      [
        ["load-not-received", "resolved"],
        ["load-overweight", "resolved"],
        ["load-weight-mismatch", "resolved"],
        ["load-weight-mismatch", "resolved"],
        ["route-not-tipped", "resolved"],
      ],
    )
    assert.equal(now.find((row) => row.rule === "route-not-tipped")?.note, CLEARED_NOTES["route-not-tipped"])
  })
})
