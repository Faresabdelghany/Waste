// What the driver door's suite needs of Execution beyond its own routes
// (Issue #104, slice 4): the logins the drivers of `seedFleet` drive under,
// the Registry rows a pickup names, a scheme with a group for a route to hang
// off, and a minter of routes — a fresh `planned` or `ready` route with its
// pickups per test, since a `start-route` changes the route it is sent to and
// the suite's tests must not share one. The rows are written directly through
// `tx` as `wms_api` inside `withCompany`, the way scheme-fixtures.ts seeds
// Planning and the fleet: routes are generation's to write (#97 B) and the
// office API's to move (slice 3), and this suite proves the driver door.
//
// Slice 3's `execution-fixtures.ts` seeds routes the same way for the office
// suites; the integrator folds this file into it, keeping `routeFor` (the
// minter the driver suite calls per test) and the three driver logins.
//
// The logins say one thing each about the door's own fence. Mads Jensen is an
// employee driver on the system `Driver` role with no Project Access at all,
// which is what proves the door reads the assignment and never `inProjects`.
// Ali Hassan is NordRen's driver — `employment = 'service-provider'`, an
// account with Service Provider Access and no project — the case #104 §5
// names: a provider's driver reaches exactly the routes assigned to them and
// nothing else. Karen Holt's login is bound to the fleet's inactive driver,
// the 403 whatever the token says.
//
// Until slice 3's `dropTenant` sweeps the seven Execution tables, this file's
// `dropExecution` does — the three ledgers and the outbox as the owner,
// sessions, pickups and routes as `wms_api` — and a suite calls it before
// `dropTenant`. Remove it at the merge.
import { randomUUID } from "node:crypto"

import type { Database, Tx } from "@waste/db/client"
import { role, roleGrant, serviceProviderAccess, userAccount } from "@waste/db/schema/access"
import { containerType, wasteFraction } from "@waste/db/schema/catalogue"
import { container } from "@waste/db/schema/containers"
import { property } from "@waste/db/schema/customers"
import { driverCommand, outboxEvent, pickup, proofOfService, route, session, unload } from "@waste/db/schema/execution"
import { driver } from "@waste/db/schema/fleet"
import { collectionGroup, routeScheme } from "@waste/db/schema/route-schemes"
import { withCompany } from "@waste/db/tenant"
import { normaliseGrants } from "@waste/domain/access/grants"
import { SYSTEM_ROLES } from "@waste/domain/access/system-roles"
import { and, eq } from "drizzle-orm"

import type { FixtureDriver, FleetFixtures } from "./scheme-fixtures"
import { testId, type Account, type Tenant } from "./tenant"

export type DriverFixtures = {
  /** The system `Driver` role, on its charter: `operate.driver-app` view and edit among them. */
  role: { id: string }
  accounts: {
    /** Mads Jensen's login: an employee driver with no Project Access. */
    mads: Account
    /** Ali Hassan's login: NordRen's driver, Service Provider Access and no project. */
    ali: Account
    /** Karen Holt's login: bound to the fleet's inactive driver. */
    karen: Account
    /** Freja Holm's login: B, so WH-24 (C) is a licence too low. */
    freja: Account
    /** Sofie Nielsen's login: C, expired before the operating date. */
    sofie: Account
  }
  drivers: {
    /** NordRen's driver in Copenhagen Central, CE. */
    ali: FixtureDriver
  }
  /** The fraction every pickup here names, and the type every container is of. */
  residual: { id: string }
  binType: { id: string }
  /** Three containers of Copenhagen Central; a route's pickups take them in order. */
  containers: { id: string; label: string }[]
  /** The one service address the pickups stand at. */
  property: { id: string }
  /** The scheme and the group every Copenhagen route here hangs off. */
  scheme: { id: string }
  group: { id: string }
  /** Harbor Commercial's scheme and group, for the one route of another project than Mads's. */
  harbor: { scheme: { id: string }; group: { id: string } }
}

/** The day the fixture routes run: the suite pins its clock to a morning of it. */
export const OPERATING_DATE = "2026-10-05"

/** The charter of a system role, normalised, as tenant.ts reads it. */
const charter = (key: string) => {
  const found = SYSTEM_ROLES.find((systemRole) => systemRole.key === key)
  if (!found) throw new Error(`no system role ${key}`)
  return normaliseGrants(found.grants)
}

