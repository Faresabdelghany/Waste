// The demo seed (Issue #70, slice 2; the Registry since 2026-09-25; the
// pilot's Planning, Resources and Finance configuration since #156, whose
// rows seed-configuration.test.ts reads one by one) against a fresh database
// of its own, so that "a clean database becomes the demo company" is what is
// proved and nothing depends on what the shared local database holds. The properties that matter: it writes what the spec lists,
// a second run writes nothing at all, a row someone edited by hand goes back
// to what the seed says, and what the seed does not own — a Login's binding,
// the id the API gave an access row it wrote back — stays as it is. The ids
// are fixed constants, so a hosted token opens the same company locally;
// their shape is checked without a database.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { after, before, describe, test } from "node:test"

import { SYSTEM_ROLES, SYSTEM_ROLE_KEYS } from "@waste/domain/access/system-roles"
import { and, eq, sql } from "drizzle-orm"

import { createDb, type Database } from "../client"
import { migrateDatabase } from "../migrate"
import { projectAccess, role, roleGrant, serviceProviderAccess, userAccount } from "../schema/access"
import { agreement, subscription } from "../schema/agreements"
import { containerType, product, serviceFrequency, wasteFraction } from "../schema/catalogue"
import { collectionCalendar, collectionCalendarHoliday } from "../schema/collection-calendars"
import { container, containerServicePlacement } from "../schema/containers"
import {
  customer,
  property,
  propertyGroup,
  propertyGroupMember,
  propertyParty,
  sharedCollectionPoint,
  sharedCollectionPointMember,
} from "../schema/customers"
import { priceList, priceListRow } from "../schema/finance"
import { driver, vehicle, vehicleCompartment, vehicleCompartmentFraction } from "../schema/fleet"
import { containerTypeVehicleType, vehicleType } from "../schema/fleet-types"
import { company, project, serviceProvider } from "../schema/organisation"
import { depot, unloadingStation, unloadingStationFraction, warehouse } from "../schema/places"
import { planningArea, planningAreaBoundary } from "../schema/planning-areas"
import { collectionGroup, collectionGroupContainer, collectionGroupFraction, routeScheme } from "../schema/route-schemes"
import { DEMO_IDS, seedDemo } from "../seed/demo"
import { DEMO_KINDS, demoId, type DemoKind } from "../seed/ids"
import { databaseUnderTest, freshDatabase, type FreshDatabase } from "./database"

const database = databaseUnderTest()

const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** The forty-three tables the seed writes rows into, in the order it writes them. */
const SEEDED_TABLES = [
  company,
  project,
  serviceProvider,
  role,
  userAccount,
  roleGrant,
  projectAccess,
  serviceProviderAccess,
  wasteFraction,
  containerType,
  serviceFrequency,
  product,
  customer,
  property,
  propertyParty,
  propertyGroup,
  propertyGroupMember,
  sharedCollectionPoint,
  sharedCollectionPointMember,
  agreement,
  subscription,
  container,
  containerServicePlacement,
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
  planningArea,
  planningAreaBoundary,
  collectionCalendar,
  collectionCalendarHoliday,
  routeScheme,
  collectionGroup,
  collectionGroupFraction,
  collectionGroupContainer,
  priceList,
  priceListRow,
]

/** What the Registry seed holds per table, pinned so a fixture that grows or shrinks is noticed. */
const REGISTRY_COUNTS = {
  wasteFractions: 9,
  containerTypes: 7,
  serviceFrequencies: 8,
  products: 14,
  customers: 19,
  properties: 53,
  propertyParties: 113,
  propertyGroups: 2,
  propertyGroupMembers: 9,
  sharedCollectionPoints: 2,
  sharedCollectionPointMembers: 6,
  agreements: 53,
  subscriptions: 38,
  containers: 107,
  containerServicePlacements: 56,
}

/** What the pilot's configuration holds per table (#156, the counts #143 decided), pinned beside the Registry's. */
const CONFIGURATION_COUNTS = {
  vehicleTypes: 6,
  containerTypeVehicleTypes: 15,
  depots: 1,
  warehouses: 3,
  unloadingStations: 1,
  unloadingStationFractions: 2,
  vehicles: 5,
  vehicleCompartments: 4,
  vehicleCompartmentFractions: 5,
  drivers: 4,
  planningAreas: 5,
  planningAreaBoundaries: 4,
  collectionCalendars: 5,
  collectionCalendarHolidays: 31,
  routeSchemes: 2,
  collectionGroups: 2,
  collectionGroupFractions: 1,
  collectionGroupContainers: 4,
  priceLists: 2,
  priceListRows: 10,
}

/** Every id the seed spells, wherever it sits in DEMO_IDS. */
function allIds(value: unknown): string[] {
  if (typeof value === "string") return [value]
  return Object.values(value as Record<string, unknown>).flatMap(allIds)
}

/** The grant rows the charters ask for: one per action of every system role. */
const expectedGrants = SYSTEM_ROLES.reduce((total, systemRole) => total + systemRole.grants.reduce((n, grant) => n + grant.actions.length, 0), 0)

