// The pilot's configuration as the demo seed writes it (Issue #156, decided
// in #143): Planning, Resources and Finance beside the Registry, on a fresh
// database of this file's own. Every reading the three seed files state in
// their headers — each mapping, derivation, invention and omission — is
// pinned here by the row it produces, so a header sentence and the data it
// describes cannot part. What is proved beyond the rows: a second run writes
// nothing; the references hold inside the tenant and the project; the four
// boundaries are the map's own outline of their containers, stored as a
// closed ring that covers them; both validated schemes pass the rules the API
// holds a validated scheme to; and no operational table holds a row.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { resolvePrice, type PriceRow } from "@waste/domain/finance/pricing"
import { planningAreaOutline } from "@waste/domain/map-planning/areas"
import { groupDriverIssue, schemeLicenceDay, schemeStructureIssues } from "@waste/domain/planning/checks"
import type { CustomerKind } from "@waste/domain/registry/vocabulary"
import type { LicenceClass } from "@waste/domain/resources/vocabulary"
import { CONTAINER_VEHICLE_COMPATIBILITY } from "@waste/domain/route-schemes/matching"
import { eq } from "drizzle-orm"

import { createDb, type Database } from "../client"
import { migrateDatabase } from "../migrate"
import { containerType, product } from "../schema/catalogue"
import { collectionCalendar, collectionCalendarHoliday } from "../schema/collection-calendars"
import { priceList, priceListRow } from "../schema/finance"
import { driver, vehicle, vehicleCompartment, vehicleCompartmentFraction } from "../schema/fleet"
import { containerTypeVehicleType, vehicleType } from "../schema/fleet-types"
import { depot, unloadingStation, unloadingStationFraction, warehouse } from "../schema/places"
import { planningArea, planningAreaBoundary } from "../schema/planning-areas"
import { collectionGroup, collectionGroupContainer, collectionGroupContainerType, collectionGroupFraction, routeScheme } from "../schema/route-schemes"
import { DEMO_IDS, seedDemo, type DemoSeedReport } from "../seed/demo"
import { PLANNING_BOUNDARY_SOURCES } from "../seed/planning"
import { databaseUnderTest, freshDatabase, type FreshDatabase } from "./database"

const database = databaseUnderTest()

