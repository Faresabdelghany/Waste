// What the route-scheme and collection-group suites need of Planning beyond
// their own routes (Issue #97, slice 4): a planning area per project, each
// project's working week and holiday list, and a collection calendar with the
// holidays the occurrence read is proved against. The rows are written
// directly through `tx` as `wms_api` inside `withCompany`, the way tenant.ts
// seeds its company — the suites prove the scheme routes, not the area and
// calendar ones — and `dropTenant` drops them with the rest of the company.
//
// The three projects say three different things about a working week:
// Copenhagen Central rests Saturday–Sunday on the Danish list, Harbor
// Commercial has calendar rows but no list, so its holidays are read by
// nobody, and Cairo Operations rests Friday–Saturday on the Egyptian list, so
// a Thursday holiday shifts to Sunday there.
//
// `seedFleet` is the same for Resources (Issue #101, slice 6): the depot, the
// unloading station, the vehicles and the drivers the allocation suite and
// Planning's fleet-field suite name, written through `tx` since the fleet's
// own routes are slices 3 and 4, and dropped with the rest of the company —
// `dropTenant` deletes them after the groups and schemes that name them, and
// the allocation events as the owner. The fleet says one thing per driver
// about the licence rule: Mads holds CE until 2030 and may take anything,
// Jonas has no class on record and may take nothing, Freja holds B and may not
// take a C truck, and Sofie holds C but it ran out on 2026-09-05. The status
// rule (#79, review round B) has its own rows: a retired truck and a retired
// trailer nothing new may name, Karen and Peter who hold CE and are inactive
// and suspended, and WH-77, an active truck a suite takes out of service
// itself to prove that a reference already made stands.
import type { Database, Tx } from "@waste/db/client"
import { collectionCalendar, collectionCalendarHoliday } from "@waste/db/schema/collection-calendars"
import { driver, vehicle } from "@waste/db/schema/fleet"
import { vehicleType } from "@waste/db/schema/fleet-types"
import { project } from "@waste/db/schema/organisation"
import { depot, unloadingStation } from "@waste/db/schema/places"
import { planningArea } from "@waste/db/schema/planning-areas"
import { withCompany } from "@waste/db/tenant"
import { and, eq } from "drizzle-orm"

import { testId, type Tenant } from "./tenant"

export type PlanningFixtures = {
  /** One planning area per project the suites plan in. */
  areas: { centrum: { id: string }; harbor: { id: string }; cairo: { id: string } }
  /** Two vehicle types of the company, which a rule asks for by id since Resources (Issue #101); their routes are #101's slice 3. */
  vehicleTypes: { rearLoader: { id: string }; glassCrane: { id: string } }
}

/** The Danish holidays of the Copenhagen calendar: two named by the list's lookup, one by the calendar itself. */
export const COPENHAGEN_HOLIDAYS = {
  /** A Friday; the lookup calls it Constitution Day. */
  constitutionDay: "2026-06-05",
  /** A Thursday; unnamed on the calendar, so the lookup names it Christmas Eve. */
  christmasEve: "2026-12-24",
  /** A Friday; the calendar names it, and its name wins over the lookup's. */
  christmasDay: "2026-12-25",
  /** A Thursday; unnamed, so the lookup names it New Year's Eve. */
  newYearsEve: "2026-12-31",
} as const

/** The Cairo calendar: a Thursday the company itself named, and a Tuesday the Egyptian lookup names. */
export const CAIRO_HOLIDAYS = {
  /** A Thursday; Cairo rests Friday–Saturday, so shift-next lands on the Sunday. */
  companyHoliday: "2026-10-01",
  /** A Tuesday; the lookup calls it Armed Forces Day. */
  armedForcesDay: "2026-10-06",
} as const