describe("the demo seed's fixed ids", () => {
  test("every one is a UUID version 7 with the right variant, and no two are the same", () => {
    const ids = allIds(DEMO_IDS)
    for (const id of ids) assert.match(id, UUIDV7)
    assert.equal(new Set(ids).size, ids.length, "an id is used for two records")
  })

  test("the eleven roles have an id each, keyed by the domain's role keys", () => {
    assert.deepEqual(Object.keys(DEMO_IDS.roles), [...SYSTEM_ROLE_KEYS])
  })

  test("none of them is an id a database test owns on the shared local database", () => {
    // access-token-hook.test.ts commits rows under this company and cleans
    // them up; the seed must never write over its fixture.
    assert.ok(!allIds(DEMO_IDS).includes("018f7c2e-c000-7000-8000-000000000001"))
  })

  test("demoId spells the hand-written Organisation & Access ids, so the Registry's counted ids share their scheme", () => {
    assert.equal(demoId("company", 1), DEMO_IDS.company)
    assert.equal(demoId("project", 3), DEMO_IDS.projects.cairo)
    assert.equal(demoId("role", 11), DEMO_IDS.roles["integration-writer"])
    // The id #156's driver profile names as its `user_account_id` (decided in #143).
    assert.equal(demoId("user", 3), DEMO_IDS.users.mads)
    assert.equal(demoId("serviceProviderAccess", 1), DEMO_IDS.serviceProviderAccess.lars)
    assert.equal(demoId("container", 0x6b), "01a0d2a4-a280-7014-8000-00000000006b")
    assert.throws(() => demoId("container", 0), /whole number from 1/)
    // The kinds are distinct, and every Registry kind sits above the six Organisation & Access ones.
    const kinds = Object.values(DEMO_KINDS)
    assert.equal(new Set(kinds).size, kinds.length)
    const registryKind = (id: string) => Number.parseInt(id.slice(15, 18), 16)
    for (const id of allIds(DEMO_IDS.registry)) assert.ok(registryKind(id) >= DEMO_KINDS.wasteFraction, `${id} is not in a Registry kind`)
  })

  test("Planning, Resources and Finance take the kinds #143 allocated, from 0x016 in that order", () => {
    const after = Object.entries(DEMO_KINDS).filter(([, kind]) => kind > DEMO_KINDS.containerServicePlacement)
    assert.deepEqual(Object.fromEntries(after), {
      planningArea: 0x016,
      planningAreaBoundary: 0x017,
      collectionCalendar: 0x018,
      collectionCalendarHoliday: 0x019,
      routeScheme: 0x01a,
      collectionGroup: 0x01b,
      collectionGroupFraction: 0x01c,
      collectionGroupContainer: 0x01d,
      vehicleType: 0x01e,
      containerTypeVehicleType: 0x01f,
      depot: 0x020,
      warehouse: 0x021,
      unloadingStation: 0x022,
      unloadingStationFraction: 0x023,
      vehicle: 0x024,
      vehicleCompartment: 0x025,
      vehicleCompartmentFraction: 0x026,
      driver: 0x027,
      priceList: 0x028,
      priceListRow: 0x029,
    })
    assert.equal(demoId("routeScheme", 1), "01a0d2a4-a280-701a-8000-000000000001")
  })

  test("the configuration's ids are keyed by the prototype's record ids, each in its table's kind, as many as the counts", () => {
    const { planning, resources, finance } = DEMO_IDS
    assert.ok(planning.routeSchemes["scheme-central-a"] && planning.collectionGroups["scheme-osterbro-b:default"] && planning.planningAreaBoundaries["area-harbor-1"])
    assert.ok(planning.collectionCalendarHolidays["calendar-cairo-2027:2027-07-23"] && planning.collectionGroupContainers["scheme-osterbro-b:default:asset-seed-91007"])
    assert.ok(resources.vehicleTypes["rear-loader"] && resources.containerTypeVehicleTypes["glass-crane:igloo-2500"] && resources.vehicleCompartmentFractions["vehicle-wh24:1:mixed"])
    assert.ok(resources.drivers["driver-mads"] && resources.depots["depot-nordhavn"] && resources.unloadingStationFractions["station-arc:residual"])
    assert.ok(finance.priceLists["price-list-harbor-2026"] && finance.priceListRows.copenhagen["price-row-res-osterbro"] && finance.priceListRows.harbor["price-row-glass-default"])
    assert.equal(planning.planningAreaBoundaries["area-cairo-nasr"], undefined, "Cairo's area has no located container")
    const tables = { ...resources, ...planning, ...finance }
    const kinds: Record<keyof typeof tables, DemoKind> = {
      vehicleTypes: "vehicleType",
      containerTypeVehicleTypes: "containerTypeVehicleType",
      depots: "depot",
      warehouses: "warehouse",
      unloadingStations: "unloadingStation",
      unloadingStationFractions: "unloadingStationFraction",
      vehicles: "vehicle",
      vehicleCompartments: "vehicleCompartment",
      vehicleCompartmentFractions: "vehicleCompartmentFraction",
      drivers: "driver",
      planningAreas: "planningArea",
      planningAreaBoundaries: "planningAreaBoundary",
      collectionCalendars: "collectionCalendar",
      collectionCalendarHolidays: "collectionCalendarHoliday",
      routeSchemes: "routeScheme",
      collectionGroups: "collectionGroup",
      collectionGroupFractions: "collectionGroupFraction",
      collectionGroupContainers: "collectionGroupContainer",
      priceLists: "priceList",
      priceListRows: "priceListRow",
    }
    for (const [table, ids] of Object.entries(tables)) {
      const spelled = allIds(ids)
      assert.equal(spelled.length, CONFIGURATION_COUNTS[table as keyof typeof CONFIGURATION_COUNTS], `${table} spells ${spelled.length} ids`)
      for (const [ordinal, id] of spelled.entries()) assert.equal(id, demoId(kinds[table as keyof typeof tables], ordinal + 1), `${table} counts from 1 in build order`)
    }
  })

  test("the Registry ids are keyed by the prototype's record ids, its agreement numbers and its memberships", () => {
    const { registry } = DEMO_IDS
    assert.deepEqual(Object.keys(registry.wasteFractions), ["residual", "organic", "paper", "cardboard", "glass", "plastic", "metal", "mixed", "wastewater"])
    assert.deepEqual(Object.keys(registry.products.copenhagen), Object.keys(registry.products.harbor))
    assert.ok(registry.products.copenhagen["product-res-240"] !== registry.products.harbor["product-res-240"])
    assert.deepEqual(Object.keys(registry.serviceFrequencies.harbor), ["freq-weekly", "freq-every-2-weeks", "freq-monthly", "freq-on-demand"])
    assert.ok(registry.customers["company-osterbro-housing"])
    assert.ok(registry.properties["property-parkvej-18"] && registry.properties["property-seed-101"] && registry.properties["property-seed-150"])
    assert.ok(registry.propertyGroups["group-osterbro-east"] && registry.sharedCollectionPoints["shared-point-17"])
    assert.ok(registry.propertyGroupMembers["group-osterbro-east:property-parkvej-18"])
    assert.ok(registry.propertyParties["property-parkvej-18:contact-mikkel:service-contact"])
    assert.ok(registry.agreements["AGR-2408"] && registry.agreements["AGR-2600"] && registry.agreements["AGR-2649"])
    assert.ok(registry.subscriptions["AGR-2512:product-card-660:property-dock-4"])
    assert.ok(registry.containers["asset-82014"] && registry.containers["asset-seed-91001"] && registry.containers["asset-seed-91100"])
    // A placement is keyed by the container placed, and BIN-82014 has none: no fixture product collects organic.
    assert.ok(registry.containerServicePlacements["asset-77104"])
    assert.equal(registry.containerServicePlacements["asset-82014"], undefined)
    for (const [table, expected] of Object.entries(REGISTRY_COUNTS)) {
      const ids = registry[table as keyof typeof registry]
      const spelled = "copenhagen" in ids ? Object.values(ids).flatMap((byProject) => Object.values(byProject)) : Object.values(ids)
      assert.equal(spelled.length, expected, `${table} spells ${spelled.length} ids`)
    }
  })
})

