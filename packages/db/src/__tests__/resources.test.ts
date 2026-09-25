// The Resources tables against Postgres (Issue #101, slice 1), on a fresh
// database of this file's own so that "migration 0007 applies to a clean
// database" is proved — the first DROP COLUMN, and the placement's key added
// before the ledger's reference to it, included — and nothing depends on what
// the shared local database holds: the composite keys refuse another
// project's depot and warehouse and another company's placement, vehicle type
// and fraction; the ledger's four shape checks refuse what they should and
// the kind check agrees with the domain's `movementShape` on every one of the
// hundred and fifty triples; the API role can insert into both ledgers and
// update or delete nothing there while the owner can; the three window
// exclusion constraints refuse two live reservations of one vehicle, driver
// or trailer over overlapping windows and accept them once one is released
// or ends when the other starts, the driver's and the trailer's ignoring a
// null; the fold answers the latest movement in recording order and null for
// a container without one; and the fence shows the API role exactly its
// company's rows in each of the thirteen. Every test runs as the owner in a
// transaction that is rolled back, so nothing needs cleaning up.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import type { Point } from "@waste/contracts/geojson"
import { movementShape } from "@waste/domain/resources/asset-state"
import { STOCK_MOVEMENT_KINDS, STOCK_PLACE_KINDS, type StockMovementKind, type StockPlaceKind } from "@waste/domain/resources/vocabulary"
import { and, eq, getTableName, sql } from "drizzle-orm"
import type { PgTable } from "drizzle-orm/pg-core"

import { createDb, type Database, type Tx } from "../client"
import { migrateDatabase } from "../migrate"
import { assetStateOf, assetStatus } from "../query/asset-state"
import { API_ROLE } from "../roles"
import { role, userAccount } from "../schema/access"
import { agreement, subscription } from "../schema/agreements"
import { vehicleAllocation, vehicleAllocationEvent } from "../schema/allocations"
import { containerType, product, wasteFraction } from "../schema/catalogue"
import { container, containerServicePlacement } from "../schema/containers"
import { customer, property } from "../schema/customers"
import { driver, vehicle, vehicleCompartment, vehicleCompartmentFraction } from "../schema/fleet"
import { containerTypeVehicleType, vehicleType } from "../schema/fleet-types"
import { company, project, serviceProvider } from "../schema/organisation"
import { depot, unloadingStation, unloadingStationFraction, warehouse } from "../schema/places"
import { collectionGroup, routeScheme } from "../schema/route-schemes"
import { stockMovement } from "../schema/stock"
import { withCompany } from "../tenant"
import { databaseUnderTest, freshDatabase, type FreshDatabase } from "./database"
import { refusedWith, rolledBack, rolledBackIn } from "./specimen"

const database = databaseUnderTest()

/** One company's fixture ids, a nibble telling the companies apart; this file's own bucket, on its own database. */
const ids = (n: "a" | "b") => ({
  company: `018f7c31-${n}000-7000-8000-000000000001`,
  project: `018f7c31-${n}000-7000-8000-000000000002`,
  role: `018f7c31-${n}000-7000-8000-000000000003`,
  account: `018f7c31-${n}000-7000-8000-000000000004`,
  wasteFraction: `018f7c31-${n}000-7000-8000-000000000005`,
  containerType: `018f7c31-${n}000-7000-8000-000000000006`,
  container: `018f7c31-${n}000-7000-8000-000000000007`,
  /** A second container, with no movement. */
  unmoved: `018f7c31-${n}000-7000-8000-000000000008`,
  serviceProvider: `018f7c31-${n}000-7000-8000-000000000009`,
  customer: `018f7c31-${n}000-7000-8000-00000000000a`,
  property: `018f7c31-${n}000-7000-8000-00000000000b`,
  agreement: `018f7c31-${n}000-7000-8000-00000000000c`,
  product: `018f7c31-${n}000-7000-8000-00000000000d`,
  subscription: `018f7c31-${n}000-7000-8000-00000000000e`,
  placement: `018f7c31-${n}000-7000-8000-00000000000f`,
  vehicleType: `018f7c31-${n}000-7000-8000-000000000010`,
  compatibility: `018f7c31-${n}000-7000-8000-000000000011`,
  depot: `018f7c31-${n}000-7000-8000-000000000012`,
  warehouse: `018f7c31-${n}000-7000-8000-000000000013`,
  station: `018f7c31-${n}000-7000-8000-000000000014`,
  stationFraction: `018f7c31-${n}000-7000-8000-000000000015`,
  vehicle: `018f7c31-${n}000-7000-8000-000000000016`,
  trailer: `018f7c31-${n}000-7000-8000-000000000017`,
  compartment: `018f7c31-${n}000-7000-8000-000000000018`,
  compartmentFraction: `018f7c31-${n}000-7000-8000-000000000019`,
  driver: `018f7c31-${n}000-7000-8000-00000000001a`,
  movement: `018f7c31-${n}000-7000-8000-00000000001b`,
  allocation: `018f7c31-${n}000-7000-8000-00000000001c`,
  event: `018f7c31-${n}000-7000-8000-00000000001d`,
  scheme: `018f7c31-${n}000-7000-8000-00000000001e`,
  group: `018f7c31-${n}000-7000-8000-00000000001f`,
  /** Free for a test's own rows. */
  spare: `018f7c31-${n}000-7000-8000-0000000000e1`,
  other: `018f7c31-${n}000-7000-8000-0000000000e2`,
  third: `018f7c31-${n}000-7000-8000-0000000000e3`,
  fourth: `018f7c31-${n}000-7000-8000-0000000000e4`,
  fifth: `018f7c31-${n}000-7000-8000-0000000000e5`,
  /** A second project of the same company, with a depot and a warehouse of its own that a record of the first may not name. */
  harbor: `018f7c31-${n}000-7000-8000-0000000000f1`,
  harborDepot: `018f7c31-${n}000-7000-8000-0000000000f2`,
  harborWarehouse: `018f7c31-${n}000-7000-8000-0000000000f3`,
})
const a = ids("a")
const b = ids("b")

