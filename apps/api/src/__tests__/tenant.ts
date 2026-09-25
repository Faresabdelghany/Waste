// A company of a test file's own on the shared local database. The API's
// tests connect as the API role and nothing else (database.ts), so a tenant is
// seeded the way the API would write it: as `wms_api`, inside `withCompany`,
// the company row first with `company_id = id` so the fence's WITH CHECK
// passes, then everything else in dependency order; and it is dropped the same
// way, in reverse, so a failing test leaves no rows behind. Every value that
// is unique across companies (the registration number, the e-mails, the auth
// user ids) is random, so two files run at once without meeting each other or
// the seeded demo company, whose registration number, e-mails and ids are
// spoken for.
//
// The shape is the demo company's, so a test's expectations read like the
// issue: Olivia (Company Administrator, all projects, primary administrator)
// and Lars (Service Provider Manager at NordRen, one Service Provider Access,
// no projects), plus what the request path needs beyond them: a deactivated
// account, an invited one that no login is bound to, and a viewer on a custom
// role with one grant and one project, which is the other branch of every
// rule Olivia takes the wide side of.
import { randomBytes, randomInt, randomUUID } from "node:crypto"

import type { Database, Tx } from "@waste/db/client"
import { projectAccess, role, roleGrant, serviceProviderAccess, userAccount } from "@waste/db/schema/access"
import { agreement, subscription } from "@waste/db/schema/agreements"
import { containerType, product, serviceFrequency, wasteFraction } from "@waste/db/schema/catalogue"
import { collectionCalendar, collectionCalendarHoliday } from "@waste/db/schema/collection-calendars"
import { vehicleAllocation, vehicleAllocationEvent } from "@waste/db/schema/allocations"
import { container, containerServicePlacement } from "@waste/db/schema/containers"
import { driver, vehicle, vehicleCompartment, vehicleCompartmentFraction } from "@waste/db/schema/fleet"
import { containerTypeVehicleType, vehicleType } from "@waste/db/schema/fleet-types"
import { depot, unloadingStation, unloadingStationFraction, warehouse } from "@waste/db/schema/places"
import { stockMovement } from "@waste/db/schema/stock"
import {
  customer,
  property,
  propertyGroup,
  propertyGroupMember,
  propertyParty,
  sharedCollectionPoint,
  sharedCollectionPointMember,
} from "@waste/db/schema/customers"
import { company, project, serviceProvider } from "@waste/db/schema/organisation"
import { planningArea, planningAreaBoundary } from "@waste/db/schema/planning-areas"
import { collectionGroup, collectionGroupContainer, collectionGroupContainerType, collectionGroupFraction, routeScheme } from "@waste/db/schema/route-schemes"
import { withCompany } from "@waste/db/tenant"
import { normaliseGrants, type Grant } from "@waste/domain/access/grants"
import { SYSTEM_ROLES, type SystemRoleKey } from "@waste/domain/access/system-roles"
import { eq } from "drizzle-orm"

/**
 * A UUID version 7 for a test row: the clock in the first 48 bits, the version
 * and variant nibbles, randomness in the rest. The contracts' `Id` accepts
 * version 7 only, so a test row's id must be one; the API mints its own from
 * slice 4 on (ADR-0004), and this stays a test's.
 */