describe("the demo seed against a fresh database", { skip: database.skip }, () => {
  let fresh: FreshDatabase
  let owner: Database

  before(async () => {
    fresh = await freshDatabase(database.adminUrl, "waste_seed")
    await migrateDatabase(fresh.url)
    owner = createDb(fresh.url, { max: 2 })
  })
  after(async () => {
    await owner?.close()
    await fresh?.drop()
  })

  /** Every seeded row of every seeded table, ordered, with the timestamps: two snapshots are equal only if nothing was written. */
  const snapshot = async () => {
    const rows = await Promise.all(
      SEEDED_TABLES.map((table) =>
        owner.db
          .select()
          .from(table)
          .orderBy(sql`id`),
      ),
    )
    return JSON.stringify(rows)
  }

  /** What the grant set is, as one string: the checksum the seed must reproduce exactly. */
  const grantChecksum = async () => {
    const [row] = await owner.sql<{ checksum: string; count: number }[]>`
      select md5(string_agg(r.key || ':' || g.module_key || ':' || g.action, ',' order by r.key, g.module_key, g.action)) as checksum,
             count(*)::int as count
      from wms.role_grant g join wms.role r on r.id = g.role_id and r.company_id = g.company_id
      where g.company_id = ${DEMO_IDS.company}`
    return row
  }

  /** Which projects an account reaches: all of the company's when `all_projects`, otherwise exactly its project_access rows. */
  const reaches = async (accountId: string): Promise<string[]> => {
    const [account] = await owner.db.select().from(userAccount).where(eq(userAccount.id, accountId))
    const rows = account.allProjects
      ? await owner.db.select({ id: project.id }).from(project)
      : await owner.db.select({ id: projectAccess.projectId }).from(projectAccess).where(eq(projectAccess.userAccountId, accountId))
    return rows.map((row) => row.id).sort()
  }

  test("a clean database becomes Kystbyen Renovation: three projects, two service providers, eleven roles with their grants, three accounts", async () => {
    const report = await seedDemo(fresh.url)
    assert.equal(report.companyId, DEMO_IDS.company)
    assert.ok(report.changed > 0)
    assert.deepEqual(report.counts, {
      projects: 3,
      serviceProviders: 2,
      roles: 11,
      roleGrants: expectedGrants,
      users: 3,
      projectAccess: 1,
      serviceProviderAccess: 1,
      ...REGISTRY_COUNTS,
      ...CONFIGURATION_COUNTS,
    })

    const [seeded] = await owner.db.select().from(company)
    assert.deepEqual(
      { ...seeded, createdAt: undefined, updatedAt: undefined },
      {
        id: DEMO_IDS.company,
        companyId: DEMO_IDS.company,
        name: "Kystbyen Renovation",
        legalName: "Kystbyen Renovation A/S",
        registrationNumber: "12345678",
        country: "DK",
        status: "active",
        // The route-number counter (Issue #104), the ticket-number counter (Issue #109) and the invoice-number counter (Issue #112): the seed writes no route, no ticket and no invoice, so all three keep their default.
        nextRouteNumber: 1000,
        nextTicketNumber: 1000,
        nextInvoiceNumber: 1000,
        createdAt: undefined,
        updatedAt: undefined,
      },
    )

    // With their working weeks (Issue #97): Cairo rests Friday–Saturday, Harbor has no holiday list and rests on its weekend only.
    const projects = await owner.db.select().from(project).orderBy(project.name)
    assert.deepEqual(
      projects.map((row) => [row.id, row.name, row.kind, row.language, row.currency, row.timezone, row.status, row.weekend, row.holidayList]),
      [
        [DEMO_IDS.projects.cairo, "Cairo Operations", "Municipality", "ar", "EGP", "Africa/Cairo", "active", ["friday", "saturday"], "Egyptian public holidays"],
        [DEMO_IDS.projects.copenhagen, "Copenhagen Central", "Municipality", "da", "DKK", "Europe/Copenhagen", "active", ["saturday", "sunday"], "Danish public holidays"],
        [DEMO_IDS.projects.harbor, "Harbor Commercial", "Business unit", "da", "DKK", "Europe/Copenhagen", "onboarding", ["saturday", "sunday"], null],
      ],
    )

    const providers = await owner.db.select().from(serviceProvider).orderBy(serviceProvider.legalName)
    assert.deepEqual(
      providers.map((row) => [row.id, row.legalName, row.registrationNumber, row.country, row.contactName, row.contactEmail]),
      [
        [DEMO_IDS.serviceProviders.cityhaul, "CityHaul A/S", "39122004", "DK", "Mikkel Andersen", "mikkel.andersen@cityhaul.dk"],
        [DEMO_IDS.serviceProviders.nordren, "NordRen ApS", "40291188", "DK", "Lars Mikkelsen", "lars.mikkelsen@nordren.dk"],
      ],
    )

    const roles = await owner.db.select().from(role).orderBy(role.name)
    assert.deepEqual(
      roles.map((row) => [row.key, row.name, row.scope, row.description, row.system]),
      SYSTEM_ROLES.map((systemRole) => [systemRole.key, systemRole.name, systemRole.scope, systemRole.description, true]).sort((a, b) =>
        (a[1] as string) < (b[1] as string) ? -1 : 1,
      ),
    )

    const grants = await grantChecksum()
    assert.equal(grants.count, expectedGrants)

    // Reserved addresses, each an Invitation: no Login is bound and none is deactivated.
    const accounts = await owner.db.select().from(userAccount).orderBy(userAccount.id)
    assert.deepEqual(
      accounts.map((row) => [row.id, row.email, row.fullName, row.allProjects, row.primaryAdministrator, row.serviceProviderId, row.authUserId, row.deactivatedAt]),
      [
        [DEMO_IDS.users.fares, "fares.abdelghany@kystbyen.example", "Fares Abdelghany", true, true, null, null, null],
        [DEMO_IDS.users.lars, "lars.mikkelsen@nordren.example", "Lars Mikkelsen", false, false, DEMO_IDS.serviceProviders.nordren, null, null],
        [DEMO_IDS.users.mads, "mads.jensen@kystbyen.example", "Mads Jensen", false, false, null, null, null],
      ],
    )
  })

  test("Fares works in every project and for no service provider; Lars works for NordRen and in no project; Mads works in Copenhagen Central alone, on the Driver role", async () => {
    const [fares] = await owner.db.select().from(userAccount).where(eq(userAccount.id, DEMO_IDS.users.fares))
    const [lars] = await owner.db.select().from(userAccount).where(eq(userAccount.id, DEMO_IDS.users.lars))
    const [mads] = await owner.db.select().from(userAccount).where(eq(userAccount.id, DEMO_IDS.users.mads))
    const roles = await owner.db.select().from(role)
    const key = (id: string) => roles.find((row) => row.id === id)?.key

    assert.equal(key(fares.roleId), "company-administrator")
    assert.deepEqual(await reaches(fares.id), Object.values(DEMO_IDS.projects).sort())
    assert.equal(fares.serviceProviderId, null)
    assert.equal(fares.primaryAdministrator, true)

    assert.equal(key(lars.roleId), "service-provider-manager")
    assert.deepEqual(await reaches(lars.id), [])
    assert.equal(lars.serviceProviderId, DEMO_IDS.serviceProviders.nordren)

    assert.equal(key(mads.roleId), "driver")
    assert.deepEqual(await reaches(mads.id), [DEMO_IDS.projects.copenhagen])
    assert.equal(mads.serviceProviderId, null)
    assert.equal(mads.primaryAdministrator, false)
    const providerAccess = await owner.db.select().from(serviceProviderAccess)
    assert.deepEqual(
      providerAccess.map((row) => [row.userAccountId, row.serviceProviderId]),
      [[DEMO_IDS.users.lars, DEMO_IDS.serviceProviders.nordren]],
    )
  })

  test("the Registry: the catalogue, the customers with their properties, groups and points, the agreements with their subscriptions, and the containers with their placements", async () => {
    const { registry } = DEMO_IDS
    const [own] = await owner.sql<{ count: number }[]>`select count(*)::int as count from wms.customer where company_id <> ${DEMO_IDS.company}`
    assert.equal(own.count, 0, "a fresh database holds no other company's rows")

    // Every table holds exactly what the report counts, and every row is the demo company's.
    const tables = {
      wasteFractions: wasteFraction,
      containerTypes: containerType,
      serviceFrequencies: serviceFrequency,
      products: product,
      customers: customer,
      properties: property,
      propertyParties: propertyParty,
      propertyGroups: propertyGroup,
      propertyGroupMembers: propertyGroupMember,
      sharedCollectionPoints: sharedCollectionPoint,
      sharedCollectionPointMembers: sharedCollectionPointMember,
      agreements: agreement,
      subscriptions: subscription,
      containers: container,
      containerServicePlacements: containerServicePlacement,
    }
    for (const [name, table] of Object.entries(tables)) {
      const [row] = await owner.db
        .select({ count: sql<number>`count(*)::int`, companies: sql<number>`count(distinct company_id)::int` })
        .from(table)
      assert.equal(row.count, REGISTRY_COUNTS[name as keyof typeof REGISTRY_COUNTS], `${name} holds ${row.count} rows`)
      assert.equal(row.companies, 1, `${name} holds another company's rows`)
    }

    // The catalogue: the fraction keys are slugs, the types carry their volume, a cadence has the domain's shape, a product names all three.
    const fractions = await owner.db.select().from(wasteFraction).orderBy(wasteFraction.id)
    assert.deepEqual(
      fractions.map((row) => [row.key, row.name]),
      [
        ["residual", "Residual"],
        ["organic", "Organic"],
        ["paper", "Paper"],
        ["cardboard", "Cardboard"],
        ["glass", "Glass"],
        ["plastic", "Plastic"],
        ["metal", "Metal"],
        ["mixed", "Mixed"],
        ["wastewater", "Wastewater"],
      ],
    )
    const [underground] = await owner.db.select().from(containerType).where(eq(containerType.id, registry.containerTypes["underground-5000"]))
    assert.deepEqual([underground.name, underground.volumeLitres], ["Underground · 5,000 L", 5000])
    const [fortnightly] = await owner.db.select().from(serviceFrequency).where(eq(serviceFrequency.id, registry.serviceFrequencies.copenhagen["freq-every-2-weeks"]))
    assert.deepEqual(
      [fortnightly.projectId, fortnightly.name, fortnightly.collectionsPerWeek, fortnightly.weeksBetween, fortnightly.daysBetween],
      [DEMO_IDS.projects.copenhagen, "Every 2 weeks", 1, 2, null],
    )
    const [residual240] = await owner.db.select().from(product).where(eq(product.id, registry.products.copenhagen["product-res-240"]))
    assert.deepEqual(
      [residual240.projectId, residual240.name, residual240.kind, residual240.status, residual240.unit, residual240.containerTypeId, residual240.wasteFractionId, residual240.serviceFrequencyId],
      [
        DEMO_IDS.projects.copenhagen,
        "Residual waste · 240L bin",
        "container-collection",
        "active",
        "pickup",
        registry.containerTypes["two-wheel-240"],
        registry.wasteFractions.residual,
        registry.serviceFrequencies.copenhagen["freq-every-2-weeks"],
      ],
    )

    // Customers and properties: a CVR stored as the number, a property located where the map places it, a private owner as a person of its own.
    const [osterbro] = await owner.db.select().from(customer).where(eq(customer.id, registry.customers["company-osterbro-housing"]))
    assert.deepEqual([osterbro.kind, osterbro.name, osterbro.registrationNumber, osterbro.email, osterbro.status], ["organisation", "Østerbro Housing", "38112009", "service@osterbro-housing.example", "active"])
    const [parkvej] = await owner.db.select().from(property).where(eq(property.id, registry.properties["property-parkvej-18"]))
    assert.deepEqual(
      [parkvej.projectId, parkvej.name, parkvej.address, parkvej.registryId, parkvej.kind, parkvej.status, parkvej.location],
      [DEMO_IDS.projects.copenhagen, "Parkvej 18", "Parkvej 18, 2100 København Ø", "CPH-001882", "residential", "active", { type: "Point", coordinates: [12.576848, 55.703119] }],
    )
    const [ryesgade] = await owner.db.select().from(property).where(eq(property.id, registry.properties["property-seed-101"]))
    assert.deepEqual([ryesgade.name, ryesgade.address, ryesgade.registryId, ryesgade.location], ["Ryesgade 3", "Ryesgade 3, 2200 København N", "CPH-91000", { type: "Point", coordinates: [12.560646, 55.69076] }])
    const [dock] = await owner.db.select().from(property).where(eq(property.id, registry.properties["property-dock-4"]))
    assert.deepEqual([dock.projectId, dock.status, dock.location], [DEMO_IDS.projects.harbor, "inactive", { type: "Point", coordinates: [12.598507, 55.708973] }])
    const [{ located }] = await owner.sql<{ located: number }[]>`select count(location)::int as located from wms.property`
    assert.equal(located, REGISTRY_COUNTS.properties, "every fixture street is in the gazetteer, so every property is located")
    const parties = await owner.db.select().from(propertyParty).where(eq(propertyParty.propertyId, registry.properties["property-sundbyvej-91"]))
    assert.deepEqual(
      parties.map((row) => [row.customerId, row.role]).sort(),
      [
        [registry.customers["customer-amager-district"], "payer"],
        [registry.customers["owner-property-sundbyvej-91"], "owner"],
      ].sort(),
    )
    const [privateOwner] = await owner.db.select().from(customer).where(eq(customer.id, registry.customers["owner-property-sundbyvej-91"]))
    assert.deepEqual([privateOwner.kind, privateOwner.name], ["person", "Private owner · Sundbyvej 91"])
    // Its record names no type; the one fixture fact that does is BIN-44831's "Property type: Commercial".
    const [sundbyvej] = await owner.db.select().from(property).where(eq(property.id, registry.properties["property-sundbyvej-91"]))
    assert.deepEqual([sundbyvej.kind, sundbyvej.status, sundbyvej.registryId], ["commercial", "active", "CPH-009114"])

    // Containment (routes/periods.ts's rule, held here by construction): no subscription runs outside its agreement, no placement outside its subscription.
    const [strays] = await owner.sql<{ subscriptions: number; placements: number; ends: number }[]>`
      select
        (select count(*)::int from wms.subscription s join wms.agreement a on a.id = s.agreement_id and a.company_id = s.company_id
          where s.valid_from < a.valid_from or (a.valid_to is not null and (s.valid_to is null or s.valid_to > a.valid_to))) as subscriptions,
        (select count(*)::int from wms.container_service_placement p join wms.subscription s on s.id = p.subscription_id and s.company_id = p.company_id
          where p.valid_from < s.valid_from or (s.valid_to is not null and (p.valid_to is null or p.valid_to > s.valid_to))) as placements,
        (select count(*)::int from wms.container_service_placement p join wms.subscription s on s.id = p.subscription_id and s.company_id = p.company_id
          where p.valid_to is distinct from s.valid_to) as ends`
    assert.deepEqual(strays, { subscriptions: 0, placements: 0, ends: 0 })

    // Groups and points: the Østerbro East members are the Copenhagen properties Østerbro Housing owns; Kongens Nytorv is a located point with no member.
    const east = await owner.db.select().from(propertyGroupMember).where(eq(propertyGroupMember.propertyGroupId, registry.propertyGroups["group-osterbro-east"]))
    assert.equal(east.length, 7)
    assert.ok(east.some((row) => row.propertyId === registry.properties["property-parkvej-18"]))
    const [nytorv] = await owner.db.select().from(sharedCollectionPoint).where(eq(sharedCollectionPoint.id, registry.sharedCollectionPoints["shared-point-17"]))
    assert.deepEqual(
      [nytorv.kind, nytorv.operatingModel, nytorv.accessMode, nytorv.billingMode, nytorv.status, nytorv.eligibilityDistanceM, nytorv.location],
      ["underground", "municipal", "open", "municipal", "open", 350, { type: "Point", coordinates: [12.5855, 55.6805] }],
    )
    const dockMembers = await owner.db
      .select()
      .from(sharedCollectionPointMember)
      .where(eq(sharedCollectionPointMember.sharedCollectionPointId, registry.sharedCollectionPoints["shared-point-23"]))
    assert.equal(dockMembers.length, 6)

    // Agreements: the fixture's "1 Jan–31 Dec 2026" as a half-open period, a draft from the month its container's collection starts.
    const [agr2408] = await owner.db.select().from(agreement).where(eq(agreement.id, registry.agreements["AGR-2408"]))
    assert.deepEqual(
      [agr2408.number, agr2408.customerId, agr2408.payerCustomerId, agr2408.status, agr2408.billingCadence, agr2408.currency, agr2408.validFrom, agr2408.validTo],
      ["AGR-2408", registry.customers["company-osterbro-housing"], registry.customers["company-osterbro-housing"], "active", "monthly", "DKK", "2026-01-01", "2027-01-01"],
    )
    const [agr2512] = await owner.db.select().from(agreement).where(eq(agreement.id, registry.agreements["AGR-2512"]))
    assert.deepEqual([agr2512.status, agr2512.validFrom, agr2512.validTo], ["draft", "2026-09-01", null])

    // Containers and placements: BIN-77104 stands at Dock 4 under AGR-2512 with its own weekly cadence, where the product has none; BIN-82014 stands nowhere.
    const [bin77104] = await owner.db.select().from(container).where(eq(container.id, registry.containers["asset-77104"]))
    assert.deepEqual([bin77104.projectId, bin77104.label, bin77104.containerTypeId, bin77104.barcode, bin77104.rfid, bin77104.serialNumber, bin77104.ownership], [
      DEMO_IDS.projects.harbor,
      "BIN-77104",
      registry.containerTypes["four-wheel-1100"],
      "WH77104",
      "E20077104",
      "SULO-26-77104",
      "company",
    ])
    const [placed] = await owner.db
      .select({
        validFrom: containerServicePlacement.validFrom,
        validTo: containerServicePlacement.validTo,
        fraction: containerServicePlacement.wasteFractionId,
        effective: sql<string>`coalesce(${containerServicePlacement.serviceFrequencyId}, ${product.serviceFrequencyId})`,
        agreementId: subscription.agreementId,
        propertyId: subscription.propertyId,
        quantity: subscription.quantity,
      })
      .from(containerServicePlacement)
      .innerJoin(subscription, and(eq(subscription.id, containerServicePlacement.subscriptionId), eq(subscription.companyId, containerServicePlacement.companyId)))
      .innerJoin(product, and(eq(product.id, subscription.productId), eq(product.companyId, subscription.companyId)))
      .where(eq(containerServicePlacement.containerId, registry.containers["asset-77104"]))
    assert.deepEqual(placed, {
      validFrom: "2026-09-01",
      validTo: null,
      fraction: registry.wasteFractions.cardboard,
      effective: registry.serviceFrequencies.harbor["freq-weekly"],
      agreementId: registry.agreements["AGR-2512"],
      propertyId: registry.properties["property-dock-4"],
      quantity: 1,
    })
    const unplaced = await owner.db.select().from(containerServicePlacement).where(eq(containerServicePlacement.containerId, registry.containers["asset-82014"]))
    assert.deepEqual(unplaced, [])
    // A residual container whose cadence is the product's carries no override; a Future one starts later; two of one product at one property are one subscription of two.
    const [inherits] = await owner.db.select().from(containerServicePlacement).where(eq(containerServicePlacement.containerId, registry.containers["asset-seed-91001"]))
    assert.deepEqual([inherits.validFrom, inherits.serviceFrequencyId, inherits.wasteFractionId], ["2026-01-01", null, registry.wasteFractions.residual])
    const [future] = await owner.db.select().from(containerServicePlacement).where(eq(containerServicePlacement.containerId, registry.containers["asset-seed-91029"]))
    assert.equal(future.validFrom, "2026-10-01")
    const [pair] = await owner.db.select().from(subscription).where(eq(subscription.id, registry.subscriptions["AGR-2600:product-res-240:property-seed-101"]))
    assert.deepEqual([pair.quantity, pair.propertyId, pair.sharedCollectionPointId, pair.locationId], [2, registry.properties["property-seed-101"], null, registry.properties["property-seed-101"]])
  })

  test("a second run writes nothing: not a row, not an updated_at", async () => {
    const before = await snapshot()
    const checksum = await grantChecksum()
    const report = await seedDemo(fresh.url)
    assert.equal(report.changed, 0)
    assert.equal(await snapshot(), before)
    assert.deepEqual(await grantChecksum(), checksum)
  })

  test("what someone edited by hand goes back to what the seed says: a grant the charter does not name is removed, and so is a seeded account's access the seed does not name", async () => {
    const settled = await snapshot()
    await owner.db.update(company).set({ name: "Kystbyen Sverige" }).where(eq(company.id, DEMO_IDS.company))
    // A camelCase column too: `set` is keyed by the property name and the
    // column is `contact_email` in the database, which is what `propertyOf`
    // is for — an edit here that did not come back would mean the seed had
    // been setting a column nobody reads.
    await owner.db
      .update(serviceProvider)
      .set({ contactEmail: "nobody@example.invalid" })
      .where(eq(serviceProvider.id, DEMO_IDS.serviceProviders.nordren))
    // An array column and a nullable one too: the compare-before-write is `is
    // distinct from` over the whole row, which has to see a moved weekend and
    // a dropped list the way it sees a renamed company.
    await owner.db.update(project).set({ weekend: ["sunday"], holidayList: null }).where(eq(project.id, DEMO_IDS.projects.cairo))
    await owner.db.delete(roleGrant).where(eq(roleGrant.roleId, DEMO_IDS.roles.driver))
    await owner.db.insert(roleGrant).values({
      companyId: DEMO_IDS.company,
      roleId: DEMO_IDS.roles.driver,
      moduleKey: "commercial.invoices",
      action: "delete",
    })
    // Two accounts moved the way the API moves one — the access rows go, the
    // account's own columns change, the new rows arrive: Mads to Harbor, and
    // Lars to CityHaul, whose access row then names the account as it now is.
    await owner.db.delete(projectAccess).where(eq(projectAccess.userAccountId, DEMO_IDS.users.mads))
    await owner.db.insert(projectAccess).values({ companyId: DEMO_IDS.company, userAccountId: DEMO_IDS.users.mads, projectId: DEMO_IDS.projects.harbor })
    await owner.db.delete(serviceProviderAccess).where(eq(serviceProviderAccess.userAccountId, DEMO_IDS.users.lars))
    await owner.db.update(userAccount).set({ serviceProviderId: DEMO_IDS.serviceProviders.cityhaul }).where(eq(userAccount.id, DEMO_IDS.users.lars))
    await owner.db.insert(serviceProviderAccess).values({ companyId: DEMO_IDS.company, userAccountId: DEMO_IDS.users.lars, serviceProviderId: DEMO_IDS.serviceProviders.cityhaul })
    // Registry rows too, a geometry among them: the point takes part in the
    // row comparison through PostGIS's `=`, so a moved point is put back and
    // an unmoved one is not rewritten.
    const parkvejId = DEMO_IDS.registry.properties["property-parkvej-18"]
    await owner.db
      .update(property)
      .set({ name: "Parkvej 18A", location: { type: "Point", coordinates: [12.5, 55.7] } })
      .where(eq(property.id, parkvejId))
    await owner.db.update(container).set({ label: "BIN-00000", ownership: "unrecorded" }).where(eq(container.id, DEMO_IDS.registry.containers["asset-82014"]))
    await owner.db.update(agreement).set({ validTo: "2026-06-01" }).where(eq(agreement.id, DEMO_IDS.registry.agreements["AGR-2408"]))

    const report = await seedDemo(fresh.url)
    assert.ok(report.changed > 0)
    const [restored] = await owner.db.select().from(company)
    assert.equal(restored.name, "Kystbyen Renovation")
    const [nordren] = await owner.db.select().from(serviceProvider).where(eq(serviceProvider.id, DEMO_IDS.serviceProviders.nordren))
    assert.equal(nordren.contactEmail, "lars.mikkelsen@nordren.dk")
    const [parkvej] = await owner.db.select().from(property).where(eq(property.id, parkvejId))
    assert.deepEqual([parkvej.name, parkvej.location], ["Parkvej 18", { type: "Point", coordinates: [12.576848, 55.703119] }])
    const [bin82014] = await owner.db.select().from(container).where(eq(container.id, DEMO_IDS.registry.containers["asset-82014"]))
    assert.deepEqual([bin82014.label, bin82014.ownership], ["BIN-82014", "company"])
    const [agr2408] = await owner.db.select().from(agreement).where(eq(agreement.id, DEMO_IDS.registry.agreements["AGR-2408"]))
    assert.equal(agr2408.validTo, "2027-01-01")
    const [cairo] = await owner.db.select().from(project).where(eq(project.id, DEMO_IDS.projects.cairo))
    assert.deepEqual([cairo.weekend, cairo.holidayList], [["friday", "saturday"], "Egyptian public holidays"])
    const driverGrants = await owner.db.select().from(roleGrant).where(eq(roleGrant.roleId, DEMO_IDS.roles.driver))
    assert.deepEqual(
      driverGrants.map((row) => `${row.moduleKey}:${row.action}`).sort(),
      ["operate.driver-app:edit", "operate.driver-app:view", "route-studio.pickups:edit", "route-studio.pickups:view", "route-studio.routes:view"],
    )
    const [lars] = await owner.db.select().from(userAccount).where(eq(userAccount.id, DEMO_IDS.users.lars))
    assert.equal(lars.serviceProviderId, DEMO_IDS.serviceProviders.nordren)
    const providerAccess = await owner.db.select().from(serviceProviderAccess)
    assert.deepEqual(
      providerAccess.map((row) => [row.id, row.userAccountId, row.serviceProviderId]),
      [[DEMO_IDS.serviceProviderAccess.lars, DEMO_IDS.users.lars, DEMO_IDS.serviceProviders.nordren]],
    )
    assert.deepEqual(await reaches(DEMO_IDS.users.mads), [DEMO_IDS.projects.copenhagen])
    // The grant rows were rewritten, so only the rows that were touched differ.
    assert.notEqual(await snapshot(), settled)
    assert.equal((await grantChecksum()).count, expectedGrants)
    assert.equal((await seedDemo(fresh.url)).changed, 0)
  })

  test("an access row is the pair it joins: one the API wrote back under another id is left as it is, and nothing is written", async () => {
    // What the API does whenever an account's access is edited: the rows go, and come back under new ids.
    await owner.db.delete(projectAccess).where(eq(projectAccess.userAccountId, DEMO_IDS.users.mads))
    await owner.db.delete(serviceProviderAccess).where(eq(serviceProviderAccess.userAccountId, DEMO_IDS.users.lars))
    const [madsAccess] = await owner.db
      .insert(projectAccess)
      .values({ companyId: DEMO_IDS.company, userAccountId: DEMO_IDS.users.mads, projectId: DEMO_IDS.projects.copenhagen })
      .returning({ id: projectAccess.id })
    const [larsAccess] = await owner.db
      .insert(serviceProviderAccess)
      .values({ companyId: DEMO_IDS.company, userAccountId: DEMO_IDS.users.lars, serviceProviderId: DEMO_IDS.serviceProviders.nordren })
      .returning({ id: serviceProviderAccess.id })
    const settled = await snapshot()

    assert.equal((await seedDemo(fresh.url)).changed, 0)
    assert.equal(await snapshot(), settled)
    const projectRows = await owner.db.select().from(projectAccess).where(eq(projectAccess.userAccountId, DEMO_IDS.users.mads))
    assert.deepEqual(
      projectRows.map((row) => [row.id, row.projectId]),
      [[madsAccess.id, DEMO_IDS.projects.copenhagen]],
    )
    const providerRows = await owner.db.select().from(serviceProviderAccess).where(eq(serviceProviderAccess.userAccountId, DEMO_IDS.users.lars))
    assert.deepEqual(
      providerRows.map((row) => [row.id, row.serviceProviderId]),
      [[larsAccess.id, DEMO_IDS.serviceProviders.nordren]],
    )
  })

  test("a re-run over the Pilot's accounts moves the two addresses in place, keeps both Logins bound and adds Mads as an Invitation; the run after writes nothing", async () => {
    // The Pilot before #140: Fares and Lars bound to their Logins at the addresses they were invited at, and no Mads — so no driver profile naming him (#156), which is unlinked here.
    const logins = { fares: randomUUID(), lars: randomUUID() }
    await owner.db.update(driver).set({ userAccountId: null }).where(eq(driver.id, DEMO_IDS.resources.drivers["driver-mads"]))
    await owner.db.delete(projectAccess).where(eq(projectAccess.userAccountId, DEMO_IDS.users.mads))
    await owner.db.delete(userAccount).where(eq(userAccount.id, DEMO_IDS.users.mads))
    await owner.db.update(userAccount).set({ email: "fares@earlier-address.example", authUserId: logins.fares }).where(eq(userAccount.id, DEMO_IDS.users.fares))
    await owner.db.update(userAccount).set({ email: "lars@earlier-address.example", authUserId: logins.lars }).where(eq(userAccount.id, DEMO_IDS.users.lars))

    // Two addresses moved, one account and its Project Access added, his driver profile linked to it again: five rows, and nothing else.
    assert.equal((await seedDemo(fresh.url)).changed, 5)
    const accounts = await owner.db.select().from(userAccount).orderBy(userAccount.id)
    assert.deepEqual(
      accounts.map((row) => [row.id, row.email, row.authUserId, row.deactivatedAt]),
      [
        [DEMO_IDS.users.fares, "fares.abdelghany@kystbyen.example", logins.fares, null],
        [DEMO_IDS.users.lars, "lars.mikkelsen@nordren.example", logins.lars, null],
        [DEMO_IDS.users.mads, "mads.jensen@kystbyen.example", null, null],
      ],
    )
    assert.deepEqual(await reaches(DEMO_IDS.users.mads), [DEMO_IDS.projects.copenhagen])

    const settled = await snapshot()
    assert.equal((await seedDemo(fresh.url)).changed, 0)
    assert.equal(await snapshot(), settled)
  })
})