export async function seedPlanning(pool: Database, tenant: Tenant): Promise<PlanningFixtures> {
  const { companyId } = tenant
  const fixtures: PlanningFixtures = {
    areas: { centrum: { id: testId() }, harbor: { id: testId() }, cairo: { id: testId() } },
    vehicleTypes: { rearLoader: { id: testId() }, glassCrane: { id: testId() } },
  }
  const copenhagen = tenant.projects.copenhagen.id
  const harbor = tenant.projects.harbor.id
  const cairo = tenant.projects.cairo.id
  const calendars = { copenhagen: testId(), harbor: testId(), cairo: testId() }

  await withCompany(pool.db, companyId, async (tx: Tx) => {
    await tx.update(project).set({ holidayList: "Danish public holidays" }).where(and(eq(project.companyId, companyId), eq(project.id, copenhagen)))
    await tx
      .update(project)
      .set({ holidayList: "Egyptian public holidays", weekend: ["friday", "saturday"] })
      .where(and(eq(project.companyId, companyId), eq(project.id, cairo)))
    await tx.insert(vehicleType).values([
      { id: fixtures.vehicleTypes.rearLoader.id, companyId, key: "rear-loader", name: "Rear loader" },
      { id: fixtures.vehicleTypes.glassCrane.id, companyId, key: "glass-crane", name: "Glass crane" },
    ])
    await tx.insert(planningArea).values([
      { id: fixtures.areas.centrum.id, companyId, projectId: copenhagen, code: "OP-CEN-01", name: "Centrum", purpose: "route-planning" },
      { id: fixtures.areas.harbor.id, companyId, projectId: harbor, code: "HB-01", name: "Havnen", purpose: "route-planning" },
      { id: fixtures.areas.cairo.id, companyId, projectId: cairo, code: "CAI-01", name: "Maadi", purpose: "route-planning" },
    ])
    await tx.insert(collectionCalendar).values([
      { id: calendars.copenhagen, companyId, projectId: copenhagen, name: "Copenhagen Central 2026", validFrom: "2026-01-01", validTo: "2027-01-01" },
      { id: calendars.harbor, companyId, projectId: harbor, name: "Harbor Commercial 2026", validFrom: "2026-01-01", validTo: "2027-01-01" },
      { id: calendars.cairo, companyId, projectId: cairo, name: "Cairo Operations 2026", validFrom: "2026-01-01", validTo: "2027-01-01" },
    ])
    await tx.insert(collectionCalendarHoliday).values([
      { id: testId(), companyId, projectId: copenhagen, collectionCalendarId: calendars.copenhagen, day: COPENHAGEN_HOLIDAYS.constitutionDay, name: null },
      { id: testId(), companyId, projectId: copenhagen, collectionCalendarId: calendars.copenhagen, day: COPENHAGEN_HOLIDAYS.christmasEve, name: null },
      { id: testId(), companyId, projectId: copenhagen, collectionCalendarId: calendars.copenhagen, day: COPENHAGEN_HOLIDAYS.christmasDay, name: "Juledag" },
      { id: testId(), companyId, projectId: copenhagen, collectionCalendarId: calendars.copenhagen, day: COPENHAGEN_HOLIDAYS.newYearsEve, name: null },
      // Harbor has the rows and no list: nobody reads them.
      { id: testId(), companyId, projectId: harbor, collectionCalendarId: calendars.harbor, day: COPENHAGEN_HOLIDAYS.christmasEve, name: "Juleaftensdag" },
      { id: testId(), companyId, projectId: cairo, collectionCalendarId: calendars.cairo, day: CAIRO_HOLIDAYS.companyHoliday, name: "Company holiday" },
      { id: testId(), companyId, projectId: cairo, collectionCalendarId: calendars.cairo, day: CAIRO_HOLIDAYS.armedForcesDay, name: null },
    ])
  })
  return fixtures
}

/** A vehicle as a sentence names it: the callsign the yard uses. */
export type FixtureVehicle = { id: string; label: string }
/** A driver as a sentence names them. */
export type FixtureDriver = { id: string; name: string }

export type FleetFixtures = {
  depots: {
    /** Copenhagen Central's yard. */
    nordhavn: { id: string }
    /** Harbor Commercial's, which a Copenhagen scheme or allocation may not name. */
    harbor: { id: string }
  }
  stations: {
    /** The company's plant: every project unloads here. */
    amager: { id: string }
  }
  vehicles: {
    /** A rear loader of Copenhagen Central requiring C: the truck of every happy path. */
    wh24: FixtureVehicle
    /** A second rear loader, requiring CE. */
    wh25: FixtureVehicle
    /** A trailer of Copenhagen Central. */
    trailer: FixtureVehicle
    /** A retired rear loader of Copenhagen Central. */
    retired: FixtureVehicle
    /** A retired trailer of Copenhagen Central, which a body may not name afresh either. */
    retiredTrailer: FixtureVehicle
    /** An active rear loader requiring C that a suite retires itself through `tx`, to prove a stored reference stands. */
    drifting: FixtureVehicle
    /** Harbor Commercial's rear loader, requiring B. */
    harborTruck: FixtureVehicle
  }
  drivers: {
    /** CE until 2030-12-31: may take anything. */
    mads: FixtureDriver
    /** No class on record: may take nothing. */
    jonas: FixtureDriver
    /** B, no expiry: may not take a C truck. */
    freja: FixtureDriver
    /** C, expired on 2026-09-05. */
    sofie: FixtureDriver
    /** Harbor Commercial's driver, CE. */
    henrik: FixtureDriver
    /** CE, inactive: nothing new may name her, whatever the licence says. */
    karen: FixtureDriver
    /** CE, suspended: likewise, told the other status. */
    peter: FixtureDriver
  }
}

