// The Pilot's first generation over the seeded tenant (Issue #156, the
// runbook of #143): a database of this file's own, migrated and seeded by
// `seedDemo` as the owner — configured, never run — and then the nightly
// sweep and the generation job as the process runs them, the sweep as
// `wms_worker` and the writes as `wms_api` under `withCompany`, logins the
// local stack's (see generation.test.ts). What is proved: the sweep finds the
// two seeded schemes, validated with plan-ahead on; RS-Central · Week A's
// run plans the week's routes with WH-24, Mads Jensen and the Nordhavn depot
// and matches Residual containers inside the Indre By boundary; and
// RS-Østerbro · Organic B's run counts BIN-91007 — picked, and under no
// placement, since no product collects Metal — as unlocated, the run's
// warning for a pick it cannot place (its `warnings` hold the day-level
// sentences and stay empty), and writes no pickup for it, while the other
// three picks generate in their order.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { createDb, type Database } from "@waste/db/client"
import { FakeProvider } from "@waste/routing/fake"
import { migrateDatabase } from "@waste/db/migrate"
import { pickup, route } from "@waste/db/schema/execution"
import { generationRun } from "@waste/db/schema/generation"
import { DEMO_IDS, seedDemo } from "@waste/db/seed/demo"
import { asc, eq, inArray } from "drizzle-orm"

import type { JobContext } from "../jobs"
import { runGeneration } from "../jobs/generate-routes"
import { planAhead } from "../jobs/plan-ahead"
import { databaseUnderTest, ownerUnderTest, withDatabaseName, workerUnderTest } from "./database"

const owner = ownerUnderTest()
const apiRole = databaseUnderTest()
const workerRole = workerUnderTest()
const skip = owner.skip || apiRole.skip || workerRole.skip

/** Sunday 11 October 2026, evening in Copenhagen: the sweep plans Monday the 12th to Sunday the 18th, ISO week 42 — an even week, RS-Østerbro's. */
const NOW = new Date("2026-10-11T18:00:00Z")