export async function seedDriverFixtures(pool: Database, tenant: Tenant, fleet: FleetFixtures): Promise<DriverFixtures> {
  const { companyId } = tenant
  const copenhagen = tenant.projects.copenhagen.id
  const domain = tenant.users.olivia.email.split("@")[1]
  const account = (localPart: string, fullName: string): Account => ({ id: testId(), authUserId: randomUUID(), email: `${localPart}@${domain}`, fullName })
  const fixtures: DriverFixtures = {
    role: { id: testId() },
    accounts: {
      mads: account("mads.jensen", "Mads Jensen"),
      ali: account("ali.hassan", "Ali Hassan"),
      karen: account("karen.holt", "Karen Holt"),
      freja: account("freja.holm", "Freja Holm"),
      sofie: account("sofie.nielsen", "Sofie Nielsen"),
    },
    drivers: { ali: { id: testId(), name: "Ali Hassan" } },
    residual: { id: testId() },
    binType: { id: testId() },
    containers: [
      { id: testId(), label: "BIN-82014" },
      { id: testId(), label: "BIN-82015" },
      { id: testId(), label: "BIN-82016" },
    ],
    property: { id: testId() },
    scheme: { id: testId() },
    group: { id: testId() },
    harbor: { scheme: { id: testId() }, group: { id: testId() } },
  }
  const scoped = { companyId, projectId: copenhagen }
  const harbor = { companyId, projectId: tenant.projects.harbor.id }

  await withCompany(pool.db, companyId, async (tx: Tx) => {
    await tx.insert(role).values({ id: fixtures.role.id, companyId, key: "driver", name: "Driver", scope: "Assigned routes", description: "Driver app and assigned route execution", system: true })
    await tx.insert(roleGrant).values(charter("driver").flatMap((grant) => grant.actions.map((action) => ({ companyId, roleId: fixtures.role.id, moduleKey: grant.moduleKey, action }))))
    const { mads, ali, karen, freja, sofie } = fixtures.accounts
    const login = (row: Account) => ({ id: row.id, companyId, authUserId: row.authUserId, email: row.email, fullName: row.fullName, roleId: fixtures.role.id })
    await tx.insert(userAccount).values([login(mads), { ...login(ali), serviceProviderId: tenant.serviceProviders.nordren.id }, login(karen), login(freja), login(sofie)])
    await tx.insert(serviceProviderAccess).values({ companyId, userAccountId: ali.id, serviceProviderId: tenant.serviceProviders.nordren.id })
    for (const [row, who] of [
      [mads, fleet.drivers.mads],
      [karen, fleet.drivers.karen],
      [freja, fleet.drivers.freja],
      [sofie, fleet.drivers.sofie],
    ] as const) {
      await tx.update(driver).set({ userAccountId: row.id }).where(and(eq(driver.companyId, companyId), eq(driver.id, who.id)))
    }
    await tx.insert(driver).values({
      id: fixtures.drivers.ali.id,
      ...scoped,
      name: fixtures.drivers.ali.name,
      employment: "service-provider",
      serviceProviderId: tenant.serviceProviders.nordren.id,
      licenceClass: "ce",
      licenceExpiry: "2031-12-31",
      userAccountId: ali.id,
      status: "active",
    })
    await tx.insert(wasteFraction).values({ id: fixtures.residual.id, companyId, key: "residual", name: "Residual waste" })
    await tx.insert(containerType).values({ id: fixtures.binType.id, companyId, name: "240 L bin", volumeLitres: 240 })
    await tx.insert(container).values(fixtures.containers.map((bin) => ({ id: bin.id, ...scoped, label: bin.label, containerTypeId: fixtures.binType.id, ownership: "company" })))
    await tx.insert(property).values({ id: fixtures.property.id, ...scoped, name: "Parkvej 18", address: "Parkvej 18, 2100 København Ø", kind: "residential", status: "active" })
    await tx.insert(routeScheme).values({
      id: fixtures.scheme.id,
      ...scoped,
      validFrom: "2026-01-01",
      name: "Residual weekly",
      serviceType: "container-collection",
      frequency: "weekly",
      serviceDays: ["monday"],
      plannedStartTime: "06:30",
      depotId: fleet.depots.nordhavn.id,
      unloadingStationId: fleet.stations.amager.id,
    })
    await tx.insert(collectionGroup).values({ id: fixtures.group.id, ...scoped, routeSchemeId: fixtures.scheme.id, name: "Rear loaders", position: 1, days: ["monday"], stopSource: "manual" })
    await tx.insert(routeScheme).values({ id: fixtures.harbor.scheme.id, ...harbor, validFrom: "2026-01-01", name: "Harbor weekly", serviceType: "container-collection", frequency: "weekly", serviceDays: ["tuesday"], depotId: fleet.depots.harbor.id })
    await tx.insert(collectionGroup).values({ id: fixtures.harbor.group.id, ...harbor, routeSchemeId: fixtures.harbor.scheme.id, name: "Harbor", position: 1, days: ["tuesday"], stopSource: "manual" })
  })
  return fixtures
}

/** A route as the suite names it: its id, its display number and label, and its pickups' ids by position. */
export type FixtureRoute = { id: string; number: number; label: string; pickupIds: string[] }

