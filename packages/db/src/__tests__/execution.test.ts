// The Execution tables against Postgres (Issue #104, slice 1), on a fresh
// database of this file's own so that "migration 0008 applies to a clean
// database" is proved — the first `ALTER TABLE company`, the sync role and
// the publication included — and nothing depends on what the shared local
// database holds: the composite keys refuse another project's group, driver,
// depot, vehicle, property and container and another company's station,
// provider, fraction and account, and a proof, an unload or a receipt naming
// a pickup or a session of another route; the session's two partial uniques
// hold one live session per route and per driver; every shape check refuses
// its pair and the proof's CASE agrees with the domain's `proofShape` on
// every kind with each column set and unset; the API role can append to the
// three ledgers and update or delete nothing there while the owner can; the
// sync role reads every synced table across companies and writes nothing,
// and the publication is over exactly those tables; the counter's `update …
// returning` allocates disjoint blocks under two concurrent transactions;
// and the fence shows the API role exactly its company's rows in each of the
// seven. Every test but the counter's runs as the owner in a transaction that
// is rolled back, so nothing needs cleaning up; the counter's commits, and the
// database is dropped after.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import type { Point } from "@waste/contracts/geojson"
import { PROOF_SHAPES, proofShape, type ProofRow } from "@waste/domain/execution/proof-shapes"
import { PROOF_KINDS, type ProofKind, type RouteStatus } from "@waste/domain/execution/vocabulary"
import { and, eq, getTableName, sql } from "drizzle-orm"
import type { PgTable } from "drizzle-orm/pg-core"

import { createDb, type Database, type Tx } from "../client"
import { migrateDatabase } from "../migrate"
import { API_ROLE, SYNC_ROLE } from "../roles"
import { role, userAccount } from "../schema/access"
import { containerType, wasteFraction } from "../schema/catalogue"
import { container } from "../schema/containers"
import { property, sharedCollectionPoint } from "../schema/customers"
import { driverCommand, outboxEvent, pickup, proofOfService, route, session, unload } from "../schema/execution"
import { driver, vehicle } from "../schema/fleet"
import { vehicleType } from "../schema/fleet-types"
import { company, project, serviceProvider } from "../schema/organisation"
import { depot, unloadingStation } from "../schema/places"
import { collectionGroup, routeScheme } from "../schema/route-schemes"
import { PUBLICATION, syncedTableNames } from "../sql/publication"
import { withCompany } from "../tenant"
import { databaseUnderTest, freshDatabase, type FreshDatabase } from "./database"
import { refusedWith, rolledBack, rolledBackIn } from "./specimen"

const database = databaseUnderTest()

/** One company's fixture ids, a nibble telling the companies apart; this file's own bucket, on its own database. */
const ids = (n: "a" | "b") => ({
  company: `018f7c32-${n}000-7000-8000-000000000001`,
  project: `018f7c32-${n}000-7000-8000-000000000002`,
  role: `018f7c32-${n}000-7000-8000-000000000003`,
  account: `018f7c32-${n}000-7000-8000-000000000004`,
  wasteFraction: `018f7c32-${n}000-7000-8000-000000000005`,
  containerType: `018f7c32-${n}000-7000-8000-000000000006`,
  container: `018f7c32-${n}000-7000-8000-000000000007`,
  /** A second container, for a second pickup. */
  secondContainer: `018f7c32-${n}000-7000-8000-000000000008`,
  serviceProvider: `018f7c32-${n}000-7000-8000-000000000009`,
  property: `018f7c32-${n}000-7000-8000-00000000000a`,
  point: `018f7c32-${n}000-7000-8000-00000000000b`,
  vehicleType: `018f7c32-${n}000-7000-8000-00000000000c`,
  depot: `018f7c32-${n}000-7000-8000-00000000000d`,
  station: `018f7c32-${n}000-7000-8000-00000000000e`,
  vehicle: `018f7c32-${n}000-7000-8000-00000000000f`,
  trailer: `018f7c32-${n}000-7000-8000-000000000010`,
  driver: `018f7c32-${n}000-7000-8000-000000000011`,
  /** A second driver of the same project, for the one-session-per-driver rule. */
  secondDriver: `018f7c32-${n}000-7000-8000-000000000012`,
  scheme: `018f7c32-${n}000-7000-8000-000000000013`,
  group: `018f7c32-${n}000-7000-8000-000000000014`,
  route: `018f7c32-${n}000-7000-8000-000000000015`,
  /** A second route of the same group, on another day, planned. */
  secondRoute: `018f7c32-${n}000-7000-8000-000000000016`,
  pickup: `018f7c32-${n}000-7000-8000-000000000017`,
  /** A pickup of the second route. */
  secondPickup: `018f7c32-${n}000-7000-8000-000000000018`,
  session: `018f7c32-${n}000-7000-8000-000000000019`,
  proof: `018f7c32-${n}000-7000-8000-00000000001a`,
  unload: `018f7c32-${n}000-7000-8000-00000000001b`,
  command: `018f7c32-${n}000-7000-8000-00000000001c`,
  event: `018f7c32-${n}000-7000-8000-00000000001d`,
  /** Free for a test's own rows. */
  spare: `018f7c32-${n}000-7000-8000-0000000000e1`,
  other: `018f7c32-${n}000-7000-8000-0000000000e2`,
  third: `018f7c32-${n}000-7000-8000-0000000000e3`,
  fourth: `018f7c32-${n}000-7000-8000-0000000000e4`,
  /** A second project of the same company, with rows of its own that a record of the first may not name. */
  harbor: `018f7c32-${n}000-7000-8000-0000000000f1`,
  harborDepot: `018f7c32-${n}000-7000-8000-0000000000f2`,
  harborDriver: `018f7c32-${n}000-7000-8000-0000000000f3`,
  harborVehicle: `018f7c32-${n}000-7000-8000-0000000000f4`,
  harborScheme: `018f7c32-${n}000-7000-8000-0000000000f5`,
  harborGroup: `018f7c32-${n}000-7000-8000-0000000000f6`,
  harborProperty: `018f7c32-${n}000-7000-8000-0000000000f7`,
  harborContainer: `018f7c32-${n}000-7000-8000-0000000000f8`,
})
const a = ids("a")
const b = ids("b")

const NORDHAVN: Point = { type: "Point", coordinates: [12.5951, 55.7089] }
const AMAGER: Point = { type: "Point", coordinates: [12.6193, 55.6602] }
const OPENED = "2026-01-01"
const DAY = "2026-10-05"
/** A morning shift and the instants around it. */
const at = (hour: number, minute = 0): Date => new Date(Date.UTC(2026, 9, 5, hour, minute))