/** The last day Sofie's licence holds. */
export const SOFIE_LICENCE_EXPIRY = "2026-09-05"

/** Copenhagen Central's fleet and places, of the vehicle type Planning's fixtures seeded. */
export async function seedFleet(pool: Database, tenant: Tenant, planning: PlanningFixtures): Promise<FleetFixtures> {
  const { companyId } = tenant
  const copenhagen = tenant.projects.copenhagen.id
  const harbor = tenant.projects.harbor.id
  const fixtures: FleetFixtures = {
    depots: { nordhavn: { id: testId() }, harbor: { id: testId() } },
    stations: { amager: { id: testId() } },
    vehicles: {
      wh24: { id: testId(), label: "WH-24" },
      wh25: { id: testId(), label: "WH-25" },
      trailer: { id: testId(), label: "WH-T12" },
      retired: { id: testId(), label: "WH-99" },
      retiredTrailer: { id: testId(), label: "WH-T99" },
      drifting: { id: testId(), label: "WH-77" },
      harborTruck: { id: testId(), label: "HB-1" },
    },
    drivers: {
      mads: { id: testId(), name: "Mads Jensen" },
      jonas: { id: testId(), name: "Jonas Lind" },
      freja: { id: testId(), name: "Freja Holm" },
      sofie: { id: testId(), name: "Sofie Nielsen" },
      henrik: { id: testId(), name: "Henrik Havn" },
      karen: { id: testId(), name: "Karen Holt" },
      peter: { id: testId(), name: "Peter Lund" },
    },
  }
  const { depots, stations, vehicles, drivers } = fixtures
  const typeId = planning.vehicleTypes.rearLoader.id
  const truck = (row: FixtureVehicle, registration: string, requiredLicenceClass: string, projectId = copenhagen, status = "active") => ({
    id: row.id,
    companyId,
    projectId,
    registration,
    callsign: row.label,
    kind: "powered-vehicle",
    vehicleTypeId: typeId,
    ownership: "company",
    status,
    requiredLicenceClass,
    homeDepotId: projectId === copenhagen ? depots.nordhavn.id : depots.harbor.id,
  })
  const person = (row: FixtureDriver, licenceClass: string | null, licenceExpiry: string | null, projectId = copenhagen) => ({
    id: row.id,
    companyId,
    projectId,
    name: row.name,
    employment: "employee",
    licenceClass,
    licenceExpiry,
    status: "active",
  })

  await withCompany(pool.db, companyId, async (tx: Tx) => {
    await tx.insert(depot).values([
      { id: depots.nordhavn.id, companyId, projectId: copenhagen, code: "DEP-NORD", name: "Nordhavn depot", address: "Sundkrogsgade 21, 2100 København Ø", location: { type: "Point", coordinates: [12.5936, 55.7108] }, ownership: "company", status: "active" },
      { id: depots.harbor.id, companyId, projectId: harbor, code: "DEP-HAV", name: "Havnen depot", address: "Amerika Plads 1, 2100 København Ø", location: { type: "Point", coordinates: [12.6001, 55.7052] }, ownership: "company", status: "active" },
    ])
    await tx.insert(unloadingStation).values({
      id: stations.amager.id,
      companyId,
      code: "ARC-AMAGER",
      name: "ARC Amager Bakke",
      address: "Vindmøllevej 6, 2300 København S",
      location: { type: "Point", coordinates: [12.6199, 55.6825] },
      ownership: "external",
      weighbridge: true,
      status: "active",
    })
    await tx.insert(vehicle).values([
      truck(vehicles.wh24, "CN 42 018", "c"),
      truck(vehicles.wh25, "CN 42 019", "ce"),
      { ...truck(vehicles.trailer, "CN 90 112", "b"), kind: "trailer" },
      truck(vehicles.retired, "CN 11 999", "c", copenhagen, "retired"),
      { ...truck(vehicles.retiredTrailer, "CN 90 999", "b", copenhagen, "retired"), kind: "trailer" },
      truck(vehicles.drifting, "CN 42 077", "c"),
      truck(vehicles.harborTruck, "HB 10 001", "b", harbor),
    ])
    await tx.insert(driver).values([
      person(drivers.mads, "ce", "2030-12-31"),
      person(drivers.jonas, null, null),
      person(drivers.freja, "b", null),
      person(drivers.sofie, "c", SOFIE_LICENCE_EXPIRY),
      person(drivers.henrik, "ce", "2031-06-30", harbor),
      { ...person(drivers.karen, "ce", "2030-12-31"), status: "inactive" },
      { ...person(drivers.peter, "ce", "2030-12-31"), status: "suspended" },
    ])
  })
  return fixtures
}