describe("the pilot's configuration against a fresh database", { skip: database.skip }, () => {
  let fresh: FreshDatabase
  let owner: Database
  let first: DemoSeedReport

  before(async () => {
    fresh = await freshDatabase(database.adminUrl, "waste_seed_configuration")
    await migrateDatabase(fresh.url)
    owner = createDb(fresh.url, { max: 2 })
    first = await seedDemo(fresh.url)
  })
  after(async () => {
    await owner?.close()
    await fresh?.drop()
  })

  test("Resources: the five vehicle types of the domain's compatibility table and the trailer's own, and every pair the table allows", async () => {
    const { resources } = DEMO_IDS
    assert.ok(first.changed > 0)
    const types = await owner.db.select().from(vehicleType).orderBy(vehicleType.id)
    assert.deepEqual(
      types.map((row) => [row.id, row.key, row.name, row.description]),
      [
        [resources.vehicleTypes["rear-loader"], "rear-loader", "Rear loader", null],
        [resources.vehicleTypes["organic-sealed"], "organic-sealed", "Organic sealed", null],
        [resources.vehicleTypes["paper-compactor"], "paper-compactor", "Paper compactor", null],
        [resources.vehicleTypes["glass-crane"], "glass-crane", "Glass crane", null],
        [resources.vehicleTypes["vacuum-tanker"], "vacuum-tanker", "Vacuum tanker", null],
        // The canonical table names no trailer, and a vehicle needs a type: WH-T12's fixture Type fact.
        [resources.vehicleTypes["closed-trailer"], "closed-trailer", "Closed trailer", null],
      ],
    )

    // Every pair of the domain's table, and no other: without them the Residual + rear-loader rule matches nothing.
    const pairs = await owner.db
      .select({ containerType: containerType.name, vehicleType: vehicleType.name })
      .from(containerTypeVehicleType)
      .innerJoin(containerType, eq(containerType.id, containerTypeVehicleType.containerTypeId))
      .innerJoin(vehicleType, eq(vehicleType.id, containerTypeVehicleType.vehicleTypeId))
    const spelled = (rows: { containerType: string; vehicleType: string }[]) => rows.map((row) => `${row.containerType} → ${row.vehicleType}`).sort()
    assert.equal(pairs.length, 15)
    assert.deepEqual(
      spelled(pairs),
      spelled(Object.entries(CONTAINER_VEHICLE_COMPATIBILITY).flatMap(([name, vehicleTypes]) => vehicleTypes.map((type) => ({ containerType: name, vehicleType: type })))),
    )
    const [{ trailerPairs }] = await owner.sql<{ trailerPairs: number }[]>`
      select count(*)::int as "trailerPairs" from wms.container_type_vehicle_type where vehicle_type_id = ${resources.vehicleTypes["closed-trailer"]}`
    assert.equal(trailerPairs, 0, "a trailer empties no container")
  })

  test("Resources: the Nordhavn depot, three warehouses and ARC Amager with the fractions it accepts, each code its fixture id", async () => {
    const { resources, registry, projects } = DEMO_IDS
    const stamped = <T extends { createdAt: Date; updatedAt: Date }>(row: T) => ({ ...row, createdAt: undefined, updatedAt: undefined })

    const depots = await owner.db.select().from(depot)
    assert.deepEqual(depots.map(stamped), [
      {
        id: resources.depots["depot-nordhavn"],
        companyId: DEMO_IDS.company,
        projectId: projects.copenhagen,
        code: "DEPOT-NORDHAVN",
        name: "Nordhavn Depot",
        address: "Kaj 14, Nordhavn",
        // The fixture's typed coordinates.
        location: { type: "Point", coordinates: [12.5958, 55.7091] },
        ownership: "company",
        serviceProviderId: null,
        // "05:00–22:00"; its Vehicles and Drivers facts are counts, not the yard's capacity.
        opensAt: "05:00:00",
        closesAt: "22:00:00",
        vehicleCapacity: null,
        status: "active",
        notes: null,
        createdAt: undefined,
        updatedAt: undefined,
      },
    ])

    // Located only by coordinates, which no warehouse fixture has and no gazetteer street gives; Nordhavn's shares the depot's yard.
    const warehouses = await owner.db.select().from(warehouse).orderBy(warehouse.id)
    assert.deepEqual(
      warehouses.map((row) => [row.id, row.projectId, row.code, row.name, row.address, row.location, row.depotId, row.status, row.notes]),
      [
        [resources.warehouses["warehouse-west"], projects.copenhagen, "WAREHOUSE-WEST", "Warehouse West", "Logistikvej 8, Valby", null, null, "active", null],
        [resources.warehouses["warehouse-nordhavn"], projects.copenhagen, "WAREHOUSE-NORDHAVN", "Nordhavn Warehouse", "Kaj 14, Nordhavn", null, resources.depots["depot-nordhavn"], "active", null],
        [resources.warehouses["warehouse-harbor"], projects.harbor, "WAREHOUSE-HARBOR", "Harbor Satellite Warehouse", "Dock 2, Harbor Commercial", null, null, "active", null],
      ],
    )

    // The company's, where every Copenhagen project unloads; "Closes 17:00" alone is half a pair, so no hours.
    const stations = await owner.db.select().from(unloadingStation)
    assert.deepEqual(stations.map(stamped), [
      {
        id: resources.unloadingStations["station-arc"],
        companyId: DEMO_IDS.company,
        code: "STATION-ARC",
        name: "ARC Amager",
        address: "Kraftværksvej 31",
        location: { type: "Point", coordinates: [12.6186, 55.6903] },
        ownership: "external",
        serviceProviderId: null,
        opensAt: null,
        closesAt: null,
        weighbridge: true,
        status: "active",
        notes: null,
        createdAt: undefined,
        updatedAt: undefined,
      },
    ])
    const accepts = await owner.db.select().from(unloadingStationFraction).orderBy(unloadingStationFraction.id)
    assert.deepEqual(
      accepts.map((row) => [row.id, row.unloadingStationId, row.wasteFractionId]),
      [
        [resources.unloadingStationFractions["station-arc:residual"], resources.unloadingStations["station-arc"], registry.wasteFractions.residual],
        [resources.unloadingStationFractions["station-arc:mixed"], resources.unloadingStations["station-arc"], registry.wasteFractions.mixed],
      ],
    )
  })

  test("Resources: five vehicles, one compartment per powered vehicle carrying its Fractions fact, and four drivers, Mads Jensen's profile on his account", async () => {
    const { resources, registry, projects, serviceProviders, users } = DEMO_IDS
    const vehicles = await owner.db.select().from(vehicle).orderBy(vehicle.id)
    assert.deepEqual(
      vehicles.map((row) => [
        row.id,
        row.projectId,
        row.callsign,
        row.registration,
        row.kind,
        row.vehicleTypeId,
        row.ownership,
        row.serviceProviderId,
        row.status,
        row.capacityKg,
        row.requiredLicenceClass,
        row.homeDepotId,
        row.fuel,
        row.telematicsDeviceId,
        row.notes,
      ]),
      [
        // "On route" and "Position stale" are telemetry: the status is active. The home depot is the context's, where a depot record exists.
        [resources.vehicles["vehicle-wh24"], projects.copenhagen, "WH-24", "CN 42 018", "powered-vehicle", resources.vehicleTypes["rear-loader"], "company", null, "active", 18000, "c", resources.depots["depot-nordhavn"], "hvo", null, null],
        [resources.vehicles["vehicle-wh31"], projects.copenhagen, "WH-31", "DK 88 441", "powered-vehicle", resources.vehicleTypes["glass-crane"], "company", null, "active", 16000, "c", null, "diesel", null, null],
        [resources.vehicles["vehicle-nr08"], projects.copenhagen, "NR-08", "AB 51 912", "powered-vehicle", resources.vehicleTypes["organic-sealed"], "service-provider", serviceProviders.nordren, "active", 12000, "c", null, "biogas", null, null],
        [resources.vehicles["vehicle-nr12"], projects.copenhagen, "NR-12", "CK 74 305", "powered-vehicle", resources.vehicleTypes["paper-compactor"], "service-provider", serviceProviders.nordren, "active", 14000, "c", null, "diesel", null, null],
        // The one invented value of Resources: the trailer's plate, which its fixture does not name.
        [resources.vehicles["trailer-wh12"], projects.copenhagen, "WH-T12", "TR 12 012", "trailer", resources.vehicleTypes["closed-trailer"], "company", null, "active", 18000, "ce", resources.depots["depot-nordhavn"], null, null, null],
      ],
    )

    const compartments = await owner.db.select().from(vehicleCompartment).orderBy(vehicleCompartment.id)
    assert.deepEqual(
      compartments.map((row) => [row.id, row.vehicleId, row.position, row.name, row.capacityKg, row.volumeLitres]),
      [
        [resources.vehicleCompartments["vehicle-wh24:1"], resources.vehicles["vehicle-wh24"], 1, null, null, null],
        [resources.vehicleCompartments["vehicle-wh31:1"], resources.vehicles["vehicle-wh31"], 1, null, null, null],
        [resources.vehicleCompartments["vehicle-nr08:1"], resources.vehicles["vehicle-nr08"], 1, null, null, null],
        [resources.vehicleCompartments["vehicle-nr12:1"], resources.vehicles["vehicle-nr12"], 1, null, null, null],
      ],
    )
    const carried = await owner.db.select().from(vehicleCompartmentFraction).orderBy(vehicleCompartmentFraction.id)
    assert.deepEqual(
      carried.map((row) => [row.id, row.vehicleCompartmentId, row.wasteFractionId]),
      [
        [resources.vehicleCompartmentFractions["vehicle-wh24:1:residual"], resources.vehicleCompartments["vehicle-wh24:1"], registry.wasteFractions.residual],
        [resources.vehicleCompartmentFractions["vehicle-wh24:1:mixed"], resources.vehicleCompartments["vehicle-wh24:1"], registry.wasteFractions.mixed],
        [resources.vehicleCompartmentFractions["vehicle-wh31:1:glass"], resources.vehicleCompartments["vehicle-wh31:1"], registry.wasteFractions.glass],
        [resources.vehicleCompartmentFractions["vehicle-nr08:1:organic"], resources.vehicleCompartments["vehicle-nr08:1"], registry.wasteFractions.organic],
        [resources.vehicleCompartmentFractions["vehicle-nr12:1:paper"], resources.vehicleCompartments["vehicle-nr12:1"], registry.wasteFractions.paper],
      ],
    )

    const drivers = await owner.db.select().from(driver).orderBy(driver.id)
    assert.deepEqual(
      drivers.map((row) => [
        row.id,
        row.projectId,
        row.name,
        row.workforceReference,
        row.employment,
        row.serviceProviderId,
        row.homeDepotId,
        row.licenceClass,
        row.licenceNumber,
        row.licenceExpiry,
        row.userAccountId,
        row.status,
        row.notes,
      ]),
      [
        [resources.drivers["driver-mads"], projects.copenhagen, "Mads Jensen", null, "employee", null, null, "ce", null, "2028-12-31", users.mads, "active", null],
        [resources.drivers["driver-freja"], projects.copenhagen, "Freja Nielsen", null, "employee", null, null, "ce", null, "2027-06-30", null, "active", null],
        // Expired at its literal fixture value; "Licence expiring" is a reading of it, the status is active.
        [resources.drivers["driver-lars"], projects.copenhagen, "Lars Møller", null, "service-provider", serviceProviders.nordren, null, "c", null, "2026-09-05", null, "active", null],
        // "Invited" is his account's word, not the driver's: an active profile with no licence on record and no account.
        [resources.drivers["driver-jonas"], projects.copenhagen, "Jonas Lind", null, "employee", null, null, null, null, null, null, "active", null],
      ],
    )
  })

  test("Planning: five areas at their fixture codes, four of them bounded by the map's own outline of their containers, stored as a closed ring that covers every one", async () => {
    const { planning, projects } = DEMO_IDS
    const areas = await owner.db.select().from(planningArea).orderBy(planningArea.id)
    assert.deepEqual(
      areas.map((row) => [row.id, row.projectId, row.code, row.name, row.purpose]),
      [
        [planning.planningAreas["area-indreby"], projects.copenhagen, "OP-CEN-01", "Indre By Operations", "route-planning"],
        [planning.planningAreas["area-osterbro-contract"], projects.copenhagen, "OP-Ø-02", "Østerbro Zone 2", "route-planning"],
        [planning.planningAreas["area-amager-1"], projects.copenhagen, "OP-AM-01", "Amager Zone 1", "route-planning"],
        [planning.planningAreas["area-harbor-1"], projects.harbor, "OP-HAR-01", "Nordhavn Harbor Area", "route-planning"],
        [planning.planningAreas["area-cairo-nasr"], projects.cairo, "OP-CAI-01", "Nasr City Operations", "route-planning"],
      ],
    )

    // The containers the fixtures file under each area and the map places: every in-service one, the explicit ones by their facts. Cairo's area has none, so no boundary.
    const sources = PLANNING_BOUNDARY_SOURCES
    assert.deepEqual(
      Object.fromEntries(Object.entries(sources).map(([area, placed]) => [area, placed.length])),
      { "area-indreby": 24, "area-osterbro-contract": 23, "area-amager-1": 23, "area-harbor-1": 29 },
    )
    const labelsIn = (area: string) => sources[area].map((placed) => placed.container)
    assert.ok(labelsIn("area-indreby").includes("asset-66420"), "BIN-66420 stands at Nørrebrogade 144, a street the map knows and no fixture property")
    assert.ok(labelsIn("area-osterbro-contract").includes("asset-82014"))
    assert.ok(labelsIn("area-amager-1").includes("asset-44831"))
    assert.ok(labelsIn("area-harbor-1").includes("asset-77104"))
    assert.ok(!Object.values(sources).flat().some((placed) => ["asset-99017", "asset-50318", "asset-11862", "asset-seed-91018"].includes(placed.container)), "in storage, ended and in transit are not on the map")

    const boundaries = await owner.db.select().from(planningAreaBoundary).orderBy(planningAreaBoundary.id)
    assert.deepEqual(
      boundaries.map((row) => [row.id, row.projectId, row.planningAreaId, row.validFrom, row.validTo]),
      [
        [planning.planningAreaBoundaries["area-indreby"], projects.copenhagen, planning.planningAreas["area-indreby"], "2026-01-01", null],
        [planning.planningAreaBoundaries["area-osterbro-contract"], projects.copenhagen, planning.planningAreas["area-osterbro-contract"], "2026-01-01", null],
        [planning.planningAreaBoundaries["area-amager-1"], projects.copenhagen, planning.planningAreas["area-amager-1"], "2026-01-01", null],
        [planning.planningAreaBoundaries["area-harbor-1"], projects.harbor, planning.planningAreas["area-harbor-1"], "2026-01-01", null],
      ],
    )
    for (const [area, placed] of Object.entries(sources)) {
      const [row] = boundaries.filter((candidate) => candidate.planningAreaId === planning.planningAreas[area])
      const ring = row.boundary.coordinates[0]
      assert.deepEqual(ring.at(-1), ring[0], `${area}'s ring is closed`)
      // The map's outline of the same spots, to the decimetre the stored points keep: one derivation, no seed-specific geometry.
      const outline = planningAreaOutline(placed.map((entry) => ({ lng: entry.spot.coordinates[0], lat: entry.spot.coordinates[1] })))
      assert.deepEqual(
        ring.slice(0, -1),
        outline.map((vertex) => [Math.round(vertex.lng * 1e6) / 1e6, Math.round(vertex.lat * 1e6) / 1e6]),
        `${area} is the map's outline`,
      )
      const [{ uncovered }] = await owner.sql<{ uncovered: number }[]>`
        select count(*)::int as uncovered
        from jsonb_array_elements(${JSON.stringify(placed.map((entry) => entry.spot))}::jsonb) as spot(point)
        where not extensions.st_covers((select boundary from wms.planning_area_boundary where id = ${row.id}), extensions.st_geomfromgeojson(spot.point::text))`
      assert.equal(uncovered, 0, `${area} covers the containers it was derived from`)
    }

    // The spots are the seed's own geography: where the Registry stores each property, and BIN-66420's street address, the one container placed at no fixture property.
    const located = await owner.sql<{ location: string }[]>`select extensions.st_asgeojson(location) as location from wms.property`
    const stored = new Set(located.map((row) => JSON.stringify(JSON.parse(row.location).coordinates)))
    const elsewhere = Object.values(sources)
      .flat()
      .filter((placed) => !stored.has(JSON.stringify(placed.spot.coordinates)))
      .map((placed) => placed.container)
    assert.deepEqual(elsewhere, ["asset-66420"])
  })

  test("Planning: five collection calendars with half-open periods, and thirty-one holidays named as their project's holiday list names them", async () => {
    const { planning, projects } = DEMO_IDS
    const calendars = await owner.db.select().from(collectionCalendar).orderBy(collectionCalendar.id)
    assert.deepEqual(
      calendars.map((row) => [row.id, row.projectId, row.name, row.validFrom, row.validTo]),
      [
        // "1 Jan – 31 Dec 2026": the end is the first day out of force.
        [planning.collectionCalendars["calendar-central"], projects.copenhagen, "Copenhagen Central 2026", "2026-01-01", "2027-01-01"],
        [planning.collectionCalendars["calendar-central-2027"], projects.copenhagen, "Copenhagen Central 2027", "2027-01-01", "2028-01-01"],
        // Its "Draft" has no column: Harbor names no holiday list, so the calendar is read by nothing, which is the fixture's truth.
        [planning.collectionCalendars["calendar-harbor"], projects.harbor, "Harbor Offices service calendar", "2026-09-01", "2027-09-01"],
        [planning.collectionCalendars["calendar-cairo-2026"], projects.cairo, "Cairo Operations 2026", "2026-09-01", "2027-01-01"],
        [planning.collectionCalendars["calendar-cairo-2027"], projects.cairo, "Cairo Operations 2027", "2027-01-01", "2028-01-01"],
      ],
    )

    const holidays = await owner.db.select().from(collectionCalendarHoliday).orderBy(collectionCalendarHoliday.collectionCalendarId, collectionCalendarHoliday.day)
    const of = (calendar: string) => holidays.filter((row) => row.collectionCalendarId === planning.collectionCalendars[calendar])
    assert.deepEqual(
      Object.keys(planning.collectionCalendars).map((calendar) => of(calendar).length),
      [11, 11, 0, 1, 8],
    )
    assert.deepEqual(
      of("calendar-central").map((row) => [row.id, row.projectId, row.day, row.name]),
      [
        ["2026-01-01", "New Year's Day"],
        ["2026-04-02", "Maundy Thursday"],
        ["2026-04-03", "Good Friday"],
        ["2026-04-05", "Easter Sunday"],
        ["2026-04-06", "Easter Monday"],
        ["2026-05-14", "Ascension Day"],
        ["2026-05-24", "Whit Sunday"],
        ["2026-05-25", "Whit Monday"],
        ["2026-06-05", "Constitution Day"],
        ["2026-12-25", "Christmas Day"],
        ["2026-12-26", "2nd Christmas Day"],
      ].map(([day, name]) => [planning.collectionCalendarHolidays[`calendar-central:${day}`], projects.copenhagen, day, name]),
    )
    // The Egyptian list names its fixed dates; the two Eid days of 2027 move every year and are nobody's name here.
    assert.deepEqual(
      of("calendar-cairo-2027").map((row) => [row.day, row.name]),
      [
        ["2027-01-07", "Coptic Christmas"],
        ["2027-01-25", "Revolution Day"],
        ["2027-03-08", null],
        ["2027-03-09", null],
        ["2027-04-25", "Sinai Liberation Day"],
        ["2027-05-01", "Labour Day"],
        ["2027-06-30", "30 June Revolution"],
        ["2027-07-23", "Revolution Day"],
      ],
    )
    assert.deepEqual(of("calendar-cairo-2026").map((row) => [row.day, row.name]), [["2026-10-06", "Armed Forces Day"]])
  })

  test("Planning: RS-Central · Week A and RS-Østerbro · Organic B, validated from their fixture start with no end, each with its implicit group made explicit", async () => {
    const { planning, resources, registry, projects, serviceProviders } = DEMO_IDS
    const schemes = await owner.db.select().from(routeScheme).orderBy(routeScheme.id)
    assert.deepEqual(
      schemes.map((row) => [
        row.id,
        row.projectId,
        row.name,
        row.planningAreaId,
        row.serviceType,
        row.frequency,
        row.serviceDays,
        row.weekRotation,
        row.plannedStartTime,
        row.holidayPolicy,
        row.editPolicy,
        row.planAhead,
        row.status,
        row.validFrom,
        row.validTo,
        row.depotId,
        row.unloadingStationId,
      ]),
      [
        [
          planning.routeSchemes["scheme-central-a"],
          projects.copenhagen,
          "RS-Central · Week A",
          planning.planningAreas["area-indreby"],
          "container-collection",
          "weekly",
          ["monday", "tuesday", "wednesday", "thursday", "friday"],
          null,
          "06:00:00",
          "skip",
          "ask",
          true,
          // "Scheduled" is a reading of generated routes, which are not seeded.
          "validated",
          "2026-06-01",
          null,
          // Its fixture's "Nordhavn depot"; neither fixture names an unloading station.
          resources.depots["depot-nordhavn"],
          null,
        ],
        [
          planning.routeSchemes["scheme-osterbro-b"],
          projects.copenhagen,
          "RS-Østerbro · Organic B",
          null,
          "container-collection",
          "every-2-weeks",
          ["tuesday", "thursday"],
          "even",
          "06:30:00",
          "skip",
          "ask",
          true,
          "validated",
          "2026-08-04",
          // The fixture's end, 31 Dec 2026, lifted.
          null,
          null,
          null,
        ],
      ],
    )

    const groups = await owner.db.select().from(collectionGroup).orderBy(collectionGroup.id)
    assert.deepEqual(
      groups.map((row) => [row.id, row.projectId, row.routeSchemeId, row.name, row.position, row.days, row.stopSource, row.ruleVehicleTypeId, row.serviceProviderId, row.vehicleId, row.driverId]),
      [
        [
          planning.collectionGroups["scheme-central-a:default"],
          projects.copenhagen,
          planning.routeSchemes["scheme-central-a"],
          "RS-Central · Week A",
          1,
          ["monday", "tuesday", "wednesday", "thursday", "friday"],
          "rule",
          resources.vehicleTypes["rear-loader"],
          null,
          resources.vehicles["vehicle-wh24"],
          resources.drivers["driver-mads"],
        ],
        [
          planning.collectionGroups["scheme-osterbro-b:default"],
          projects.copenhagen,
          planning.routeSchemes["scheme-osterbro-b"],
          "RS-Østerbro · Organic B",
          1,
          ["tuesday", "thursday"],
          "manual",
          null,
          serviceProviders.nordren,
          resources.vehicles["vehicle-nr08"],
          // Lars Møller's licence ran out on 2026-09-05: the API would refuse him today, so the group names no driver.
          null,
        ],
      ],
    )
    const matches = await owner.db.select().from(collectionGroupFraction)
    assert.deepEqual(
      matches.map((row) => [row.id, row.collectionGroupId, row.wasteFractionId]),
      [[planning.collectionGroupFractions["scheme-central-a:default:residual"], planning.collectionGroups["scheme-central-a:default"], registry.wasteFractions.residual]],
    )
    assert.deepEqual(await owner.db.select().from(collectionGroupContainerType), [], "no rule is restricted to container types")
    const picks = await owner.db.select().from(collectionGroupContainer).orderBy(collectionGroupContainer.position)
    assert.deepEqual(
      picks.map((row) => [row.id, row.collectionGroupId, row.containerId, row.position]),
      ["asset-seed-91007", "asset-seed-91008", "asset-seed-91010", "asset-seed-91011"].map((container, index) => [
        planning.collectionGroupContainers[`scheme-osterbro-b:default:${container}`],
        planning.collectionGroups["scheme-osterbro-b:default"],
        registry.containers[container],
        index + 1,
      ]),
    )
  })

  test("Planning: both validated schemes pass the rules the API holds one to — its structure, and a group's driver licensed for its vehicle — where Lars Møller on NR-08 would not", async () => {
    // The day the pilot's configuration was decided (#143): the API judges a group's driver on today, or on the scheme's start where that is later.
    const today = "2026-09-29"
    const schemes = await owner.db.select().from(routeScheme)
    assert.equal(schemes.length, 2)
    for (const scheme of schemes) {
      const groups = await owner.db.select().from(collectionGroup).where(eq(collectionGroup.routeSchemeId, scheme.id))
      const structure = await Promise.all(
        groups.map(async (group) => {
          const [{ fractions, containers }] = await owner.sql<{ fractions: number; containers: number }[]>`
            select (select count(*)::int from wms.collection_group_fraction where collection_group_id = ${group.id}) as fractions,
                   (select count(*)::int from wms.collection_group_container where collection_group_id = ${group.id}) as containers`
          const [truck] = group.vehicleId ? await owner.db.select().from(vehicle).where(eq(vehicle.id, group.vehicleId)) : []
          const [who] = group.driverId ? await owner.db.select().from(driver).where(eq(driver.id, group.driverId)) : []
          if (truck && who) {
            const issue = groupDriverIssue(
              { vehicle: { label: truck.callsign ?? truck.registration, requiredLicenceClass: truck.requiredLicenceClass as LicenceClass }, driver: { name: who.name, licenceClass: who.licenceClass as LicenceClass | null, licenceExpiry: who.licenceExpiry } },
              schemeLicenceDay(scheme.validFrom, today),
            )
            assert.equal(issue, undefined, `${who.name} may take ${truck.callsign}`)
          }
          return {
            name: group.name,
            days: group.days,
            stopSource: group.stopSource,
            fractionCount: fractions,
            containerCount: containers,
            vehicle: truck ? { id: truck.id, label: truck.callsign ?? truck.registration } : null,
            driver: who ? { id: who.id, label: who.name } : null,
          }
        }),
      )
      assert.deepEqual(schemeStructureIssues({ serviceDays: scheme.serviceDays, hasPlanningArea: scheme.planningAreaId !== null, collectionGroups: structure }), [], scheme.name)
    }

    const [lars] = await owner.db.select().from(driver).where(eq(driver.id, DEMO_IDS.resources.drivers["driver-lars"]))
    const [nr08] = await owner.db.select().from(vehicle).where(eq(vehicle.id, DEMO_IDS.resources.vehicles["vehicle-nr08"]))
    assert.equal(
      groupDriverIssue(
        { vehicle: { label: nr08.callsign!, requiredLicenceClass: nr08.requiredLicenceClass as LicenceClass }, driver: { name: lars.name, licenceClass: lars.licenceClass as LicenceClass, licenceExpiry: lars.licenceExpiry } },
        schemeLicenceDay("2026-08-04", today),
      ),
      "Lars Møller's licence expires on 2026-09-05, before today",
    )
  })

  test("Finance: every product of both projects carries VAT 25 % and its fixture invoice name and code", async () => {
    const { registry } = DEMO_IDS
    const products = await owner.db.select().from(product)
    assert.equal(products.length, 14)
    const invoicing = {
      "product-res-240": ["Residual waste collection 240L", "RES-240"],
      "product-card-660": ["Cardboard collection 660L", "CRD-660"],
      "product-glass-igloo": ["Glass igloo emptying", "GLS-IGL"],
      "product-clean-monthly": ["Bin cleaning subscription", "SRV-CLN"],
      "product-bulky": ["Bulky waste pickup", "SRV-BLK"],
      "product-bagtag": ["Extra bag tag", "SRV-TAG"],
      "product-xmas": ["Christmas tree collection", "SRV-XMS"],
    }
    for (const project of ["copenhagen", "harbor"] as const) {
      for (const [key, [invoiceName, invoiceCode]] of Object.entries(invoicing)) {
        const row = products.find((candidate) => candidate.id === registry.products[project][key])
        assert.deepEqual([row?.vatPercent, row?.invoiceName, row?.invoiceCode], [25, invoiceName, invoiceCode], `${project} ${key}`)
      }
    }
  })

  test("Finance: a default DKK price list per project, and the rows #127 approved — amounts as DKK minor units — whose precedence resolves as the pilot's Explain price shows it", async () => {
    const { finance, registry, projects } = DEMO_IDS
    const lists = await owner.db.select().from(priceList).orderBy(priceList.id)
    assert.deepEqual(
      lists.map((row) => [row.id, row.projectId, row.code, row.name, row.currency, row.isDefault, row.validFrom, row.validTo, row.notes]),
      [
        [finance.priceLists["price-list-copenhagen-2026"], projects.copenhagen, "PL-Copenhagen-2026", "PL-Copenhagen-2026", "DKK", true, "2026-01-01", null, "Annual tariff for Copenhagen municipal collection."],
        [finance.priceLists["price-list-harbor-2026"], projects.harbor, "PL-Harbor-2026", "PL-Harbor-2026", "DKK", true, "2026-01-01", null, "Annual tariff for the Harbor service area."],
      ],
    )

    const rows = await owner.db.select().from(priceListRow).orderBy(priceListRow.id)
    const osterbro = registry.customers["company-osterbro-housing"]
    const expected = (project: "copenhagen" | "harbor", list: string) =>
      (
        [
          ["price-row-res-default", "product-res-240", 1850, null, null, "2026-01-01", null],
          ...(project === "copenhagen"
            ? ([
                // The fixture's Customer type Commercial, as the Registry's kind of such a customer.
                ["price-row-res-com", "product-res-240", 2450, "organisation", null, "2026-01-01", null],
                // To the seeded Østerbro Housing by its id; the fixture's inclusive 2027-02-02 made the first day out.
                ["price-row-res-osterbro", "product-res-240", 1590, null, osterbro, "2026-02-03", "2027-02-03"],
              ] as const)
            : []),
          ["price-row-card-default", "product-card-660", 2400, null, null, "2026-01-01", null],
          ["price-row-glass-default", "product-glass-igloo", 4100, null, null, "2026-01-01", null],
          ["price-row-bulky-default", "product-bulky", 4500, null, null, "2026-01-01", null],
        ] as const
      ).map(([row, productKey, unitPriceMinor, customerKind, customerId, validFrom, validTo]) => [
        finance.priceListRows[project][row],
        projects[project],
        list,
        registry.products[project][productKey],
        unitPriceMinor,
        null,
        customerKind,
        null,
        null,
        customerId,
        null,
        validFrom,
        validTo,
      ])
    assert.deepEqual(
      rows.map((row) => [
        row.id,
        row.projectId,
        row.priceListId,
        row.productId,
        row.unitPriceMinor,
        row.planningAreaId,
        row.customerKind,
        row.containerTypeId,
        row.wasteFractionId,
        row.customerId,
        row.note,
        row.validFrom,
        row.validTo,
      ]),
      [...expected("copenhagen", finance.priceLists["price-list-copenhagen-2026"]), ...expected("harbor", finance.priceLists["price-list-harbor-2026"])],
    )

    // Residual 240 L on Copenhagen's list, as a pickup on 2026-10-13 prices it: the negotiated row for Østerbro Housing, the organisation row for another organisation, the default for a person.
    const residual = rows.filter((row) => row.productId === registry.products.copenhagen["product-res-240"]) as PriceRow[]
    const priced = (customerKind: CustomerKind, customerId: string) => resolvePrice(residual, { on: "2026-10-13", customerKind, customerId }).winner?.row.unitPriceMinor
    assert.equal(priced("organisation", osterbro), 1590)
    assert.equal(priced("organisation", registry.customers["customer-kab-bolig"]), 2450)
    assert.equal(priced("person", registry.customers["owner-property-sundbyvej-91"]), 1850)
  })

  test("every row is the company's, and holds what the API holds and the keys cannot: days inside their periods, groups inside their schemes, the driver's project his account's, and the Driver App's chain", async () => {
    const { planning, resources, registry } = DEMO_IDS
    for (const name of CONFIGURATION_TABLES) {
      const [{ companies }] = await owner.sql<{ companies: string[] }[]>`select coalesce(array_agg(distinct company_id), '{}') as companies from ${owner.sql("wms")}.${owner.sql(name)}`
      assert.deepEqual(
        companies.filter((company) => company !== DEMO_IDS.company),
        [],
        `wms.${name} holds the demo company's rows alone`,
      )
    }

    const [strays] = await owner.sql<Record<string, number>[]>`
      select
        -- A holiday inside its calendar's period (the API's 400).
        (select count(*)::int from wms.collection_calendar_holiday h join wms.collection_calendar c on c.id = h.collection_calendar_id
          where h.day < c.valid_from or (c.valid_to is not null and h.day >= c.valid_to)) as holidays,
        -- A price row inside its list's period (routes/periods.ts).
        (select count(*)::int from wms.price_list_row r join wms.price_list l on l.id = r.price_list_id
          where r.valid_from < l.valid_from or (l.valid_to is not null and (r.valid_to is null or r.valid_to > l.valid_to))) as rows,
        -- A group's days among its scheme's.
        (select count(*)::int from wms.collection_group g join wms.route_scheme s on s.id = g.route_scheme_id where not g.days <@ s.service_days) as days,
        -- A group's vehicle powered, and a compartment only on a powered vehicle.
        (select count(*)::int from wms.collection_group g join wms.vehicle v on v.id = g.vehicle_id where v.kind <> 'powered-vehicle') as trailers,
        (select count(*)::int from wms.vehicle_compartment c join wms.vehicle v on v.id = c.vehicle_id where v.kind <> 'powered-vehicle') as compartments,
        -- A driver's account works in the driver's project.
        (select count(*)::int from wms.driver d where d.user_account_id is not null and not exists (
          select 1 from wms.project_access a where a.user_account_id = d.user_account_id and a.project_id = d.project_id)) as accounts`
    assert.deepEqual(strays, { holidays: 0, rows: 0, days: 0, trailers: 0, compartments: 0, accounts: 0 })

    // The Driver App's acceptance chain (#125, #143): RS-Central's rule fraction is what WH-24 carries and ARC Amager accepts, over a boundary in force when the scheme starts.
    const [chain] = await owner.sql<{ carried: boolean; accepted: boolean; bounded: boolean }[]>`
      select
        exists (select 1 from wms.vehicle_compartment_fraction f join wms.vehicle_compartment c on c.id = f.vehicle_compartment_id
          where c.vehicle_id = ${resources.vehicles["vehicle-wh24"]} and f.waste_fraction_id = ${registry.wasteFractions.residual}) as carried,
        exists (select 1 from wms.unloading_station_fraction where unloading_station_id = ${resources.unloadingStations["station-arc"]} and waste_fraction_id = ${registry.wasteFractions.residual}) as accepted,
        exists (select 1 from wms.planning_area_boundary where planning_area_id = ${planning.planningAreas["area-indreby"]} and valid_from <= '2026-06-01' and valid_to is null) as bounded`
    assert.deepEqual(chain, { carried: true, accepted: true, bounded: true })
  })

  test("the seed writes no operational row: no route, run, session, proof, command, event, ticket, money or movement, and the company's counters stand", async () => {
    const empty = [
      "route",
      "pickup",
      "generation_run",
      "generation_match",
      "session",
      "driver_command",
      "proof_of_service",
      "unload",
      "outbox_event",
      "ticket",
      "ticket_event",
      "alert",
      "billable_event",
      "billing_run",
      "billing_run_exclusion",
      "invoice",
      "invoice_line",
      "settlement",
      "settlement_line",
      "settlement_event",
      "weight_review",
      "stock_movement",
      "vehicle_allocation",
      "vehicle_allocation_event",
      "service_area",
      "service_area_planning_area",
      "service_area_waste_fraction",
      "service_area_assignment",
      "service_provider_price",
    ]
    for (const table of empty) {
      const [{ rows }] = await owner.sql<{ rows: number }[]>`select count(*)::int as rows from ${owner.sql("wms")}.${owner.sql(table)}`
      assert.equal(rows, 0, `wms.${table} holds ${rows} rows`)
    }
    const [counters] = await owner.sql<{ route: number; ticket: number; invoice: number }[]>`
      select next_route_number as route, next_ticket_number as ticket, next_invoice_number as invoice from wms.company where id = ${DEMO_IDS.company}`
    assert.deepEqual(counters, { route: 1000, ticket: 1000, invoice: 1000 })
  })

  test("a second run writes nothing: not a row of the configuration, not an updated_at", async () => {
    const tables = CONFIGURATION_TABLES.map((name) => owner.sql`select * from ${owner.sql("wms")}.${owner.sql(name)} order by id`)
    const before = JSON.stringify(await Promise.all(tables))
    const report = await seedDemo(fresh.url)
    assert.equal(report.changed, 0)
    assert.equal(JSON.stringify(await Promise.all(CONFIGURATION_TABLES.map((name) => owner.sql`select * from ${owner.sql("wms")}.${owner.sql(name)} order by id`))), before)
  })

  /** Every configuration row without its stamps, keyed by table: what the seed says, whenever it was written. */
  const content = async () =>
    JSON.stringify(
      await Promise.all(CONFIGURATION_TABLES.map((name) => owner.sql`select to_jsonb(t) - 'created_at' - 'updated_at' as row from ${owner.sql("wms")}.${owner.sql(name)} t order by id`)),
    )

  test("what someone edited by hand goes back to what the seed says, the sets the API replaces whole among it", async () => {
    const { planning, resources, finance, registry, projects } = DEMO_IDS
    const seeded = await content()
    const tenant = { companyId: DEMO_IDS.company, projectId: projects.copenhagen }

    // Rows edited in place: a scheme renamed and drafted, a driver named on RS-Østerbro's group and his licence renewed, a price and a rate changed.
    await owner.db.update(routeScheme).set({ name: "RS-Central · renamed", status: "draft" }).where(eq(routeScheme.id, planning.routeSchemes["scheme-central-a"]))
    await owner.db.update(driver).set({ licenceExpiry: "2031-01-01" }).where(eq(driver.id, resources.drivers["driver-lars"]))
    await owner.db.update(collectionGroup).set({ driverId: resources.drivers["driver-lars"] }).where(eq(collectionGroup.id, planning.collectionGroups["scheme-osterbro-b:default"]))
    await owner.db.update(priceListRow).set({ unitPriceMinor: 1 }).where(eq(priceListRow.id, finance.priceListRows.copenhagen["price-row-res-default"]))
    await owner.db.update(product).set({ vatPercent: 0 }).where(eq(product.id, registry.products.harbor["product-bulky"]))
    // Sets: a holiday renamed and one added; the picks reversed with a fifth; WH-24's compartment made to carry glass; a compatibility pair dropped; Central's rule restricted to one container type.
    await owner.db.update(collectionCalendarHoliday).set({ name: "Renamed" }).where(eq(collectionCalendarHoliday.id, planning.collectionCalendarHolidays["calendar-central:2026-06-05"]))
    await owner.db.insert(collectionCalendarHoliday).values({ ...tenant, collectionCalendarId: planning.collectionCalendars["calendar-central"], day: "2026-07-01", name: "Extra" })
    const osterbro = planning.collectionGroups["scheme-osterbro-b:default"]
    await owner.db.delete(collectionGroupContainer).where(eq(collectionGroupContainer.collectionGroupId, osterbro))
    await owner.db.insert(collectionGroupContainer).values(
      ["asset-seed-91011", "asset-seed-91010", "asset-seed-91008", "asset-seed-91007", "asset-seed-91001"].map((container, index) => ({ ...tenant, collectionGroupId: osterbro, containerId: registry.containers[container], position: index + 1 })),
    )
    await owner.db.insert(vehicleCompartmentFraction).values({ ...tenant, vehicleCompartmentId: resources.vehicleCompartments["vehicle-wh24:1"], wasteFractionId: registry.wasteFractions.glass })
    await owner.db.delete(containerTypeVehicleType).where(eq(containerTypeVehicleType.id, resources.containerTypeVehicleTypes["rear-loader:two-wheel-240"]))
    await owner.db
      .insert(collectionGroupContainerType)
      .values({ ...tenant, collectionGroupId: planning.collectionGroups["scheme-central-a:default"], containerTypeId: registry.containerTypes["two-wheel-240"] })

    const report = await seedDemo(fresh.url)
    assert.ok(report.changed > 0)
    assert.equal(await content(), seeded, "every row as the seed says it, under the seed's ids")
    assert.equal((await seedDemo(fresh.url)).changed, 0)
  })

  test("a set the API wrote back under ids of its own is left as it is when it says what the seed says, and nothing is written", async () => {
    const { planning, resources } = DEMO_IDS
    // What the API does on every edit of a set: the rows go, and the same content comes back under ids it mints.
    const rewrite = async <T extends typeof collectionCalendarHoliday | typeof collectionGroupContainer | typeof collectionGroupFraction | typeof unloadingStationFraction | typeof containerTypeVehicleType>(
      table: T,
      parent: T["_"]["columns"][keyof T["_"]["columns"]],
      parentId: string,
    ) => {
      const rows = (await owner.db.select().from(table as never).where(eq(parent as never, parentId))) as Record<string, unknown>[]
      await owner.db.delete(table as never).where(eq(parent as never, parentId))
      await owner.db.insert(table as never).values(rows.map(({ id: _id, createdAt: _created, updatedAt: _updated, ...rest }) => rest) as never)
    }
    await rewrite(collectionCalendarHoliday, collectionCalendarHoliday.collectionCalendarId, planning.collectionCalendars["calendar-central"])
    await rewrite(collectionGroupContainer, collectionGroupContainer.collectionGroupId, planning.collectionGroups["scheme-osterbro-b:default"])
    await rewrite(collectionGroupFraction, collectionGroupFraction.collectionGroupId, planning.collectionGroups["scheme-central-a:default"])
    await rewrite(unloadingStationFraction, unloadingStationFraction.unloadingStationId, resources.unloadingStations["station-arc"])
    await rewrite(containerTypeVehicleType, containerTypeVehicleType.vehicleTypeId, resources.vehicleTypes["rear-loader"])
    // WH-24's compartments, as PUT /vehicles/{id}/compartments replaces them: the fractions go first, and all of it comes back under new ids.
    const wh24 = resources.vehicles["vehicle-wh24"]
    const [compartment] = await owner.db.select().from(vehicleCompartment).where(eq(vehicleCompartment.vehicleId, wh24))
    const carried = await owner.db.select().from(vehicleCompartmentFraction).where(eq(vehicleCompartmentFraction.vehicleCompartmentId, compartment.id))
    await owner.db.delete(vehicleCompartmentFraction).where(eq(vehicleCompartmentFraction.vehicleCompartmentId, compartment.id))
    await owner.db.delete(vehicleCompartment).where(eq(vehicleCompartment.id, compartment.id))
    const { id: _id, createdAt: _created, updatedAt: _updated, ...again } = compartment
    const [written] = await owner.db.insert(vehicleCompartment).values(again).returning({ id: vehicleCompartment.id })
    await owner.db.insert(vehicleCompartmentFraction).values(carried.map((row) => ({ companyId: row.companyId, projectId: row.projectId, vehicleCompartmentId: written.id, wasteFractionId: row.wasteFractionId })))

    const settled = JSON.stringify(await Promise.all(CONFIGURATION_TABLES.map((name) => owner.sql`select * from ${owner.sql("wms")}.${owner.sql(name)} order by id`)))
    assert.equal((await seedDemo(fresh.url)).changed, 0)
    assert.equal(JSON.stringify(await Promise.all(CONFIGURATION_TABLES.map((name) => owner.sql`select * from ${owner.sql("wms")}.${owner.sql(name)} order by id`))), settled)
    const [{ fixed, minted }] = await owner.sql<{ fixed: number; minted: number }[]>`
      select count(*) filter (where id = ${planning.collectionCalendarHolidays["calendar-central:2026-06-05"]})::int as fixed,
             count(*) filter (where day = '2026-06-05')::int as minted
      from wms.collection_calendar_holiday where collection_calendar_id = ${planning.collectionCalendars["calendar-central"]}`
    assert.deepEqual({ fixed, minted }, { fixed: 0, minted: 1 }, "the API's id is the one kept")
  })
})

/** Every table this seed's configuration writes, and the product, whose invoicing it fills. */
const CONFIGURATION_TABLES = [
  "product",
  "vehicle_type",
  "container_type_vehicle_type",
  "depot",
  "warehouse",
  "unloading_station",
  "unloading_station_fraction",
  "vehicle",
  "vehicle_compartment",
  "vehicle_compartment_fraction",
  "driver",
  "planning_area",
  "planning_area_boundary",
  "collection_calendar",
  "collection_calendar_holiday",
  "route_scheme",
  "collection_group",
  "collection_group_fraction",
  "collection_group_container_type",
  "collection_group_container",
  "price_list",
  "price_list_row",
]