const NORDHAVN: Point = { type: "Point", coordinates: [12.5951, 55.7089] }
const AMAGER: Point = { type: "Point", coordinates: [12.6193, 55.6602] }
const OPENED = "2026-01-01"
/** A morning shift and the ones around it, as instants. */
const at = (hour: number, day = 5): Date => new Date(Date.UTC(2026, 9, day, hour))

const tables: Record<string, PgTable> = {
  vehicleType,
  containerTypeVehicleType,
  depot,
  warehouse,
  unloadingStation,
  unloadingStationFraction,
  vehicle,
  vehicleCompartment,
  vehicleCompartmentFraction,
  driver,
  stockMovement,
  vehicleAllocation,
  vehicleAllocationEvent,
}

/** A company with what the other contexts lend it, and one row in each Resources table — two in vehicle, a powered one and a trailer — inserted as the owner in dependency order. */
async function seed(tx: Tx, n: "a" | "b"): Promise<void> {
  const own = ids(n)
  const tenant = { companyId: own.company }
  const scoped = { ...tenant, projectId: own.project }
  await tx.insert(company).values({ id: own.company, ...tenant, name: `Company ${n}`, legalName: `Company ${n} A/S`, registrationNumber: `1000000${n}`, country: "DK", status: "active" })
  await tx.insert(project).values({ id: own.project, ...tenant, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active" })
  await tx.insert(role).values({ id: own.role, ...tenant, name: "Planner", scope: "Company", description: "Plans", system: false })
  await tx.insert(userAccount).values({ id: own.account, ...tenant, email: `planner@${n}.example`, fullName: "Pia Planner", roleId: own.role })
  await tx.insert(wasteFraction).values({ id: own.wasteFraction, ...tenant, key: "residual", name: "Residual waste" })
  await tx.insert(containerType).values({ id: own.containerType, ...tenant, name: "240 L bin", volumeLitres: 240 })
  await tx.insert(container).values([
    { id: own.container, ...scoped, label: "BIN-82014", containerTypeId: own.containerType, ownership: "company" },
    { id: own.unmoved, ...scoped, label: "BIN-82015", containerTypeId: own.containerType, ownership: "company" },
  ])
  await tx.insert(serviceProvider).values({ id: own.serviceProvider, ...tenant, legalName: "NordRen ApS", registrationNumber: `4000000${n}`, country: "DK", contactName: "Lars Mikkelsen", contactEmail: `lars@${n}.example` })
  await tx.insert(customer).values({ id: own.customer, ...tenant, kind: "organisation", name: "Kystbyen Boligforening", status: "active" })
  await tx.insert(property).values({ id: own.property, ...scoped, name: "Parkvej 18", address: "Parkvej 18", kind: "residential", status: "active" })
  await tx.insert(agreement).values({ id: own.agreement, ...scoped, validFrom: OPENED, number: "AGR-1", customerId: own.customer, payerCustomerId: own.customer, status: "active", billingCadence: "monthly", currency: "DKK" })
  await tx.insert(product).values({ id: own.product, ...scoped, name: "Residual 240 L", kind: "container-collection", status: "active", unit: "pickup" })
  await tx.insert(subscription).values({ id: own.subscription, ...scoped, validFrom: OPENED, agreementId: own.agreement, productId: own.product, propertyId: own.property })
  await tx.insert(containerServicePlacement).values({ id: own.placement, ...scoped, validFrom: OPENED, containerId: own.container, subscriptionId: own.subscription, wasteFractionId: own.wasteFraction })
  await tx.insert(vehicleType).values({ id: own.vehicleType, ...tenant, key: "rear-loader", name: "Rear loader" })
  await tx.insert(containerTypeVehicleType).values({ id: own.compatibility, ...tenant, containerTypeId: own.containerType, vehicleTypeId: own.vehicleType })
  await tx.insert(depot).values({ id: own.depot, ...scoped, code: "DEP-NORD", name: "Nordhavn", address: "Sundkrogsgade 1", location: NORDHAVN, ownership: "company", status: "active" })
  await tx.insert(warehouse).values({ id: own.warehouse, ...scoped, code: "WH-NORD", name: "Nordhavn warehouse", address: "Sundkrogsgade 1", depotId: own.depot, status: "active" })
  await tx.insert(unloadingStation).values({ id: own.station, ...tenant, code: "ARC", name: "ARC Amager", address: "Vindmøllevej 6", location: AMAGER, ownership: "external", status: "active" })
  await tx.insert(unloadingStationFraction).values({ id: own.stationFraction, ...tenant, unloadingStationId: own.station, wasteFractionId: own.wasteFraction })
  await tx.insert(vehicle).values([
    { id: own.vehicle, ...scoped, registration: `CN 42 01${n === "a" ? 8 : 9}`, callsign: "WH-24", kind: "powered-vehicle", vehicleTypeId: own.vehicleType, ownership: "company", status: "active", requiredLicenceClass: "c", homeDepotId: own.depot },
    { id: own.trailer, ...scoped, registration: `TR 10 00${n === "a" ? 1 : 2}`, kind: "trailer", vehicleTypeId: own.vehicleType, ownership: "company", status: "active", requiredLicenceClass: "ce" },
  ])
  await tx.insert(vehicleCompartment).values({ id: own.compartment, ...scoped, vehicleId: own.vehicle, position: 1, name: "Body", capacityKg: 9000 })
  await tx.insert(vehicleCompartmentFraction).values({ id: own.compartmentFraction, ...scoped, vehicleCompartmentId: own.compartment, wasteFractionId: own.wasteFraction })
  await tx.insert(driver).values({ id: own.driver, ...scoped, name: "Mads Jensen", employment: "employee", licenceClass: "ce", userAccountId: own.account, status: "active", homeDepotId: own.depot })
  await tx.insert(stockMovement).values({ id: own.movement, ...scoped, containerId: own.container, kind: "receipt", fromKind: "supplier", toKind: "warehouse", toWarehouseId: own.warehouse, occurredAt: at(8, 1), recordedBy: own.account })
  await tx.insert(vehicleAllocation).values({ id: own.allocation, ...scoped, plannedFrom: at(6), plannedTo: at(14), vehicleId: own.vehicle, driverId: own.driver, depotId: own.depot })
  await tx.insert(vehicleAllocationEvent).values({ id: own.event, ...scoped, vehicleAllocationId: own.allocation, action: "allocate", status: "planned", vehicleId: own.vehicle, driverId: own.driver, depotId: own.depot, plannedFrom: at(6), plannedTo: at(14), recordedBy: own.account })
  await tx.insert(routeScheme).values({ id: own.scheme, ...scoped, validFrom: OPENED, name: "Residual weekly", serviceType: "container-collection", frequency: "weekly", serviceDays: ["monday"], depotId: own.depot, unloadingStationId: own.station })
  await tx.insert(collectionGroup).values({ id: own.group, ...scoped, routeSchemeId: own.scheme, name: "Rear loaders", position: 1, days: ["monday"], stopSource: "rule", ruleVehicleTypeId: own.vehicleType, vehicleId: own.vehicle, driverId: own.driver })
}

/** A sound powered vehicle of company a's first project, but for what a test overrides. */
const truck = (values: Partial<typeof vehicle.$inferInsert>): typeof vehicle.$inferInsert => ({
  id: a.spare,
  companyId: a.company,
  projectId: a.project,
  registration: "CN 42 020",
  kind: "powered-vehicle",
  vehicleTypeId: a.vehicleType,
  ownership: "company",
  status: "active",
  requiredLicenceClass: "c",
  ...values,
})

/** A sound movement of company a's container, but for what a test overrides: a transfer from the warehouse to maintenance at it. */
const movement = (values: Partial<typeof stockMovement.$inferInsert>): typeof stockMovement.$inferInsert => ({
  id: a.spare,
  companyId: a.company,
  projectId: a.project,
  containerId: a.container,
  kind: "transfer",
  fromKind: "warehouse",
  fromWarehouseId: a.warehouse,
  toKind: "maintenance",
  toWarehouseId: a.warehouse,
  occurredAt: at(9, 2),
  recordedBy: a.account,
  ...values,
})

/** A sound allocation of company a's truck, but for what a test overrides: the afternoon after the seeded morning. */
const allocation = (values: Partial<typeof vehicleAllocation.$inferInsert>): typeof vehicleAllocation.$inferInsert => ({
  id: a.spare,
  companyId: a.company,
  projectId: a.project,
  plannedFrom: at(14),
  plannedTo: at(22),
  vehicleId: a.vehicle,
  ...values,
})

describe("the Resources tables against a fresh database", { skip: database.skip }, () => {
  let fresh: FreshDatabase
  let owner: Database

  before(async () => {
    fresh = await freshDatabase(database.adminUrl, "waste_resources")
    await migrateDatabase(fresh.url)
    owner = createDb(fresh.url, { max: 2 })
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

  test("0007 created the thirteen tables in wms, each fenced, eleven with the updated_at trigger and the two ledgers with none", async () => {
    const names = Object.values(tables).map(getTableName).sort()
    assert.equal(names.length, 13)
    const rows = await owner.sql<{ table: string; enabled: boolean; forced: boolean; policies: string[]; triggers: string[] | null }[]>`
      select c.relname as table, c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
        (select array_agg(p.policyname order by p.policyname) from pg_policies p where p.schemaname = 'wms' and p.tablename = c.relname) as policies,
        (select array_agg(t.tgname order by t.tgname) from pg_trigger t where t.tgrelid = c.oid and not t.tgisinternal) as triggers
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'wms' and c.relkind = 'r' and c.relname = any (${names}::text[])
      order by c.relname`
    const ledgers = ["stock_movement", "vehicle_allocation_event"]
    assert.deepEqual(
      rows.map(({ table, enabled, forced, policies, triggers }) => ({ table, enabled, forced, policies, triggers })),
      names.map((table) => ({ table, enabled: true, forced: true, policies: [`${table}_tenant_fence`], triggers: ledgers.includes(table) ? null : [`${table}_touch_updated_at`] })),
    )
  })

  test("and left the API role able to insert into both ledgers and to update or delete nothing there, while the owner keeps every right", async () => {
    const rows = await owner.sql<{ relation: string; rolename: string; privilege: string; granted: boolean }[]>`
      select t.relation, r.rolename, p.privilege, has_table_privilege(r.rolename::name, ('wms.' || t.relation)::regclass, p.privilege) as granted
      from (values ('stock_movement'), ('vehicle_allocation_event'), ('vehicle_allocation')) as t(relation),
           (values (${API_ROLE}::text), (current_user::text)) as r(rolename),
           (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) as p(privilege)
      order by t.relation, r.rolename, p.privilege`
    assert.equal(rows.length, 24)
    const denied = rows.filter((row) => !row.granted).map((row) => `${row.rolename} ${row.privilege} ${row.relation}`)
    assert.deepEqual(denied.sort(), [`${API_ROLE} DELETE stock_movement`, `${API_ROLE} DELETE vehicle_allocation_event`, `${API_ROLE} UPDATE stock_movement`, `${API_ROLE} UPDATE vehicle_allocation_event`].sort())
  })

  test("and altered the three tables of the other contexts: the token column is gone, the five columns are there, and the placement carries its project key", async () => {
    const columns = await owner.sql<{ table: string; column: string }[]>`
      select table_name as table, column_name as column from information_schema.columns
      where table_schema = 'wms' and ((table_name = 'collection_group' and column_name in ('rule_vehicle_type', 'rule_vehicle_type_id', 'vehicle_id', 'driver_id')) or (table_name = 'route_scheme' and column_name in ('depot_id', 'unloading_station_id')))
      order by table_name, column_name`
    assert.deepEqual(
      columns.map((row) => `${row.table}.${row.column}`),
      ["collection_group.driver_id", "collection_group.rule_vehicle_type_id", "collection_group.vehicle_id", "route_scheme.depot_id", "route_scheme.unloading_station_id"],
    )
    const [key] = await owner.sql<{ found: boolean }[]>`select exists (select 1 from pg_constraint where conname = 'container_service_placement_project_key') as found`
    assert.equal(key.found, true)
    const [index] = await owner.sql<{ found: boolean }[]>`select to_regclass('wms.container_service_placement_project_id_idx') is not null as found`
    assert.equal(index.found, false)
  })

  /** Row counts per table as the transaction currently sees them. */
  const counts = async (tx: Tx): Promise<Record<string, number>> => {
    const seen: Record<string, number> = {}
    for (const [name, table] of Object.entries(tables)) {
      const [{ count }] = await tx.execute<{ count: number }>(sql`select count(*)::int as count from ${table}`)
      seen[name] = count
    }
    return seen
  }
  /** What one company seeded: one row in each table, two vehicles. */
  const ownRows = { ...Object.fromEntries(Object.keys(tables).map((name) => [name, 1])), vehicle: 2 }

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

  test("under withCompany as the API role, each of the thirteen tables shows the company's rows and nothing of another company's", async () => {
    const seenByA = await asCompany(a.company, async (tx) => ({
      counts: await counts(tx),
      vehicles: (await tx.select({ id: vehicle.id }).from(vehicle).orderBy(vehicle.id)).map((row) => row.id),
      depots: (await tx.select({ location: depot.location }).from(depot)).map((row) => row.location),
    }))
    assert.deepEqual(seenByA, { counts: ownRows, vehicles: [a.vehicle, a.trailer], depots: [NORDHAVN] })
    const seenByB = await asCompany(b.company, async (tx) => ({
      counts: await counts(tx),
      vehicles: (await tx.select({ id: vehicle.id }).from(vehicle).orderBy(vehicle.id)).map((row) => row.id),
    }))
    assert.deepEqual(seenByB, { counts: ownRows, vehicles: [b.vehicle, b.trailer] })
  })

  test("as the API role, a movement and an event can be appended and neither updated nor deleted (42501); the owner may do both", () =>
    asCompany(a.company, async (tx) => {
      await tx.insert(stockMovement).values(movement({}))
      await tx.insert(vehicleAllocationEvent).values({ id: a.other, companyId: a.company, projectId: a.project, vehicleAllocationId: a.allocation, action: "confirm", status: "confirmed", vehicleId: a.vehicle, plannedFrom: at(6), plannedTo: at(14), recordedBy: a.account })
      await assert.rejects(tx.transaction((savepoint) => savepoint.update(stockMovement).set({ reason: "rewritten" }).where(eq(stockMovement.id, a.spare))), refusedWith("42501", /permission denied for table stock_movement/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.delete(stockMovement).where(eq(stockMovement.id, a.spare))), refusedWith("42501", /permission denied for table stock_movement/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.update(vehicleAllocationEvent).set({ reason: "rewritten" }).where(eq(vehicleAllocationEvent.id, a.other))), refusedWith("42501", /permission denied for table vehicle_allocation_event/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.delete(vehicleAllocationEvent).where(eq(vehicleAllocationEvent.id, a.other))), refusedWith("42501", /permission denied for table vehicle_allocation_event/))
      // The reservation row itself is not a ledger: the API role updates it, and appends the event beside the update.
      await tx.update(vehicleAllocation).set({ status: "confirmed" }).where(eq(vehicleAllocation.id, a.allocation))
      // The owner keeps both rights, for tests and for erasure.
      await tx.execute(sql`reset role`)
      await tx.update(stockMovement).set({ reason: "rewritten by the owner" }).where(eq(stockMovement.id, a.spare))
      assert.equal((await tx.delete(stockMovement).where(eq(stockMovement.id, a.spare)).returning()).length, 1)
      assert.equal((await tx.delete(vehicleAllocationEvent).where(eq(vehicleAllocationEvent.id, a.other)).returning()).length, 1)
    }))

  test("a vehicle, a driver, a warehouse or a movement cannot name the depot or warehouse of another project of its own company (23503)", () =>
    seeded(async (tx) => {
      // A second project of company a, with a depot and a warehouse of its own. The tenant is the same, so only the project_id in the key stands between them.
      await tx.insert(project).values({ id: a.harbor, companyId: a.company, name: "Harbor", kind: "Contract", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active" })
      await tx.insert(depot).values({ id: a.harborDepot, companyId: a.company, projectId: a.harbor, code: "DEP-HAV", name: "Havnen", address: "Havnegade 1", location: AMAGER, ownership: "company", status: "active" })
      await tx.insert(warehouse).values({ id: a.harborWarehouse, companyId: a.company, projectId: a.harbor, code: "WH-HAV", name: "Havnen warehouse", address: "Havnegade 1", status: "active" })

      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(vehicle).values(truck({ homeDepotId: a.harborDepot }))), refusedWith("23503", /vehicle_home_depot_id_fk/))
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(driver).values({ id: a.spare, companyId: a.company, projectId: a.project, name: "Jonas Lind", employment: "employee", status: "active", homeDepotId: a.harborDepot })),
        refusedWith("23503", /driver_home_depot_id_fk/),
      )
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.update(warehouse).set({ depotId: a.harborDepot }).where(eq(warehouse.id, a.warehouse))),
        refusedWith("23503", /warehouse_depot_id_fk/),
      )
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(stockMovement).values(movement({ toWarehouseId: a.harborWarehouse }))), refusedWith("23503", /stock_movement_to_warehouse_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(stockMovement).values(movement({ fromWarehouseId: a.harborWarehouse }))), refusedWith("23503", /stock_movement_from_warehouse_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(vehicleAllocation).values(allocation({ depotId: a.harborDepot }))), refusedWith("23503", /vehicle_allocation_depot_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.update(routeScheme).set({ depotId: a.harborDepot }).where(eq(routeScheme.id, a.scheme))), refusedWith("23503", /route_scheme_depot_id_fk/))
      // The same rows land when every id they name is their own project's.
      await tx.insert(vehicle).values(truck({ homeDepotId: a.depot }))
      await tx.insert(stockMovement).values(movement({ id: a.other }))
    }))

  test("nor another company's placement, vehicle type, fraction, account or station (23503): every key carries the tenant", () =>
    seeded(async (tx) => {
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(stockMovement).values(movement({ kind: "issue", fromKind: "warehouse", toKind: "service", toWarehouseId: null, placementId: b.placement }))),
        refusedWith("23503", /stock_movement_placement_id_fk/),
      )
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(stockMovement).values(movement({ recordedBy: b.account }))), refusedWith("23503", /stock_movement_recorded_by_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(stockMovement).values(movement({ correctsMovementId: b.movement }))), refusedWith("23503", /stock_movement_corrects_movement_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(vehicle).values(truck({ vehicleTypeId: b.vehicleType }))), refusedWith("23503", /vehicle_vehicle_type_id_fk/))
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(containerTypeVehicleType).values({ id: a.spare, companyId: a.company, containerTypeId: b.containerType, vehicleTypeId: a.vehicleType })),
        refusedWith("23503", /container_type_vehicle_type_container_type_id_fk/),
      )
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(vehicleCompartmentFraction).values({ id: a.spare, companyId: a.company, projectId: a.project, vehicleCompartmentId: a.compartment, wasteFractionId: b.wasteFraction })),
        refusedWith("23503", /vehicle_compartment_fraction_waste_fraction_id_fk/),
      )
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(unloadingStationFraction).values({ id: a.spare, companyId: a.company, unloadingStationId: a.station, wasteFractionId: b.wasteFraction })),
        refusedWith("23503", /unloading_station_fraction_waste_fraction_id_fk/),
      )
      await assert.rejects(tx.transaction((savepoint) => savepoint.update(collectionGroup).set({ ruleVehicleTypeId: b.vehicleType }).where(eq(collectionGroup.id, a.group))), refusedWith("23503", /collection_group_rule_vehicle_type_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.update(collectionGroup).set({ vehicleId: b.vehicle }).where(eq(collectionGroup.id, a.group))), refusedWith("23503", /collection_group_vehicle_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.update(collectionGroup).set({ driverId: b.driver }).where(eq(collectionGroup.id, a.group))), refusedWith("23503", /collection_group_driver_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.update(routeScheme).set({ unloadingStationId: b.station }).where(eq(routeScheme.id, a.scheme))), refusedWith("23503", /route_scheme_unloading_station_id_fk/))
      // A correction may point at the company's own earlier movement, and a rule may ask for its own type.
      await tx.insert(stockMovement).values(movement({ kind: "adjustment", correctsMovementId: a.movement, reason: "Booked to the wrong shelf" }))
      await tx.update(collectionGroup).set({ ruleVehicleTypeId: a.vehicleType }).where(eq(collectionGroup.id, a.group))
    }))

  test("the ledger's three place checks: a warehouse goes with a stock kind on its side, a placement with a service kind on either (23514)", () =>
    seeded(async (tx) => {
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(stockMovement).values(movement({ fromWarehouseId: null }))), refusedWith("23514", /stock_movement_from_shape/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(stockMovement).values(movement({ kind: "receipt", fromKind: "supplier", fromWarehouseId: a.warehouse, toKind: "warehouse" }))), refusedWith("23514", /stock_movement_from_shape/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(stockMovement).values(movement({ toWarehouseId: null }))), refusedWith("23514", /stock_movement_to_shape/))
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(stockMovement).values(movement({ kind: "decommission", toKind: "scrap" }))),
        refusedWith("23514", /stock_movement_to_shape/),
        "scrap has no warehouse",
      )
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(stockMovement).values(movement({ kind: "issue", toKind: "service", toWarehouseId: null }))),
        refusedWith("23514", /stock_movement_placement_shape/),
        "into service without the placement",
      )
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(stockMovement).values(movement({ placementId: a.placement }))), refusedWith("23514", /stock_movement_placement_shape/), "a placement on a transfer")
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(stockMovement).values(movement({ kind: "borrow" }))), refusedWith("23514", /stock_movement_kind_one_of/))
      // A place outside the vocabulary, on a pair every other check lets through: only the vocabulary's check refuses it.
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(stockMovement).values(movement({ kind: "adjustment", fromKind: "truck", fromWarehouseId: null, toKind: "warehouse" }))), refusedWith("23514", /stock_movement_from_kind_one_of/))
      // Into service, with the placement and from the warehouse: the issue.
      await tx.insert(stockMovement).values(movement({ kind: "issue", toKind: "service", toWarehouseId: null, placementId: a.placement }))
    }))

  test("and the kind check agrees with the domain's movementShape on every one of the hundred and fifty triples (23514 stock_movement_kind_shape)", () =>
    seeded(async (tx) => {
      /** A row whose places agree with its kinds, so only the kind check can refuse it. */
      const shaped = (kind: StockMovementKind, fromKind: StockPlaceKind, toKind: StockPlaceKind) =>
        movement({
          kind,
          fromKind,
          fromWarehouseId: fromKind === "warehouse" || fromKind === "maintenance" ? a.warehouse : null,
          toKind,
          toWarehouseId: toKind === "warehouse" || toKind === "maintenance" ? a.warehouse : null,
          placementId: fromKind === "service" || toKind === "service" ? a.placement : null,
        })
      let allowed = 0
      for (const kind of STOCK_MOVEMENT_KINDS) {
        for (const fromKind of STOCK_PLACE_KINDS) {
          for (const toKind of STOCK_PLACE_KINDS) {
            const attempt = tx.transaction(async (savepoint) => {
              await savepoint.insert(stockMovement).values(shaped(kind, fromKind, toKind))
              // Rolled back with the savepoint, so the next triple starts clean.
              throw new Landed()
            })
            if (movementShape(kind, fromKind, toKind)) {
              allowed += 1
              await assert.rejects(attempt, (error: unknown) => error instanceof Landed, `${kind}: ${fromKind} → ${toKind} should land`)
            } else {
              await assert.rejects(attempt, refusedWith("23514", /stock_movement_kind_shape/), `${kind}: ${fromKind} → ${toKind} should be refused`)
            }
          }
        }
      }
      assert.equal(allowed, 24, "the pairs the glossary gives the six kinds")
    }))

  test("the vocabulary checks of the fleet and the places, and the shape checks a table alone has (23514)", () =>
    seeded(async (tx) => {
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(vehicle).values(truck({ requiredLicenceClass: "C" }))), refusedWith("23514", /vehicle_required_licence_class_one_of/), "the token is lowercase")
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(vehicle).values(truck({ kind: "bicycle" }))), refusedWith("23514", /vehicle_kind_one_of/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(vehicle).values(truck({ capacityKg: 0 }))), refusedWith("23514", /vehicle_capacity_kg_positive/))
      // A provider's vehicle names its provider and no other does.
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(vehicle).values(truck({ ownership: "service-provider" }))), refusedWith("23514", /vehicle_provider_shape/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(vehicle).values(truck({ serviceProviderId: a.serviceProvider }))), refusedWith("23514", /vehicle_provider_shape/))
      await tx.insert(vehicle).values(truck({ ownership: "service-provider", serviceProviderId: a.serviceProvider }))
      const place = { id: a.other, companyId: a.company, projectId: a.project, code: "DEP-2", name: "Second", address: "Somewhere 2", location: AMAGER, ownership: "company", status: "active" } as const
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(depot).values({ ...place, ownership: "service-provider" })), refusedWith("23514", /depot_provider_shape/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(depot).values({ ...place, opensAt: "06:00" })), refusedWith("23514", /depot_hours_shape/))
      await tx.insert(depot).values({ ...place, opensAt: "22:00", closesAt: "05:00" })
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(unloadingStation).values({ id: a.third, companyId: a.company, code: "ARC-2", name: "Second station", address: "Somewhere 3", location: AMAGER, ownership: "external", status: "active", closesAt: "16:00" })),
        refusedWith("23514", /unloading_station_hours_shape/),
      )
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(driver).values({ id: a.third, companyId: a.company, projectId: a.project, name: "Jonas Lind", employment: "service-provider", status: "active" })),
        refusedWith("23514", /driver_provider_shape/),
      )
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(driver).values({ id: a.third, companyId: a.company, projectId: a.project, name: "Jonas Lind", employment: "employee", status: "active", licenceClass: "CE" })),
        refusedWith("23514", /driver_licence_class_one_of/),
      )
      // A driver with no licence on record is a real record.
      await tx.insert(driver).values({ id: a.third, companyId: a.company, projectId: a.project, name: "Jonas Lind", employment: "employee", status: "active" })
      // An invalid point is refused where a property's would be.
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.update(warehouse).set({ location: { type: "Point", coordinates: [200, 55] } }).where(eq(warehouse.id, a.warehouse))),
        refusedWith("23514", /warehouse_location_valid/),
      )
    }))

  test("a manual group carries no vehicle type (23514 collection_group_rule_shape), re-spelled over the id", () =>
    seeded(async (tx) => {
      const manual: typeof collectionGroup.$inferInsert = { id: a.spare, companyId: a.company, projectId: a.project, routeSchemeId: a.scheme, name: "By hand", position: 2, days: ["monday"], stopSource: "manual" }
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(collectionGroup).values({ ...manual, ruleVehicleTypeId: a.vehicleType })), refusedWith("23514", /collection_group_rule_shape/))
      // A manual group may still have a vehicle and a driver: those are the group's, not the rule's.
      await tx.insert(collectionGroup).values({ ...manual, vehicleId: a.vehicle, driverId: a.driver })
    }))

  test("a callsign, a workforce reference and a login are each one row's per company where given, and nulls are not duplicates (23505)", () =>
    seeded(async (tx) => {
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(vehicle).values(truck({ callsign: "WH-24" }))), refusedWith("23505", /vehicle_callsign_idx/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(vehicle).values(truck({ registration: "CN 42 018" }))), refusedWith("23505", /vehicle_registration_key/))
      await tx.insert(vehicle).values([truck({ callsign: null }), truck({ id: a.other, registration: "CN 42 021", callsign: null })])
      const hire = { companyId: a.company, projectId: a.project, employment: "employee", status: "active" } as const
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(driver).values({ id: a.third, ...hire, name: "Second profile", userAccountId: a.account })), refusedWith("23505", /driver_user_account_id_idx/))
      await tx.insert(driver).values({ id: a.third, ...hire, name: "Jonas Lind", workforceReference: "WF-1" })
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(driver).values({ id: a.spare, ...hire, name: "Another", workforceReference: "WF-1" })), refusedWith("23505", /driver_workforce_reference_idx/))
      // The same callsign in another company is another vehicle.
      await tx.insert(vehicle).values([
        truck({ id: a.fourth, registration: "CN 42 022", callsign: "WH-25" }),
        truck({ id: b.spare, companyId: b.company, projectId: b.project, vehicleTypeId: b.vehicleType, registration: "CN 99 999", callsign: "WH-25" }),
      ])
    }))

  test("one live reservation of a vehicle at a time (23P01 vehicle_allocation_vehicle_no_overlap): released frees the window, and one may end when the next starts", () =>
    seeded(async (tx) => {
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(vehicleAllocation).values(allocation({ plannedFrom: at(10), plannedTo: at(18) }))), refusedWith("23P01", /vehicle_allocation_vehicle_no_overlap/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(vehicleAllocation).values(allocation({ plannedFrom: at(7), plannedTo: at(8) }))), refusedWith("23P01", /vehicle_allocation_vehicle_no_overlap/), "inside")
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(vehicleAllocation).values(allocation({ plannedFrom: at(10), plannedTo: at(18), status: "confirmed" }))), refusedWith("23P01", /vehicle_allocation_vehicle_no_overlap/), "confirmed blocks too")
      // Half-open: the afternoon starts the instant the morning ends.
      await tx.insert(vehicleAllocation).values(allocation({}))
      // A released reservation is out of the index, so the same window is free again.
      await tx.insert(vehicleAllocation).values(allocation({ id: a.other, plannedFrom: at(10), plannedTo: at(18), status: "released" }))
      await tx.update(vehicleAllocation).set({ status: "released" }).where(eq(vehicleAllocation.id, a.allocation))
      await tx.insert(vehicleAllocation).values(allocation({ id: a.third, plannedFrom: at(6), plannedTo: at(14) }))
      // Another vehicle over the same window is another reservation.
      await tx.insert(vehicleAllocation).values(allocation({ id: b.spare, vehicleId: a.trailer, plannedFrom: at(6), plannedTo: at(14) }))
    }))

  test("one live reservation of a driver and of a trailer at a time, each ignoring a null (23P01 vehicle_allocation_driver_no_overlap, _trailer_no_overlap)", () =>
    seeded(async (tx) => {
      await tx.insert(vehicle).values([truck({ id: a.other, registration: "CN 42 021" }), truck({ id: a.fourth, registration: "CN 42 022" })])
      // The seeded morning has Mads on WH-24; Mads on the second truck over the same window is refused, the second truck alone is not.
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(vehicleAllocation).values(allocation({ vehicleId: a.other, driverId: a.driver, plannedFrom: at(6), plannedTo: at(14) }))),
        refusedWith("23P01", /vehicle_allocation_driver_no_overlap/),
      )
      await tx.insert(vehicleAllocation).values(allocation({ vehicleId: a.other, plannedFrom: at(6), plannedTo: at(14) }))
      await tx.insert(vehicleAllocation).values(allocation({ id: a.third, vehicleId: a.trailer, plannedFrom: at(6), plannedTo: at(14) }))
      // Two reservations without a driver over one window: a null is kept out of the index and equals nothing.
      assert.equal((await tx.select({ id: vehicleAllocation.id }).from(vehicleAllocation).where(and(eq(vehicleAllocation.companyId, a.company), sql`${vehicleAllocation.driverId} is null`))).length, 2)
      // The trailer: hitched to the seeded morning, then asked for by the third truck's afternoon, which overlaps it.
      await tx.update(vehicleAllocation).set({ trailerId: a.trailer }).where(eq(vehicleAllocation.id, a.allocation))
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(vehicleAllocation).values(allocation({ id: a.fifth, vehicleId: a.fourth, trailerId: a.trailer, plannedFrom: at(10), plannedTo: at(18) }))),
        refusedWith("23P01", /vehicle_allocation_trailer_no_overlap/),
      )
      // Released, the driver and the trailer are free.
      await tx.update(vehicleAllocation).set({ status: "released" }).where(eq(vehicleAllocation.id, a.allocation))
      await tx.insert(vehicleAllocation).values(allocation({ id: a.fifth, vehicleId: a.fourth, driverId: a.driver, trailerId: a.trailer, plannedFrom: at(10), plannedTo: at(18) }))
    }))

  test("a window ends after it starts, strictly (23514 vehicle_allocation_window): an empty window would pass the constraint unseen", () =>
    seeded(async (tx) => {
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(vehicleAllocation).values(allocation({ plannedFrom: at(14), plannedTo: at(14) }))), refusedWith("23514", /vehicle_allocation_window/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(vehicleAllocation).values(allocation({ plannedFrom: at(15), plannedTo: at(14) }))), refusedWith("23514", /vehicle_allocation_window/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(vehicleAllocation).values(allocation({ status: "draft" }))), refusedWith("23514", /vehicle_allocation_status_one_of/))
      const [row] = await tx.select({ status: vehicleAllocation.status }).from(vehicleAllocation).where(eq(vehicleAllocation.id, a.allocation))
      assert.equal(row.status, "planned", "the default")
      // The event's window is a snapshot and is not checked: what it copies passed the check already.
      await tx.insert(vehicleAllocationEvent).values({ id: a.other, companyId: a.company, projectId: a.project, vehicleAllocationId: a.allocation, action: "release", status: "released", vehicleId: a.vehicle, plannedFrom: at(6), plannedTo: at(14), reason: "Truck in the workshop", recordedBy: a.account })
    }))

  test("the fold answers the latest movement of each container in recording order, and nothing for a container with none", () =>
    seeded(async (tx) => {
      const fold = async () => {
        const state = assetStateOf(tx, a.company)
        const rows = await tx
          .select({ container: container.id, status: assetStatus(state.toKind), warehouseId: state.toWarehouseId, placementId: state.placementId, movementId: state.movementId, since: state.occurredAt })
          .from(container)
          .leftJoin(state, and(eq(state.companyId, container.companyId), eq(state.containerId, container.id)))
          .where(eq(container.companyId, a.company))
          .orderBy(container.id)
        return rows
      }
      // The seeded receipt: in the warehouse; the second container has no record.
      assert.deepEqual(await fold(), [
        { container: a.container, status: "in-warehouse", warehouseId: a.warehouse, placementId: null, movementId: a.movement, since: at(8, 1) },
        { container: a.unmoved, status: null, warehouseId: null, placementId: null, movementId: null, since: null },
      ])
      // Issued: in service at the placement.
      await tx.insert(stockMovement).values(movement({ id: a.spare, kind: "issue", toKind: "service", toWarehouseId: null, placementId: a.placement, occurredAt: at(9, 2) }))
      assert.deepEqual((await fold())[0], { container: a.container, status: "in-service", warehouseId: null, placementId: a.placement, movementId: a.spare, since: at(9, 2) })
      // A later row with an earlier occurred_at is still the latest: recording order, not the clock on the person's word.
      await tx.insert(stockMovement).values(movement({ id: a.other, kind: "return", fromKind: "service", fromWarehouseId: null, toKind: "maintenance", placementId: a.placement, occurredAt: at(7, 2) }))
      assert.deepEqual((await fold())[0], { container: a.container, status: "in-maintenance", warehouseId: a.warehouse, placementId: a.placement, movementId: a.other, since: at(7, 2) })
      await tx.insert(stockMovement).values(movement({ id: a.third, kind: "decommission", fromKind: "maintenance", toKind: "scrap", toWarehouseId: null, occurredAt: at(10, 2) }))
      assert.equal((await fold())[0].status, "retired")
      // The other company's containers are not in this company's fold, and the filter by status runs in SQL.
      const state = assetStateOf(tx, a.company)
      const retired = await tx
        .select({ container: container.id })
        .from(container)
        .innerJoin(state, and(eq(state.companyId, container.companyId), eq(state.containerId, container.id)))
        .where(and(eq(container.companyId, a.company), eq(assetStatus(state.toKind), "retired")))
      assert.deepEqual(retired, [{ container: a.container }])
    }))
})

/** Thrown out of a savepoint to roll it back after a statement landed. */
class Landed extends Error {}