const tables: Record<string, PgTable> = { route, pickup, session, proofOfService, unload, driverCommand, outboxEvent }
const LEDGERS = ["proof_of_service", "unload", "driver_command"]

/** A company with what the other contexts lend it, and one row in each Execution table — two routes, an active one with its session and a planned one, a pickup on each — inserted as the owner in dependency order. */
async function seed(tx: Tx, n: "a" | "b"): Promise<void> {
  const own = ids(n)
  const tenant = { companyId: own.company }
  const scoped = { ...tenant, projectId: own.project }
  await tx.insert(company).values({ id: own.company, ...tenant, name: `Company ${n}`, legalName: `Company ${n} A/S`, registrationNumber: `1000000${n}`, country: "DK", status: "active" })
  await tx.insert(project).values({ id: own.project, ...tenant, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active" })
  await tx.insert(role).values({ id: own.role, ...tenant, name: "Driver", scope: "Company", description: "Drives", system: false })
  await tx.insert(userAccount).values({ id: own.account, ...tenant, email: `mads@${n}.example`, fullName: "Mads Jensen", roleId: own.role })
  await tx.insert(wasteFraction).values({ id: own.wasteFraction, ...tenant, key: "residual", name: "Residual waste" })
  await tx.insert(containerType).values({ id: own.containerType, ...tenant, name: "240 L bin", volumeLitres: 240 })
  await tx.insert(container).values([
    { id: own.container, ...scoped, label: "BIN-82014", containerTypeId: own.containerType, ownership: "company" },
    { id: own.secondContainer, ...scoped, label: "BIN-82015", containerTypeId: own.containerType, ownership: "company" },
  ])
  await tx.insert(serviceProvider).values({ id: own.serviceProvider, ...tenant, legalName: "NordRen ApS", registrationNumber: `4000000${n}`, country: "DK", contactName: "Lars Mikkelsen", contactEmail: `lars@${n}.example` })
  await tx.insert(property).values({ id: own.property, ...scoped, name: "Parkvej 18", address: "Parkvej 18", kind: "residential", status: "active", location: NORDHAVN })
  await tx.insert(sharedCollectionPoint).values({ id: own.point, ...scoped, name: "Miljøstation Nord", kind: "surface", address: "Parkvej 20", location: NORDHAVN, operatingModel: "municipal", accessMode: "open", billingMode: "municipal", status: "open" })
  await tx.insert(vehicleType).values({ id: own.vehicleType, ...tenant, key: "rear-loader", name: "Rear loader" })
  await tx.insert(depot).values({ id: own.depot, ...scoped, code: "DEP-NORD", name: "Nordhavn", address: "Sundkrogsgade 1", location: NORDHAVN, ownership: "company", status: "active" })
  await tx.insert(unloadingStation).values({ id: own.station, ...tenant, code: "ARC", name: "ARC Amager", address: "Vindmøllevej 6", location: AMAGER, ownership: "external", status: "active", weighbridge: true })
  await tx.insert(vehicle).values([
    { id: own.vehicle, ...scoped, registration: `CN 42 01${n === "a" ? 8 : 9}`, callsign: "WH-24", kind: "powered-vehicle", vehicleTypeId: own.vehicleType, ownership: "company", status: "active", requiredLicenceClass: "c", homeDepotId: own.depot },
    { id: own.trailer, ...scoped, registration: `TR 10 00${n === "a" ? 1 : 2}`, kind: "trailer", vehicleTypeId: own.vehicleType, ownership: "company", status: "active", requiredLicenceClass: "ce" },
  ])
  await tx.insert(driver).values([
    { id: own.driver, ...scoped, name: "Mads Jensen", employment: "employee", licenceClass: "ce", userAccountId: own.account, status: "active", homeDepotId: own.depot },
    { id: own.secondDriver, ...scoped, name: "Karen Holt", employment: "employee", licenceClass: "c", status: "active" },
  ])
  await tx.insert(routeScheme).values({ id: own.scheme, ...scoped, validFrom: OPENED, name: "Residual weekly", serviceType: "container-collection", frequency: "weekly", serviceDays: ["monday"], plannedStartTime: "06:30", depotId: own.depot, unloadingStationId: own.station })
  await tx.insert(collectionGroup).values({ id: own.group, ...scoped, routeSchemeId: own.scheme, name: "Rear loaders", position: 1, days: ["monday"], stopSource: "rule", ruleVehicleTypeId: own.vehicleType, vehicleId: own.vehicle, driverId: own.driver })
  await tx.insert(route).values([
    {
      id: own.route,
      ...scoped,
      routeSchemeId: own.scheme,
      collectionGroupId: own.group,
      serviceDate: DAY,
      operatingDate: DAY,
      status: "active",
      number: n === "a" ? 1042 : 1043,
      plannedStartTime: "06:30",
      plannedVehicleId: own.vehicle,
      plannedDriverId: own.driver,
      depotId: own.depot,
      unloadingStationId: own.station,
      actualVehicleId: own.vehicle,
      actualDriverId: own.driver,
      dispatchedAt: at(5),
      startedAt: at(6),
    },
    { id: own.secondRoute, ...scoped, routeSchemeId: own.scheme, collectionGroupId: own.group, serviceDate: "2026-10-12", operatingDate: "2026-10-12", number: n === "a" ? 1044 : 1045, plannedDriverId: own.driver, plannedVehicleId: own.vehicle },
  ])
  await tx.insert(pickup).values([
    { id: own.pickup, ...scoped, routeId: own.route, containerId: own.container, position: 1, propertyId: own.property, wasteFractionId: own.wasteFraction },
    { id: own.secondPickup, ...scoped, routeId: own.secondRoute, containerId: own.container, position: 1, sharedCollectionPointId: own.point, wasteFractionId: own.wasteFraction },
  ])
  await tx.insert(session).values({ id: own.session, ...scoped, routeId: own.route, driverId: own.driver, vehicleId: own.vehicle, deviceId: `device-${n}`, appVersion: "1.4.0", startedAt: at(6), lastSeenAt: at(6, 5) })
  await tx.insert(proofOfService).values({ id: own.proof, ...scoped, routeId: own.route, pickupId: own.pickup, sessionId: own.session, kind: "arrival", source: "driver-app", occurredAt: at(6, 20), recordedBy: own.account, deviceId: `device-${n}`, location: NORDHAVN, locationAccuracyM: 8 })
  await tx.insert(unload).values({ id: own.unload, ...scoped, routeId: own.route, sessionId: own.session, unloadingStationId: own.station, wasteFractionId: own.wasteFraction, source: "driver-app", occurredAt: at(11), recordedBy: own.account, deviceId: `device-${n}`, grossKg: 12_400, tareKg: 8_200, netKg: 4_200, weighbridgeTicket: "WB-2026-3901" })
  await tx.insert(driverCommand).values({ id: own.command, ...scoped, routeId: own.route, sessionId: own.session, pickupId: own.pickup, driverId: own.driver, deviceId: `device-${n}`, kind: "arrive", occurredAt: at(6, 20), body: { pickupId: own.pickup }, outcome: "applied" })
  await tx.insert(outboxEvent).values({ id: own.event, ...scoped, kind: "route-started", aggregateKind: "route", aggregateId: own.route, occurredAt: at(6), payload: { id: own.route, status: "active" } })
}

/** A second project of company a, with a depot, a driver, a vehicle, a scheme with a group, a property and a container of its own. */
async function seedHarbor(tx: Tx): Promise<void> {
  const scoped = { companyId: a.company, projectId: a.harbor }
  await tx.insert(project).values({ id: a.harbor, companyId: a.company, name: "Harbor", kind: "Contract", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active" })
  await tx.insert(depot).values({ id: a.harborDepot, ...scoped, code: "DEP-HAV", name: "Havnen", address: "Havnegade 1", location: AMAGER, ownership: "company", status: "active" })
  await tx.insert(driver).values({ id: a.harborDriver, ...scoped, name: "Jonas Lind", employment: "employee", licenceClass: "ce", status: "active" })
  await tx.insert(vehicle).values({ id: a.harborVehicle, ...scoped, registration: "CN 99 001", kind: "powered-vehicle", vehicleTypeId: a.vehicleType, ownership: "company", status: "active", requiredLicenceClass: "c" })
  await tx.insert(routeScheme).values({ id: a.harborScheme, ...scoped, validFrom: OPENED, name: "Harbor weekly", serviceType: "container-collection", frequency: "weekly", serviceDays: ["tuesday"] })
  await tx.insert(collectionGroup).values({ id: a.harborGroup, ...scoped, routeSchemeId: a.harborScheme, name: "Harbor", position: 1, days: ["tuesday"], stopSource: "rule" })
  await tx.insert(property).values({ id: a.harborProperty, ...scoped, name: "Havnegade 2", address: "Havnegade 2", kind: "commercial", status: "active" })
  await tx.insert(container).values({ id: a.harborContainer, ...scoped, label: "BIN-90001", containerTypeId: a.containerType, ownership: "company" })
}

/** A sound planned route of company a's first project on another day, but for what a test overrides. */
const planned = (values: Partial<typeof route.$inferInsert>): typeof route.$inferInsert => ({
  id: a.spare,
  companyId: a.company,
  projectId: a.project,
  routeSchemeId: a.scheme,
  collectionGroupId: a.group,
  serviceDate: "2026-10-19",
  operatingDate: "2026-10-19",
  number: 1100,
  plannedVehicleId: a.vehicle,
  plannedDriverId: a.driver,
  depotId: a.depot,
  ...values,
})

/** A sound planned pickup of the second container on company a's active route, but for what a test overrides. */
const stop = (values: Partial<typeof pickup.$inferInsert>): typeof pickup.$inferInsert => ({
  id: a.spare,
  companyId: a.company,
  projectId: a.project,
  routeId: a.route,
  containerId: a.secondContainer,
  position: 2,
  propertyId: a.property,
  wasteFractionId: a.wasteFraction,
  ...values,
})

/** A sound driver-recorded proof of the seeded pickup, but for what a test overrides: a completion. */
const proof = (values: Partial<typeof proofOfService.$inferInsert>): typeof proofOfService.$inferInsert => ({
  id: a.spare,
  companyId: a.company,
  projectId: a.project,
  routeId: a.route,
  pickupId: a.pickup,
  sessionId: a.session,
  kind: "completion",
  source: "driver-app",
  occurredAt: at(6, 25),
  recordedBy: a.account,
  deviceId: "device-a",
  ...values,
})

/** A sound office-recorded unload on the active route, but for what a test overrides. */
const tipped = (values: Partial<typeof unload.$inferInsert>): typeof unload.$inferInsert => ({
  id: a.spare,
  companyId: a.company,
  projectId: a.project,
  routeId: a.route,
  unloadingStationId: a.station,
  wasteFractionId: a.wasteFraction,
  source: "dispatch",
  occurredAt: at(12),
  recordedBy: a.account,
  netKg: 3_000,
  ...values,
})

/** A sound applied receipt on the active route, but for what a test overrides. */
const receipt = (values: Partial<typeof driverCommand.$inferInsert>): typeof driverCommand.$inferInsert => ({
  id: a.spare,
  companyId: a.company,
  projectId: a.project,
  routeId: a.route,
  sessionId: a.session,
  pickupId: a.pickup,
  driverId: a.driver,
  deviceId: "device-a",
  kind: "complete-pickup",
  occurredAt: at(6, 25),
  body: { pickupId: a.pickup },
  outcome: "applied",
  ...values,
})

/** A sound open session for the second driver on the planned second route, but for what a test overrides. */
const shift = (values: Partial<typeof session.$inferInsert>): typeof session.$inferInsert => ({
  id: a.spare,
  companyId: a.company,
  projectId: a.project,
  routeId: a.secondRoute,
  driverId: a.secondDriver,
  vehicleId: a.vehicle,
  deviceId: "device-k",
  startedAt: at(7),
  lastSeenAt: at(7),
  ...values,
})

describe("the Execution tables against a fresh database", { skip: database.skip }, () => {
  let fresh: FreshDatabase
  let owner: Database

  before(async () => {
    fresh = await freshDatabase(database.adminUrl, "waste_execution")
    await migrateDatabase(fresh.url)
    owner = createDb(fresh.url, { max: 3 })
  })
  after(async () => {
    await owner?.close()
    await fresh?.drop()
  })

  /** The two companies seeded as the owner in a transaction that is rolled back. */
  const seeded = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
    rolledBack(owner.db, async (tx) => {
      await seed(tx, "a")
      await seed(tx, "b")
      return fn(tx)
    })

  test("0008 created the seven tables in wms, each fenced, four with the updated_at trigger and the three ledgers with none, and gave company its counter at 1000", async () => {
    const names = Object.values(tables).map(getTableName).sort()
    assert.equal(names.length, 7)
    const rows = await owner.sql<{ table: string; enabled: boolean; forced: boolean; policies: string[]; triggers: string[] | null }[]>`
      select c.relname as table, c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
        (select array_agg(p.policyname order by p.policyname) from pg_policies p where p.schemaname = 'wms' and p.tablename = c.relname) as policies,
        (select array_agg(t.tgname order by t.tgname) from pg_trigger t where t.tgrelid = c.oid and not t.tgisinternal) as triggers
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'wms' and c.relkind = 'r' and c.relname = any (${names}::text[])
      order by c.relname`
    assert.deepEqual(
      rows.map(({ table, enabled, forced, policies, triggers }) => ({ table, enabled, forced, policies, triggers })),
      names.map((table) => ({ table, enabled: true, forced: true, policies: [`${table}_tenant_fence`], triggers: LEDGERS.includes(table) ? null : [`${table}_touch_updated_at`] })),
    )
    const [counter] = await owner.sql<{ default: string; nullable: string }[]>`select column_default as default, is_nullable as nullable from information_schema.columns where table_schema = 'wms' and table_name = 'company' and column_name = 'next_route_number'`
    assert.deepEqual(counter, { default: "1000", nullable: "NO" })
  })

  test("and left the API role able to insert into the three ledgers and to update or delete nothing there, while the owner keeps every right", async () => {
    const rows = await owner.sql<{ relation: string; rolename: string; privilege: string; granted: boolean }[]>`
      select t.relation, r.rolename, p.privilege, has_table_privilege(r.rolename::name, ('wms.' || t.relation)::regclass, p.privilege) as granted
      from (values ('proof_of_service'), ('unload'), ('driver_command'), ('route'), ('outbox_event')) as t(relation),
           (values (${API_ROLE}::text), (current_user::text)) as r(rolename),
           (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) as p(privilege)
      order by t.relation, r.rolename, p.privilege`
    assert.equal(rows.length, 40)
    const denied = rows.filter((row) => !row.granted).map((row) => `${row.rolename} ${row.privilege} ${row.relation}`)
    assert.deepEqual(denied.sort(), LEDGERS.flatMap((ledger) => [`${API_ROLE} DELETE ${ledger}`, `${API_ROLE} UPDATE ${ledger}`]).sort())
  })

  test("and created wms_sync REPLICATION, BYPASSRLS and NOLOGIN, with SELECT on exactly the synced tables and nothing else, and the publication over exactly them", async () => {
    const [attributes] = await owner.sql<{ replication: boolean; bypassrls: boolean; login: boolean; superuser: boolean; owner_member: boolean }[]>`
      select r.rolreplication as replication, r.rolbypassrls as bypassrls, r.rolcanlogin as login, r.rolsuper as superuser, pg_has_role(current_user, ${SYNC_ROLE}, 'MEMBER') as owner_member
      from pg_roles r where r.rolname = ${SYNC_ROLE}`
    assert.deepEqual(attributes, { replication: true, bypassrls: true, login: false, superuser: false, owner_member: true })
    const privileges = await owner.sql<{ table: string; select: boolean; write: boolean }[]>`
      select c.relname as table,
        has_table_privilege(${SYNC_ROLE}, c.oid, 'SELECT') as select,
        has_table_privilege(${SYNC_ROLE}, c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE') as write
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'wms' and c.relkind = 'r'
      order by c.relname`
    const synced = [...syncedTableNames()].sort()
    assert.deepEqual(privileges.filter((row) => row.select).map((row) => row.table), synced)
    assert.deepEqual(privileges.filter((row) => row.write), [], "no write right on any table")
    assert.ok(privileges.length > synced.length, "there are tables it may not read")
    const published = await owner.sql<{ table: string }[]>`select tablename as table from pg_publication_tables where pubname = ${PUBLICATION} order by tablename`
    assert.deepEqual(published.map((row) => row.table), synced)
    const [schema] = await owner.sql<{ usage: boolean; extensions: boolean }[]>`select has_schema_privilege(${SYNC_ROLE}, 'wms', 'USAGE') as usage, has_schema_privilege(${SYNC_ROLE}, 'extensions', 'USAGE') as extensions`
    assert.deepEqual(schema, { usage: true, extensions: false })
  })

  test("as wms_sync, every synced table reads across companies — the fence bypassed by construction — and an insert is refused (42501)", () =>
    seeded(async (tx) => {
      await tx.execute(sql`set local role ${sql.raw(SYNC_ROLE)}`)
      const seen: Record<string, number> = {}
      for (const name of syncedTableNames()) {
        const [{ count }] = await tx.execute<{ count: number }>(sql`select count(*)::int as count from ${sql.identifier("wms")}.${sql.identifier(name)}`)
        seen[name] = count
      }
      // Both companies' rows: two of everything seeded once per company, four of what was seeded twice.
      assert.deepEqual(seen, {
        user_account: 2,
        waste_fraction: 2,
        container_type: 2,
        container: 4,
        property: 2,
        shared_collection_point: 2,
        depot: 2,
        unloading_station: 2,
        unloading_station_fraction: 0,
        vehicle: 4,
        driver: 4,
        route: 4,
        pickup: 4,
        session: 2,
        proof_of_service: 2,
        unload: 2,
        driver_command: 2,
      })
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(outboxEvent).values({ id: a.spare, companyId: a.company, projectId: a.project, kind: "route-started", aggregateKind: "route", aggregateId: a.route, occurredAt: at(6), payload: {} })), refusedWith("42501", /permission denied for table outbox_event/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(proofOfService).values(proof({}))), refusedWith("42501", /permission denied for table proof_of_service/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.select().from(outboxEvent)), refusedWith("42501", /permission denied for table outbox_event/), "a table the rules do not name is not readable either")
      await tx.execute(sql`reset role`)
    }))

  /** Row counts per table as the transaction currently sees them. */
  const counts = async (tx: Tx): Promise<Record<string, number>> => {
    const seen: Record<string, number> = {}
    for (const [name, table] of Object.entries(tables)) {
      const [{ count }] = await tx.execute<{ count: number }>(sql`select count(*)::int as count from ${table}`)
      seen[name] = count
    }
    return seen
  }
  /** What one company seeded: one row in each table, two routes and two pickups. */
  const ownRows = { ...Object.fromEntries(Object.keys(tables).map((name) => [name, 1])), route: 2, pickup: 2 }

  /** Both companies seeded as the owner inside `withCompany`, then the transaction becomes the API role. */
  const asCompany = <T>(companyId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    rolledBackIn(
      (body) => withCompany(owner.db, companyId, body),
      async (tx) => {
        await seed(tx, "a")
        await seed(tx, "b")
        // Role settings apply at login, not at SET ROLE: the API role's search path is set by hand.
        await tx.execute(sql`set local role ${sql.raw(API_ROLE)}`)
        await tx.execute(sql`set local search_path = wms, extensions`)
        return fn(tx)
      },
    )

  test("under withCompany as the API role, each of the seven tables shows the company's rows and nothing of another company's", async () => {
    const seenByA = await asCompany(a.company, async (tx) => ({
      counts: await counts(tx),
      routes: (await tx.select({ id: route.id }).from(route).orderBy(route.id)).map((row) => row.id),
      proofs: (await tx.select({ location: proofOfService.location }).from(proofOfService)).map((row) => row.location),
    }))
    assert.deepEqual(seenByA, { counts: ownRows, routes: [a.route, a.secondRoute], proofs: [NORDHAVN] })
    const seenByB = await asCompany(b.company, async (tx) => ({
      counts: await counts(tx),
      routes: (await tx.select({ id: route.id }).from(route).orderBy(route.id)).map((row) => row.id),
    }))
    assert.deepEqual(seenByB, { counts: ownRows, routes: [b.route, b.secondRoute] })
  })

  test("as the API role, a proof, an unload and a receipt can be appended and neither updated nor deleted (42501); the owner may do both; a route and an event are updated", () =>
    asCompany(a.company, async (tx) => {
      await tx.insert(proofOfService).values(proof({}))
      await tx.insert(unload).values(tipped({ id: a.other }))
      await tx.insert(driverCommand).values(receipt({ id: a.third }))
      await assert.rejects(tx.transaction((savepoint) => savepoint.update(proofOfService).set({ note: "rewritten" }).where(eq(proofOfService.id, a.spare))), refusedWith("42501", /permission denied for table proof_of_service/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.update(unload).set({ note: "rewritten" }).where(eq(unload.id, a.other))), refusedWith("42501", /permission denied for table unload/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.update(driverCommand).set({ deviceId: "rewritten" }).where(eq(driverCommand.id, a.third))), refusedWith("42501", /permission denied for table driver_command/))
      for (const [table, id, name] of [
        [proofOfService, a.spare, "proof_of_service"],
        [unload, a.other, "unload"],
        [driverCommand, a.third, "driver_command"],
      ] as const) {
        await assert.rejects(tx.transaction((savepoint) => savepoint.delete(table).where(eq(table.id, id))), refusedWith("42501", new RegExp(`permission denied for table ${name}`)))
      }
      // A route, a pickup, a session and an event are current state: the API role updates them.
      await tx.update(session).set({ pausedAt: at(9) }).where(eq(session.id, a.session))
      await tx.update(outboxEvent).set({ publishedAt: at(6, 1) }).where(eq(outboxEvent.id, a.event))
      // The owner keeps both rights, for tests and for erasure.
      await tx.execute(sql`reset role`)
      assert.equal((await tx.delete(proofOfService).where(eq(proofOfService.id, a.spare)).returning()).length, 1)
      assert.equal((await tx.delete(unload).where(eq(unload.id, a.other)).returning()).length, 1)
      assert.equal((await tx.delete(driverCommand).where(eq(driverCommand.id, a.third)).returning()).length, 1)
    }))

  test("a route cannot name the group, driver, vehicle or depot of another project of its own company (23503): every project-scoped key carries the project", () =>
    seeded(async (tx) => {
      await seedHarbor(tx)
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(route).values(planned({ collectionGroupId: a.harborGroup }))), refusedWith("23503", /route_collection_group_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(route).values(planned({ routeSchemeId: a.harborScheme, collectionGroupId: a.harborGroup }))), refusedWith("23503", /route_route_scheme_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(route).values(planned({ plannedDriverId: a.harborDriver }))), refusedWith("23503", /route_planned_driver_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(route).values(planned({ plannedVehicleId: a.harborVehicle }))), refusedWith("23503", /route_planned_vehicle_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(route).values(planned({ depotId: a.harborDepot }))), refusedWith("23503", /route_depot_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(pickup).values(stop({ propertyId: a.harborProperty }))), refusedWith("23503", /pickup_property_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(pickup).values(stop({ containerId: a.harborContainer }))), refusedWith("23503", /pickup_container_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(session).values(shift({ driverId: a.harborDriver }))), refusedWith("23503", /session_driver_id_fk/))
      // The same rows land when every id they name is their own project's.
      await tx.insert(route).values(planned({}))
      await tx.insert(pickup).values(stop({ id: a.other }))
    }))

  test("nor another company's station, provider, fraction or account (23503): every key carries the tenant", () =>
    seeded(async (tx) => {
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(route).values(planned({ unloadingStationId: b.station }))), refusedWith("23503", /route_unloading_station_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(route).values(planned({ plannedServiceProviderId: b.serviceProvider }))), refusedWith("23503", /route_planned_service_provider_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(pickup).values(stop({ wasteFractionId: b.wasteFraction }))), refusedWith("23503", /pickup_waste_fraction_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(proofOfService).values(proof({ recordedBy: b.account }))), refusedWith("23503", /proof_of_service_recorded_by_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(unload).values(tipped({ unloadingStationId: b.station }))), refusedWith("23503", /unload_unloading_station_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(unload).values(tipped({ wasteFractionId: b.wasteFraction }))), refusedWith("23503", /unload_waste_fraction_id_fk/))
      await tx.insert(route).values(planned({ unloadingStationId: a.station, plannedServiceProviderId: a.serviceProvider }))
    }))

  test("a proof, an unload or a receipt names a pickup and a session of the route it names, and no other route's (23503): the keys carry the route", () =>
    seeded(async (tx) => {
      // The second pickup and a second session are the planned route's; this proof is the active route's.
      await tx.insert(session).values(shift({}))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(proofOfService).values(proof({ pickupId: a.secondPickup }))), refusedWith("23503", /proof_of_service_route_id_pickup_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(proofOfService).values(proof({ sessionId: a.spare }))), refusedWith("23503", /proof_of_service_route_id_session_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(unload).values(tipped({ id: a.other, source: "driver-app", sessionId: a.spare }))), refusedWith("23503", /unload_route_id_session_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(driverCommand).values(receipt({ id: a.other, pickupId: a.secondPickup }))), refusedWith("23503", /driver_command_route_id_pickup_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(driverCommand).values(receipt({ id: a.other, sessionId: a.spare }))), refusedWith("23503", /driver_command_route_id_session_id_fk/))
      // The same rows land on the route the pickup and the session belong to.
      await tx.insert(proofOfService).values(proof({ id: a.other, routeId: a.secondRoute, pickupId: a.secondPickup, sessionId: a.spare }))
      await tx.insert(driverCommand).values(receipt({ id: a.third, routeId: a.secondRoute, pickupId: a.secondPickup, sessionId: a.spare, driverId: a.secondDriver }))
    }))

  test("one live session per route and one per driver (23505 session_route_open_idx, session_driver_open_idx); an ended session blocks neither", () =>
    seeded(async (tx) => {
      // The seeded session is Mads's, open, on the active route.
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(session).values(shift({ routeId: a.route }))), refusedWith("23505", /session_route_open_idx/), "a second driver on the same route")
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(session).values(shift({ driverId: a.driver }))), refusedWith("23505", /session_driver_open_idx/), "Mads on a second route")
      // Ended, the seeded session holds nothing: Mads may start the second route, and Karen the first.
      await tx.update(session).set({ endedAt: at(14) }).where(eq(session.id, a.session))
      await tx.insert(session).values(shift({ driverId: a.driver }))
      await tx.insert(session).values(shift({ id: a.other, routeId: a.route, deviceId: "device-k2" }))
      // And a second open one on either is refused again.
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(session).values(shift({ id: a.third, routeId: a.route }))), refusedWith("23505", /session_route_open_idx/))
    }))

  test("the route's stamps follow its status (23514 route_stamps_shape): each status with what it lacks or should not have, and a cancelled route keeping what it had done", () =>
    seeded(async (tx) => {
      const stamps = { dispatchedAt: at(5), startedAt: at(6), completedAt: at(14), cancelledAt: at(14) }
      const refuse = (values: Partial<typeof route.$inferInsert>, why: string) =>
        assert.rejects(tx.transaction((savepoint) => savepoint.insert(route).values(planned(values))), refusedWith("23514", /route_stamps_shape/), why)
      await refuse({ status: "planned", dispatchedAt: at(5) }, "planned with a dispatch stamp")
      await refuse({ status: "ready" }, "ready without a dispatch stamp")
      // Postgres checks constraints by name, so each row here keeps the actual assignment in step with `started_at` and trips the stamps check alone.
      await refuse({ status: "ready", dispatchedAt: at(5), startedAt: at(6), actualDriverId: a.driver, actualVehicleId: a.vehicle }, "ready with a start stamp")
      await refuse({ status: "active", dispatchedAt: at(5) }, "active without a start stamp")
      await refuse({ status: "active", ...stamps, cancelledAt: null, actualDriverId: a.driver, actualVehicleId: a.vehicle }, "active with a completion stamp")
      await refuse({ status: "completed", dispatchedAt: at(5), startedAt: at(6), actualDriverId: a.driver, actualVehicleId: a.vehicle }, "completed without a completion stamp")
      await refuse({ status: "completed", ...stamps, actualDriverId: a.driver, actualVehicleId: a.vehicle }, "completed with a cancellation stamp")
      await refuse({ status: "cancelled" }, "cancelled without a cancellation stamp")
      await refuse({ status: "cancelled", startedAt: at(6), cancelledAt: at(7), actualDriverId: a.driver, actualVehicleId: a.vehicle }, "cancelled after starting without having been dispatched")
      await refuse({ status: "cancelled", ...stamps, actualDriverId: a.driver, actualVehicleId: a.vehicle }, "cancelled and completed")
      // The shapes that stand, one per status: a cancelled route from planned, from ready and from active.
      await tx.insert(route).values([
        planned({ id: a.spare, number: 1100 }),
        planned({ id: a.other, number: 1101, serviceDate: "2026-10-26", operatingDate: "2026-10-26", status: "ready", dispatchedAt: at(5) }),
        planned({ id: a.third, number: 1102, serviceDate: "2026-11-02", operatingDate: "2026-11-02", status: "cancelled", cancelledAt: at(7), note: "Snowed in" }),
        planned({ id: a.fourth, number: 1103, serviceDate: "2026-11-09", operatingDate: "2026-11-09", status: "cancelled", dispatchedAt: at(5), startedAt: at(6), cancelledAt: at(7), actualDriverId: a.driver, actualVehicleId: a.vehicle }),
      ])
      const [completed] = await tx.update(route).set({ status: "completed", completedAt: at(14) }).where(eq(route.id, a.route)).returning({ status: route.status })
      assert.equal(completed.status, "completed")
    }))

  test("the actual assignment goes with a start and not without (23514 route_actual_shape), and a trailer only with a driver", () =>
    seeded(async (tx) => {
      const refuse = (values: Partial<typeof route.$inferInsert>, why: string) =>
        assert.rejects(tx.transaction((savepoint) => savepoint.insert(route).values(planned(values))), refusedWith("23514", /route_actual_shape/), why)
      await refuse({ actualDriverId: a.driver, actualVehicleId: a.vehicle }, "an actual assignment on a route that never started")
      await refuse({ status: "active", dispatchedAt: at(5), startedAt: at(6) }, "started without a driver")
      await refuse({ status: "active", dispatchedAt: at(5), startedAt: at(6), actualDriverId: a.driver }, "started without a vehicle")
      await refuse({ actualTrailerId: a.trailer }, "a trailer without a start")
      await tx.insert(route).values(planned({ status: "active", dispatchedAt: at(5), startedAt: at(6), actualDriverId: a.secondDriver, actualVehicleId: a.trailer, actualTrailerId: a.trailer }))
    }))

  test("a pickup's outcome_at goes with a status that left planned, a reason with a skip or a failure, and exactly one place (23514)", () =>
    seeded(async (tx) => {
      const refuse = (values: Partial<typeof pickup.$inferInsert>, constraint: RegExp, why: string) =>
        assert.rejects(tx.transaction((savepoint) => savepoint.insert(pickup).values(stop(values))), refusedWith("23514", constraint), why)
      await refuse({ outcomeAt: at(7) }, /pickup_outcome_shape/, "planned with an outcome instant")
      await refuse({ status: "completed" }, /pickup_outcome_shape/, "completed without one")
      await refuse({ status: "skipped", outcomeAt: at(7) }, /pickup_reason_shape/, "skipped without a reason")
      await refuse({ status: "failed", outcomeAt: at(7) }, /pickup_reason_shape/, "failed without a reason")
      await refuse({ status: "completed", outcomeAt: at(7), reason: "other" }, /pickup_reason_shape/, "completed with a reason")
      await refuse({ reason: "route-ended" }, /pickup_reason_shape/, "planned with a reason")
      await refuse({ status: "skipped", outcomeAt: at(7), reason: "lunch" }, /pickup_reason_one_of/, "a reason outside the vocabulary")
      await refuse({ propertyId: null }, /pickup_place_exactly_one/, "no place")
      await refuse({ sharedCollectionPointId: a.point }, /pickup_place_exactly_one/, "two places")
      await refuse({ position: 0 }, /pickup_position_positive/, "the first stop is number one")
      await tx.insert(pickup).values([
        stop({ status: "skipped", outcomeAt: at(7), reason: "route-ended" }),
        stop({ id: a.other, containerId: a.secondContainer, routeId: a.secondRoute, propertyId: null, sharedCollectionPointId: a.point, position: 2 }),
      ])
      // One container is one stop on a route (23505).
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(pickup).values(stop({ id: a.third, containerId: a.container }))), refusedWith("23505", /pickup_route_id_container_id_key/))
    }))

  test("a proof names a pickup where its kind is a stop's, a session where the driver recorded it, and the kind CASE agrees with the domain's proofShape over every kind with each column set and unset (23514)", () =>
    seeded(async (tx) => {
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(proofOfService).values(proof({ pickupId: null }))), refusedWith("23514", /proof_of_service_pickup_shape/), "a completion on the route alone")
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(proofOfService).values(proof({ sessionId: null }))), refusedWith("23514", /proof_of_service_session_shape/), "the driver's row without a session")
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(proofOfService).values(proof({ source: "dispatch" }))), refusedWith("23514", /proof_of_service_session_shape/), "the office's row with a session")
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(proofOfService).values(proof({ kind: "gps" }))), refusedWith("23514", /proof_of_service_kind_one_of/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(proofOfService).values(proof({ kind: "weight", weightKg: 0 }))), refusedWith("23514", /proof_of_service_weight_kg_positive/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(proofOfService).values(proof({ location: { type: "Point", coordinates: [200, 55] } }))), refusedWith("23514", /proof_of_service_location_valid/))

      /** The whole row for a kind: what the row says of the five columns and the source, on the pickup or on the route. */
      const full = { reason: "inaccessible", objectKey: `${a.company}/${a.route}/${a.spare}.jpg`, weightKg: 148, outcome: "failed", note: "Gate locked" } as const
      const columns = ["reason", "objectKey", "weightKg", "outcome", "note"] as const
      const exemplar = (kind: ProofKind): ProofRow => {
        const shape = PROOF_SHAPES[kind]
        return {
          pickupId: shape.pickup === "none" ? null : a.pickup,
          reason: shape.reason === "none" ? null : full.reason,
          objectKey: shape.objectKey === "none" ? null : full.objectKey,
          weightKg: shape.weightKg === "none" ? null : full.weightKg,
          outcome: shape.outcome === "none" ? null : full.outcome,
          note: shape.note === "none" ? null : full.note,
          source: shape.source === "dispatch" ? "dispatch" : "driver-app",
        }
      }
      /** Whether Postgres takes the row, judged in a savepoint that is always rolled back; the kind CASE is the one check a row shaped this way can trip. */
      const lands = async (kind: ProofKind, row: ProofRow): Promise<boolean> => {
        const attempt = tx.transaction(async (savepoint) => {
          await savepoint.insert(proofOfService).values(proof({ kind, ...row, sessionId: row.source === "driver-app" ? a.session : null }))
          throw new Landed()
        })
        try {
          await attempt
        } catch (error) {
          if (error instanceof Landed) return true
          refusedWith("23514", /proof_of_service_kind_shape|proof_of_service_pickup_shape/)(error)
          return false
        }
        throw new Error("the savepoint returned instead of rolling back")
      }
      let rows = 0
      for (const kind of PROOF_KINDS) {
        const variations: ProofRow[] = [exemplar(kind), { ...exemplar(kind), pickupId: null }, { ...exemplar(kind), pickupId: a.pickup }]
        for (const column of columns) {
          variations.push({ ...exemplar(kind), [column]: full[column] }, { ...exemplar(kind), [column]: null })
        }
        variations.push({ ...exemplar(kind), source: "dispatch" }, { ...exemplar(kind), source: "driver-app" })
        for (const row of variations) {
          assert.equal(await lands(kind, row), proofShape(kind, row), `${kind}: ${JSON.stringify(row)}`)
          rows += 1
        }
      }
      assert.equal(rows, 180, "twelve kinds, fifteen rows each")
    }))

  test("an unload's weights come together and add up, and the office's row names no session (23514 unload_weights_shape, unload_session_shape)", () =>
    seeded(async (tx) => {
      const refuse = (values: Partial<typeof unload.$inferInsert>, constraint: RegExp, why: string) =>
        assert.rejects(tx.transaction((savepoint) => savepoint.insert(unload).values(tipped(values))), refusedWith("23514", constraint), why)
      await refuse({ grossKg: 12_400 }, /unload_weights_shape/, "gross without tare")
      await refuse({ tareKg: 8_200 }, /unload_weights_shape/, "tare without gross")
      await refuse({ grossKg: 12_400, tareKg: 8_200, netKg: 4_000 }, /unload_weights_shape/, "net is not gross less tare")
      await refuse({ grossKg: 8_000, tareKg: 8_200, netKg: -200 }, /unload_net_kg_positive/, "gross below tare")
      await refuse({ netKg: 0 }, /unload_net_kg_positive/, "nothing tipped is not an unload")
      await refuse({ sessionId: a.session }, /unload_session_shape/, "the office's row with a session")
      await refuse({ source: "driver-app" }, /unload_session_shape/, "the driver's row without one")
      await refuse({ source: "weighbridge" }, /unload_source_one_of/, "a source outside the vocabulary")
      await tx.insert(unload).values([tipped({}), tipped({ id: a.other, grossKg: 12_400, tareKg: 8_200, netKg: 4_200 }), tipped({ id: a.third, source: "driver-app", sessionId: a.session })])
    }))

  test("a rejected command carries its problem and an applied one none (23514 driver_command_problem_shape); an outbox event is one of the kinds about one of the aggregates", () =>
    seeded(async (tx) => {
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(driverCommand).values(receipt({ outcome: "rejected" }))), refusedWith("23514", /driver_command_problem_shape/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(driverCommand).values(receipt({ problem: { status: 409 } }))), refusedWith("23514", /driver_command_problem_shape/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(driverCommand).values(receipt({ outcome: "replayed" }))), refusedWith("23514", /driver_command_outcome_one_of/), "replayed is the wire's word and is never stored")
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(driverCommand).values(receipt({ kind: "retry-sync" }))), refusedWith("23514", /driver_command_kind_one_of/))
      const refusedCompletion = { type: "about:blank", title: "Conflict", status: 409, detail: "Pickup 1 is already completed" }
      await tx.insert(driverCommand).values(receipt({ outcome: "rejected", problem: refusedCompletion, sessionId: null, pickupId: null }))
      // The receipt's id is the client's: a second command with the same id is a replay the API answers, and the key refuses the row (23505 driver_command_pkey).
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(driverCommand).values(receipt({ id: a.command }))), refusedWith("23505", /driver_command_pkey/))
      // A receipt is writable for any rejection (ADR-0004): a command naming a route the driver does not reach has no route the key could check, so the column is null, the claimed id stays in the body, and the row is the driver's project's.
      const noSuchRoute = { type: "about:blank", title: "Not Found", status: 404, detail: `No route ${b.route} assigned to this driver` }
      await tx.insert(driverCommand).values(receipt({ id: a.other, routeId: null, sessionId: null, pickupId: null, kind: "start-route", body: { vehicleId: a.vehicle, routeId: b.route }, outcome: "rejected", problem: noSuchRoute }))
      // Such a row is a rejection naming no session and no pickup, and never an applied command (23514 driver_command_route_shape).
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(driverCommand).values(receipt({ id: a.third, routeId: null, sessionId: null, pickupId: null }))), refusedWith("23514", /driver_command_route_shape/), "applied without a route")
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(driverCommand).values(receipt({ id: a.third, routeId: null, pickupId: null, outcome: "rejected", problem: noSuchRoute }))), refusedWith("23514", /driver_command_route_shape/), "a session without a route")
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(driverCommand).values(receipt({ id: a.third, routeId: null, sessionId: null, outcome: "rejected", problem: noSuchRoute }))), refusedWith("23514", /driver_command_route_shape/), "a pickup without a route")
      // The driver's log reads both, in order, through its index.
      const log = await tx.select({ id: driverCommand.id, routeId: driverCommand.routeId }).from(driverCommand).where(and(eq(driverCommand.companyId, a.company), eq(driverCommand.driverId, a.driver))).orderBy(driverCommand.id)
      assert.deepEqual(log.map((row) => row.routeId), [a.route, a.route, null], "the seeded arrival, the refused completion, the route nobody assigned")
      const event = { id: a.other, companyId: a.company, projectId: a.project, kind: "pickup-completed", aggregateKind: "pickup", aggregateId: a.pickup, occurredAt: at(6, 25), payload: { id: a.pickup, status: "completed" } } as const
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(outboxEvent).values({ ...event, kind: "route.started" })), refusedWith("23514", /outbox_event_kind_one_of/), "kebab, not dotted")
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(outboxEvent).values({ ...event, aggregateKind: "alert" })), refusedWith("23514", /outbox_event_aggregate_kind_one_of/), "an alert has no event of its own; a ticket has, since 0009")
      const [written] = await tx.insert(outboxEvent).values(event).returning({ publishedAt: outboxEvent.publishedAt })
      assert.equal(written.publishedAt, null, "unpublished until the relay stamps it")
    }))

  test("a route's number is the company's once, and its identity — scheme, group, service date — is one route (23505)", () =>
    seeded(async (tx) => {
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(route).values(planned({ number: 1042 }))), refusedWith("23505", /route_number_key/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(route).values(planned({ serviceDate: DAY, operatingDate: "2026-10-06" }))), refusedWith("23505", /route_generation_key/), "the operating date is not the identity")
      // Two routes of one group on one operating day is what a shifted holiday and a regular day make.
      await tx.insert(route).values(planned({ serviceDate: "2026-10-04", operatingDate: DAY }))
      // The same number in another company is another route.
      await tx.insert(route).values(planned({ id: a.other, companyId: b.company, projectId: b.project, routeSchemeId: b.scheme, collectionGroupId: b.group, plannedVehicleId: b.vehicle, plannedDriverId: b.driver, depotId: b.depot, number: 1042 }))
    }))

  test("the counter allocates disjoint blocks under two concurrent transactions: the row lock is the serialisation", async () => {
    const companyId = a.spare
    await owner.db.insert(company).values({ id: companyId, companyId, name: "Counter", legalName: "Counter A/S", registrationNumber: "99999999", country: "DK", status: "active" })
    try {
      const [{ nextRouteNumber }] = await owner.db.select({ nextRouteNumber: company.nextRouteNumber }).from(company).where(eq(company.id, companyId))
      assert.equal(nextRouteNumber, 1000, "the default")
      /** One generation run taking a block of `size`: the first number of the block is what the counter said before the update. */
      const allocate = (size: number): Promise<number> =>
        owner.db.transaction(async (tx) => {
          const [row] = await tx
            .update(company)
            .set({ nextRouteNumber: sql`${company.nextRouteNumber} + ${size}` })
            .where(and(eq(company.id, companyId), eq(company.companyId, companyId)))
            .returning({ next: company.nextRouteNumber })
          // Hold the lock a moment, so the second run waits on this one rather than slipping in between.
          await tx.execute(sql`select pg_sleep(0.05)`)
          return row.next - size
        })
      const [first, second] = await Promise.all([allocate(5), allocate(3)])
      const blocks = [
        [first, first + 5],
        [second, second + 3],
      ].sort((x, y) => x[0] - y[0])
      assert.equal(blocks[0][0], 1000)
      assert.equal(blocks[0][1], blocks[1][0], "the second block begins where the first ends: nothing shared, nothing skipped")
      const [{ after }] = await owner.db.select({ after: company.nextRouteNumber }).from(company).where(eq(company.id, companyId))
      assert.equal(after, 1008)
    } finally {
      await owner.db.delete(company).where(eq(company.id, companyId))
    }
  })

  test("a status outside the vocabulary is refused on every table that carries one (23514)", () =>
    seeded(async (tx) => {
      // The stamps CASE ends in `else false`, and Postgres checks constraints by name, so an unknown status is refused by the stamps check before the vocabulary's; either way it is refused, and the API never writes a status a body gave.
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(route).values(planned({ status: "draft" as RouteStatus }))), refusedWith("23514", /route_stamps_shape/), "the prototype's Draft folds into planned")
      await assert.rejects(tx.transaction((savepoint) => savepoint.execute(sql`alter table wms.route drop constraint route_stamps_shape`).then(() => savepoint.insert(route).values(planned({ status: "draft" as RouteStatus })))), refusedWith("23514", /route_status_one_of/), "and the vocabulary's check stands behind it")
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(pickup).values(stop({ status: "rescheduled", outcomeAt: at(7) }))), refusedWith("23514", /pickup_status_one_of/), "a Ticket's outcome, not a pickup status")
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(proofOfService).values(proof({ kind: "correction", source: "dispatch", sessionId: null, outcome: "rescheduled", note: "x" }))), refusedWith("23514", /proof_of_service_outcome_one_of/))
    }))
})

/** Thrown out of a savepoint to roll it back after a statement landed. */
class Landed extends Error {}