describe("the Pilot's first generation over the seeded tenant", { skip }, () => {
  const name = `waste_worker_seeded_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  let admin: Database
  let ownerPool: Database
  let api: Database
  let worker: Database
  const lines: string[] = []

  const context = (): JobContext => ({ api, worker, now: () => NOW, log: (message) => void lines.push(message), send: async () => `sent-${lines.length}`, routing: new FakeProvider() })

  before(async () => {
    admin = createDb(owner.url, { max: 1 })
    await admin.sql.unsafe(`create database "${name}"`)
    const url = withDatabaseName(owner.url, name)
    await migrateDatabase(url)
    await seedDemo(url)
    ownerPool = createDb(url, { max: 2 })
    api = createDb(withDatabaseName(apiRole.url, name), { max: 2 })
    worker = createDb(withDatabaseName(workerRole.url, name), { max: 1 })
  })
  after(async () => {
    await api?.close()
    await worker?.close()
    await ownerPool?.close()
    try {
      await admin.sql.unsafe(`drop database if exists "${name}" with (force)`)
    } finally {
      await admin.close()
    }
  })

  /** The run the sweep wrote for a scheme, run to its end as the job runs it, and the row it leaves. */
  const generated = async (schemeId: string) => {
    const [queued] = await ownerPool.db.select().from(generationRun).where(eq(generationRun.routeSchemeId, schemeId))
    const outcome = await runGeneration({ generationRunId: queued.id, companyId: DEMO_IDS.company }, null, context())
    assert.equal(outcome.kind, "succeeded")
    const [run] = await ownerPool.db.select().from(generationRun).where(eq(generationRun.id, queued.id))
    const routes = await ownerPool.db.select().from(route).where(eq(route.routeSchemeId, schemeId)).orderBy(asc(route.serviceDate))
    const pickups = routes.length === 0 ? [] : await ownerPool.db.select().from(pickup).where(inArray(pickup.routeId, routes.map((row) => row.id))).orderBy(asc(pickup.routeId), asc(pickup.position))
    return { run, routes, pickups }
  }

  test("the nightly sweep finds both seeded schemes, validated with plan-ahead on, and writes each a run over the coming week", async () => {
    const outcome = await planAhead(context())
    assert.deepEqual([outcome.eligible, outcome.queued.length, outcome.failed], [2, 2, []])
    const runs = await ownerPool.db.select().from(generationRun).orderBy(asc(generationRun.routeSchemeId))
    assert.deepEqual(
      runs.map((row) => [row.routeSchemeId, row.trigger, row.windowFrom, row.windowTo, row.status]),
      [
        [DEMO_IDS.planning.routeSchemes["scheme-central-a"], "cron", "2026-10-12", "2026-10-18", "queued"],
        [DEMO_IDS.planning.routeSchemes["scheme-osterbro-b"], "cron", "2026-10-12", "2026-10-18", "queued"],
      ],
    )
  })

  test("RS-Central · Week A plans Monday to Friday with WH-24, Mads Jensen and the Nordhavn depot, its stops the Residual containers inside the Indre By boundary", async () => {
    const { planning, resources, registry } = DEMO_IDS
    const { run, routes, pickups } = await generated(planning.routeSchemes["scheme-central-a"])
    assert.deepEqual([run.status, run.routesCreated, run.unlocated, run.warnings], ["succeeded", 5, 0, []])
    assert.deepEqual(
      routes.map((row) => [row.serviceDate, row.status, row.collectionGroupId, row.plannedVehicleId, row.plannedDriverId, row.plannedServiceProviderId, row.depotId, row.unloadingStationId, row.plannedStartTime]),
      ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"].map((day) => [
        day,
        "planned",
        planning.collectionGroups["scheme-central-a:default"],
        resources.vehicles["vehicle-wh24"],
        resources.drivers["driver-mads"],
        null,
        resources.depots["depot-nordhavn"],
        null,
        "06:00:00",
      ]),
    )
    assert.ok(pickups.length > 0, "the rule matches")
    assert.equal(run.pickupsWritten, pickups.length)
    assert.ok(pickups.every((row) => row.wasteFractionId === registry.wasteFractions.residual))
    const [{ outside }] = await ownerPool.sql<{ outside: number }[]>`
      select count(*)::int as outside from wms.pickup p join wms.property pr on pr.id = p.property_id
      where p.id in ${ownerPool.sql(pickups.map((row) => row.id))}
        and not extensions.st_contains((select boundary from wms.planning_area_boundary where id = ${planning.planningAreaBoundaries["area-indreby"]}), pr.location)`
    assert.equal(outside, 0)
  })

  test("RS-Østerbro · Organic B warns of BIN-91007 as unlocated and writes it no pickup, while its other three picks generate in their order", async () => {
    const { planning, resources, registry, serviceProviders } = DEMO_IDS
    const { run, routes, pickups } = await generated(planning.routeSchemes["scheme-osterbro-b"])
    assert.deepEqual([run.status, run.routesCreated, run.pickupsWritten, run.unlocated, run.warnings], ["succeeded", 2, 6, 1, []])
    assert.deepEqual(
      routes.map((row) => [row.serviceDate, row.plannedVehicleId, row.plannedDriverId, row.plannedServiceProviderId]),
      [
        // No driver until the operator assigns one (#143).
        ["2026-10-13", resources.vehicles["vehicle-nr08"], null, serviceProviders.nordren],
        ["2026-10-15", resources.vehicles["vehicle-nr08"], null, serviceProviders.nordren],
      ],
    )
    for (const each of routes) {
      assert.deepEqual(
        pickups.filter((row) => row.routeId === each.id).map((row) => [row.position, row.containerId, row.propertyId, row.wasteFractionId]),
        [
          [1, registry.containers["asset-seed-91008"], registry.properties["property-seed-108"], registry.wasteFractions.residual],
          [2, registry.containers["asset-seed-91010"], registry.properties["property-seed-110"], registry.wasteFractions.paper],
          [3, registry.containers["asset-seed-91011"], registry.properties["property-seed-111"], registry.wasteFractions.cardboard],
        ],
      )
    }
    assert.ok(!pickups.some((row) => row.containerId === registry.containers["asset-seed-91007"]))
  })
})