export function testId(now = Date.now()): string {
  const time = now.toString(16).padStart(12, "0")
  const random = randomBytes(10).toString("hex")
  const variant = (0x8 | (parseInt(random[3], 16) & 0x3)).toString(16)
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${random.slice(0, 3)}-${variant}${random.slice(4, 7)}-${random.slice(7, 19)}`
}

export type Account = {
  id: string
  /** The auth user id a token's `sub` must carry; null for an invited account. */
  authUserId: string | null
  email: string
  fullName: string
}

export type Tenant = {
  companyId: string
  name: string
  projects: { copenhagen: { id: string; name: string }; harbor: { id: string; name: string }; cairo: { id: string; name: string } }
  serviceProviders: { nordren: { id: string; legalName: string }; cityhaul: { id: string; legalName: string } }
  roles: {
    administrator: { id: string; key: SystemRoleKey; grants: Grant[] }
    providerManager: { id: string; key: SystemRoleKey; grants: Grant[] }
    /** A custom role: no key, `view` on configure.access and nothing else. */
    viewer: { id: string; grants: Grant[] }
  }
  users: {
    olivia: Account
    lars: Account
    /** On the administrator role, deactivated a moment ago. */
    deactivated: Account
    /** Never signed in: no auth user id. */
    invited: Account
    /** On the viewer role, with Project Access to Copenhagen Central only. */
    viewer: Account
  }
}

const charter = (key: SystemRoleKey): Grant[] => {
  const found = SYSTEM_ROLES.find((systemRole) => systemRole.key === key)
  if (!found) throw new Error(`no system role ${key}`)
  return normaliseGrants(found.grants)
}

const grantRows = (companyId: string, roleId: string, grants: Grant[]) =>
  grants.flatMap((grant) => grant.actions.map((action) => ({ companyId, roleId, moduleKey: grant.moduleKey, action })))

/** Seeds a company as `wms_api` and answers its ids; drop it with `dropTenant` in `after`. */
export async function seedTenant(pool: Database): Promise<Tenant> {
  const companyId = testId()
  const slug = randomBytes(4).toString("hex")
  const domain = `${slug}.example`
  const account = (localPart: string, fullName: string, authUserId: string | null = randomUUID()): Account => ({
    id: testId(),
    authUserId,
    email: `${localPart}@${domain}`,
    fullName,
  })

  const tenant: Tenant = {
    companyId,
    name: `Test Company ${slug}`,
    projects: {
      copenhagen: { id: testId(), name: "Copenhagen Central" },
      harbor: { id: testId(), name: "Harbor Commercial" },
      cairo: { id: testId(), name: "Cairo Operations" },
    },
    serviceProviders: {
      nordren: { id: testId(), legalName: "NordRen ApS" },
      cityhaul: { id: testId(), legalName: "CityHaul A/S" },
    },
    roles: {
      administrator: { id: testId(), key: "company-administrator", grants: charter("company-administrator") },
      providerManager: { id: testId(), key: "service-provider-manager", grants: charter("service-provider-manager") },
      viewer: { id: testId(), grants: normaliseGrants([{ moduleKey: "configure.access", actions: ["view"] }]) },
    },
    users: {
      olivia: account("olivia.larsen", "Olivia Larsen"),
      lars: account("lars.mikkelsen", "Lars Mikkelsen"),
      deactivated: account("former.colleague", "Former Colleague"),
      invited: account("new.colleague", "New Colleague", null),
      viewer: account("viewer", "Vera Viewer"),
    },
  }

  await withCompany(pool.db, companyId, async (tx) => {
    await tx.insert(company).values({
      id: companyId,
      companyId,
      name: tenant.name,
      legalName: `${tenant.name} A/S`,
      // Eight digits like a CVR number; the demo company's is 12345678.
      registrationNumber: String(randomInt(10_000_000, 100_000_000)),
      country: "DK",
      status: "active",
    })
    await tx.insert(project).values([
      { id: tenant.projects.copenhagen.id, companyId, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active" },
      { id: tenant.projects.harbor.id, companyId, name: "Harbor Commercial", kind: "Business unit", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "onboarding" },
      { id: tenant.projects.cairo.id, companyId, name: "Cairo Operations", kind: "Municipality", language: "ar", currency: "EGP", timezone: "Africa/Cairo", status: "active" },
    ])
    await tx.insert(serviceProvider).values([
      { id: tenant.serviceProviders.nordren.id, companyId, legalName: "NordRen ApS", registrationNumber: String(randomInt(10_000_000, 100_000_000)), country: "DK", contactName: "Lars Mikkelsen", contactEmail: `lars.mikkelsen@${domain}` },
      { id: tenant.serviceProviders.cityhaul.id, companyId, legalName: "CityHaul A/S", registrationNumber: String(randomInt(10_000_000, 100_000_000)), country: "DK", contactName: "Mikkel Andersen", contactEmail: `mikkel.andersen@${domain}` },
    ])
    await tx.insert(role).values([
      { id: tenant.roles.administrator.id, companyId, key: "company-administrator", name: "Company Administrator", scope: "Company", description: "Everything in the company", system: true },
      { id: tenant.roles.providerManager.id, companyId, key: "service-provider-manager", name: "Service Provider Manager", scope: "Own service provider", description: "Runs the provider's routes", system: true },
      { id: tenant.roles.viewer.id, companyId, key: null, name: "Viewer", scope: "Assigned projects", description: "Looks at access settings", system: false },
    ])
    const { olivia, lars, deactivated, invited, viewer } = tenant.users
    await tx.insert(userAccount).values([
      { id: olivia.id, companyId, authUserId: olivia.authUserId, email: olivia.email, fullName: olivia.fullName, roleId: tenant.roles.administrator.id, allProjects: true, primaryAdministrator: true },
      { id: lars.id, companyId, authUserId: lars.authUserId, email: lars.email, fullName: lars.fullName, roleId: tenant.roles.providerManager.id, serviceProviderId: tenant.serviceProviders.nordren.id },
      { id: deactivated.id, companyId, authUserId: deactivated.authUserId, email: deactivated.email, fullName: deactivated.fullName, roleId: tenant.roles.administrator.id, allProjects: true, deactivatedAt: new Date() },
      { id: invited.id, companyId, authUserId: null, email: invited.email, fullName: invited.fullName, roleId: tenant.roles.administrator.id, allProjects: true },
      { id: viewer.id, companyId, authUserId: viewer.authUserId, email: viewer.email, fullName: viewer.fullName, roleId: tenant.roles.viewer.id },
    ])
    await tx.insert(roleGrant).values([
      ...grantRows(companyId, tenant.roles.administrator.id, tenant.roles.administrator.grants),
      ...grantRows(companyId, tenant.roles.providerManager.id, tenant.roles.providerManager.grants),
      ...grantRows(companyId, tenant.roles.viewer.id, tenant.roles.viewer.grants),
    ])
    await tx.insert(projectAccess).values({ companyId, userAccountId: viewer.id, projectId: tenant.projects.copenhagen.id })
    await tx.insert(serviceProviderAccess).values({ companyId, userAccountId: lars.id, serviceProviderId: tenant.serviceProviders.nordren.id })
  })

  return tenant
}

/** A company with no project yet: its administrator, and nothing else to seed. */
export type BareTenant = { companyId: string; roles: { administrator: { id: string } }; users: { olivia: Account } }

/**
 * A company that has registered no project, for the one rule that turns on
 * it (Issue #101, review round A): an account granted every project reaches
 * what serves every project — an unloading station — before the company has
 * its first project, since `allProjects` is a grant and not a count
 * (routes/unloading-stations.ts). Olivia is seeded as in `seedTenant`, on
 * the administrator charter, `allProjects` and primary. Drop it with
 * `dropTenant` like any tenant.
 */
export async function seedCompanyWithoutProjects(pool: Database): Promise<BareTenant> {
  const companyId = testId()
  const slug = randomBytes(4).toString("hex")
  const tenant: BareTenant = {
    companyId,
    roles: { administrator: { id: testId() } },
    users: { olivia: { id: testId(), authUserId: randomUUID(), email: `olivia.larsen@${slug}.example`, fullName: "Olivia Larsen" } },
  }
  await withCompany(pool.db, companyId, async (tx) => {
    await tx.insert(company).values({
      id: companyId,
      companyId,
      name: `Test Company ${slug}`,
      legalName: `Test Company ${slug} A/S`,
      registrationNumber: String(randomInt(10_000_000, 100_000_000)),
      country: "DK",
      status: "active",
    })
    await tx.insert(role).values({ id: tenant.roles.administrator.id, companyId, key: "company-administrator", name: "Company Administrator", scope: "Company", description: "Everything in the company", system: true })
    const { olivia } = tenant.users
    await tx.insert(userAccount).values({ id: olivia.id, companyId, authUserId: olivia.authUserId, email: olivia.email, fullName: olivia.fullName, roleId: tenant.roles.administrator.id, allProjects: true, primaryAdministrator: true })
    await tx.insert(roleGrant).values(grantRows(companyId, tenant.roles.administrator.id, charter("company-administrator")))
  })
  return tenant
}

/**
 * Grants a seeded role rows beyond its charter, the way a company does when
 * it edits the permission matrix. A route test of a context the seeded
 * charters say nothing about — the Registry's master data, its products, its
 * customers — grants the role it calls as exactly the actions that test needs,
 * so what a call may do is spelled in the file that makes the call and no
 * charter here has to grow for a test's sake.
 */
export async function grantRole(pool: Database, companyId: string, roleId: string, grants: readonly Grant[]): Promise<void> {
  await withCompany(pool.db, companyId, async (tx: Tx) => {
    await tx.insert(roleGrant).values(grantRows(companyId, roleId, normaliseGrants(grants)))
  })
}

/**
 * Deletes everything of the company, as `wms_api` under the fence, children
 * first. Nothing there is fine. The Registry's fifteen tables go before
 * Organisation & Access's, since every one of them keys on the company and
 * most on a project (Issue #78). Planning's nine tables go before the
 * Registry's, children first, since a collection group names the Registry's
 * fractions, container types and containers (Issue #97), and Resources'
 * eleven go between them — a group names a vehicle and a driver, a scheme a
 * depot and a station, a movement a container and a placement (Issue #101).
 * The two ledgers, `stock_movement` and `vehicle_allocation_event`, are swept
 * first and as the owner (`owner`, a pool on `DATABASE_ADMIN_URL`), since
 * `wms_api` may not delete from them and the keys would stop the containers
 * and allocations going otherwise (#101 §6.24); a suite that writes no ledger
 * row passes none, and one that does and passes none fails loudly on the key.
 */
export async function dropTenant(pool: Database, companyId: string, owner?: Database): Promise<void> {
  if (owner !== undefined) {
    await owner.db.delete(vehicleAllocationEvent).where(eq(vehicleAllocationEvent.companyId, companyId))
    await owner.db.delete(stockMovement).where(eq(stockMovement.companyId, companyId))
  }
  await withCompany(pool.db, companyId, async (tx: Tx) => {
    await tx.delete(collectionGroupContainer).where(eq(collectionGroupContainer.companyId, companyId))
    await tx.delete(collectionGroupContainerType).where(eq(collectionGroupContainerType.companyId, companyId))
    await tx.delete(collectionGroupFraction).where(eq(collectionGroupFraction.companyId, companyId))
    await tx.delete(collectionGroup).where(eq(collectionGroup.companyId, companyId))
    await tx.delete(routeScheme).where(eq(routeScheme.companyId, companyId))
    await tx.delete(vehicleAllocation).where(eq(vehicleAllocation.companyId, companyId))
    await tx.delete(vehicleCompartmentFraction).where(eq(vehicleCompartmentFraction.companyId, companyId))
    await tx.delete(vehicleCompartment).where(eq(vehicleCompartment.companyId, companyId))
    await tx.delete(vehicle).where(eq(vehicle.companyId, companyId))
    await tx.delete(driver).where(eq(driver.companyId, companyId))
    await tx.delete(unloadingStationFraction).where(eq(unloadingStationFraction.companyId, companyId))
    await tx.delete(unloadingStation).where(eq(unloadingStation.companyId, companyId))
    await tx.delete(warehouse).where(eq(warehouse.companyId, companyId))
    await tx.delete(depot).where(eq(depot.companyId, companyId))
    await tx.delete(containerTypeVehicleType).where(eq(containerTypeVehicleType.companyId, companyId))
    await tx.delete(vehicleType).where(eq(vehicleType.companyId, companyId))
    await tx.delete(collectionCalendarHoliday).where(eq(collectionCalendarHoliday.companyId, companyId))
    await tx.delete(collectionCalendar).where(eq(collectionCalendar.companyId, companyId))
    await tx.delete(planningAreaBoundary).where(eq(planningAreaBoundary.companyId, companyId))
    await tx.delete(planningArea).where(eq(planningArea.companyId, companyId))
    await tx.delete(containerServicePlacement).where(eq(containerServicePlacement.companyId, companyId))
    await tx.delete(subscription).where(eq(subscription.companyId, companyId))
    await tx.delete(agreement).where(eq(agreement.companyId, companyId))
    await tx.delete(container).where(eq(container.companyId, companyId))
    await tx.delete(product).where(eq(product.companyId, companyId))
    await tx.delete(serviceFrequency).where(eq(serviceFrequency.companyId, companyId))
    await tx.delete(sharedCollectionPointMember).where(eq(sharedCollectionPointMember.companyId, companyId))
    await tx.delete(sharedCollectionPoint).where(eq(sharedCollectionPoint.companyId, companyId))
    await tx.delete(propertyGroupMember).where(eq(propertyGroupMember.companyId, companyId))
    await tx.delete(propertyGroup).where(eq(propertyGroup.companyId, companyId))
    await tx.delete(propertyParty).where(eq(propertyParty.companyId, companyId))
    await tx.delete(property).where(eq(property.companyId, companyId))
    await tx.delete(customer).where(eq(customer.companyId, companyId))
    await tx.delete(containerType).where(eq(containerType.companyId, companyId))
    await tx.delete(wasteFraction).where(eq(wasteFraction.companyId, companyId))
    await tx.delete(serviceProviderAccess).where(eq(serviceProviderAccess.companyId, companyId))
    await tx.delete(projectAccess).where(eq(projectAccess.companyId, companyId))
    await tx.delete(roleGrant).where(eq(roleGrant.companyId, companyId))
    await tx.delete(userAccount).where(eq(userAccount.companyId, companyId))
    await tx.delete(role).where(eq(role.companyId, companyId))
    await tx.delete(serviceProvider).where(eq(serviceProvider.companyId, companyId))
    await tx.delete(project).where(eq(project.companyId, companyId))
    await tx.delete(company).where(eq(company.companyId, companyId))
  })
}