export type RouteOptions = {
  /** Whom the route is planned for; a route planned for nobody is one the door never shows. */
  driver: FixtureDriver | null
  /** The planned vehicle; WH-24 unless said. */
  vehicle?: { id: string }
  /** `ready` unless said: a `planned` route is the one a driver may not start. */
  status?: "planned" | "ready"
  /** How many pickups, 1..3, on the fixture containers in order; two unless said. */
  pickups?: number
  /** `OPERATING_DATE` unless said. */
  operatingDate?: string
  /** The planned service provider, for a provider's route. */
  serviceProviderId?: string
  /** Copenhagen Central unless said; a Harbor route takes Harbor's truck and no pickups, since the containers and the address are Copenhagen's. */
  project?: "copenhagen" | "harbor"
}

/** The company's next route number: `RC-1042` and up, unique per company, minted here since generation is not running. */
const numbers = new Map<string, number>()
const nextNumber = (companyId: string): number => {
  const next = (numbers.get(companyId) ?? 1041) + 1
  numbers.set(companyId, next)
  return next
}

/**
 * Mints one route of Copenhagen Central with its pickups, `ready` and
 * dispatched a moment ago unless `planned`, on a service date of its own so
 * the generation key never collides: the identity is scheme, group and
 * service date, and two routes of one group on one operating day is what a
 * shifted holiday makes, so the service date walks back a day per route
 * while the operating date stays.
 */
export async function routeFor(pool: Database, tenant: Tenant, fleet: FleetFixtures, fixtures: DriverFixtures, options: RouteOptions): Promise<FixtureRoute> {
  const { companyId } = tenant
  const inHarbor = options.project === "harbor"
  const scoped = { companyId, projectId: inHarbor ? tenant.projects.harbor.id : tenant.projects.copenhagen.id }
  const number = nextNumber(companyId)
  const status = options.status ?? "ready"
  const operatingDate = options.operatingDate ?? OPERATING_DATE
  const serviceDate = new Date(Date.parse(`${operatingDate}T00:00:00Z`) - (number - 1041) * 86_400_000).toISOString().slice(0, 10)
  const minted: FixtureRoute = { id: testId(), number, label: `RC-${number}`, pickupIds: [] }
  const count = options.pickups ?? (inHarbor ? 0 : 2)
  if (count > fixtures.containers.length) throw new Error(`routeFor: ${count} pickups over ${fixtures.containers.length} containers`)
  if (inHarbor && count > 0) throw new Error("routeFor: a Harbor route has no pickups; the containers and the address are Copenhagen's")
  await withCompany(pool.db, companyId, async (tx: Tx) => {
    await tx.insert(route).values({
      id: minted.id,
      ...scoped,
      routeSchemeId: inHarbor ? fixtures.harbor.scheme.id : fixtures.scheme.id,
      collectionGroupId: inHarbor ? fixtures.harbor.group.id : fixtures.group.id,
      serviceDate,
      operatingDate,
      status,
      number,
      plannedStartTime: "06:30",
      plannedVehicleId: options.vehicle?.id ?? (inHarbor ? fleet.vehicles.harborTruck.id : fleet.vehicles.wh24.id),
      plannedDriverId: options.driver?.id ?? null,
      depotId: inHarbor ? fleet.depots.harbor.id : fleet.depots.nordhavn.id,
      unloadingStationId: fleet.stations.amager.id,
      plannedServiceProviderId: options.serviceProviderId ?? null,
      dispatchedAt: status === "ready" ? new Date(`${operatingDate}T04:00:00Z`) : null,
    })
    for (let position = 1; position <= count; position += 1) {
      const id = testId()
      minted.pickupIds.push(id)
      await tx.insert(pickup).values({ id, ...scoped, routeId: minted.id, containerId: fixtures.containers[position - 1].id, position, propertyId: fixtures.property.id, wasteFractionId: fixtures.residual.id })
    }
  })
  return minted
}

/**
 * Deletes the company's Execution rows, children first: the three ledgers and
 * the outbox as the owner (`appendOnly` revoked the API role's delete on the
 * ledgers), then sessions, pickups and routes as `wms_api`. Called before
 * `dropTenant`, which does not know these tables yet; slice 3 teaches it, and
 * this goes at the merge.
 */
export async function dropExecution(pool: Database, owner: Database, companyId: string): Promise<void> {
  await owner.db.delete(outboxEvent).where(eq(outboxEvent.companyId, companyId))
  await owner.db.delete(driverCommand).where(eq(driverCommand.companyId, companyId))
  await owner.db.delete(unload).where(eq(unload.companyId, companyId))
  await owner.db.delete(proofOfService).where(eq(proofOfService.companyId, companyId))
  await withCompany(pool.db, companyId, async (tx: Tx) => {
    await tx.delete(session).where(eq(session.companyId, companyId))
    await tx.delete(pickup).where(eq(pickup.companyId, companyId))
    await tx.delete(route).where(eq(route.companyId, companyId))
  })
}
