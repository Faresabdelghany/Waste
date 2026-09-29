// Resources' demo rows (Issue #156, decided in #143): what `pnpm db:seed`
// writes of the fleet and its places, copied from the web prototype's
// fixtures (`apps/web/lib/data/business-modules.ts`, the `resources`
// workspace) under registry.ts's discipline — literal copies, fixed ids keyed
// by the prototype's record ids, and every reading stated here.
//
//   Vehicle types. Rebuilt from the domain's canonical compatibility table
//   (`CONTAINER_VEHICLE_COMPATIBILITY`, @waste/domain/route-schemes/matching)
//   rather than copied, so a change to the table reaches the seed by itself:
//   its five vehicle types become rows keyed by their name as a slug (`Rear
//   loader` → `rear-loader`), and every (container type, vehicle type) it
//   allows a `container_type_vehicle_type` row, the container type found by
//   its name among the Registry's. Without the pairs a rule asking for a rear
//   loader matches nothing. The table names no trailer, and a vehicle needs a
//   type: the trailer WH-T12's is its fixture's Type fact, `Closed trailer`,
//   a sixth type with no pair, since a trailer empties no container.
//
//   Places. A depot's, a warehouse's and a station's code is its fixture id
//   in capitals (`depot-nordhavn` is `DEPOT-NORDHAVN`), stable because the
//   id is and never invented. The Nordhavn depot and ARC Amager stand at the
//   fixtures' typed coordinates; no warehouse has coordinates and none is on
//   a gazetteer street, so none is located, as the prototype places none.
//   The depot is the company's (it names no provider) and open 05:00 to
//   22:00; its Vehicles and Drivers facts count what is based there and are
//   not the yard's capacity. Nordhavn Warehouse is colocated with the depot
//   (its fixture says so; the depot's Warehouse fact agrees), the one
//   pointer that says it. ARC Amager is the company's, as the table is, and
//   `external`, as its context says, with its weighbridge ("Integrated") and
//   the fractions of its Fractions fact, Residual and mixed, onto the seeded
//   `residual` and `mixed`; its "Closes 17:00" is half of the both-or-neither
//   pair and is left out, as is its facility contract FAC-2026-12, which has
//   no column.
//
//   Vehicles. A fixture's name is its callsign and its plate (`WH-24 · CN 42
//   018`), its context its type, tonnage and base (`Rear loader 18 t ·
//   Nordhavn`): the type is the vehicle type of that name, the tonnage the
//   rated payload in kilograms (the Capacity fact, 18 t is 18 000), and the
//   base the home depot where a depot record exists — Nordhavn — and none
//   where it does not: Amager and Østerbro are bases the fixtures name and no
//   record is (#143), so WH-31, NR-08 and NR-12 have no home depot. Owned by
//   Kystbyen is `company`; owned by NordRen ApS is `service-provider`, naming
//   NordRen. "On route" and "Position stale" are telemetry, never a status:
//   every vehicle is `active`. The required licence class is the typed one,
//   and the fuel its Fuel fact. The trailer's fixture names its callsign and
//   its body (`WH-T12 · Closed trailer`) and no plate, and a registration is
//   required: `TR 12 012` is invented here, seed-only content and the one
//   invented value of this file. One compartment per powered vehicle, at
//   position 1 with no name, carrying the fractions of its Fractions fact on
//   the seeded fractions (`Residual · mixed` is `residual` and `mixed`); no
//   fixture says what a compartment holds, so its capacities are null. The
//   trailer has none.
//
//   Drivers. All four are Copenhagen's, as their fixtures are, with no
//   workforce reference, licence number or home depot, which no fixture
//   names. The class and the expiry are the typed ones, literal: Lars
//   Møller's C licence ran out on 2026-09-05 and stays that way, which is
//   why the RS-Østerbro group he drives in the prototype names no driver
//   here (planning.ts). Every status is `active`: "On route" is telemetry,
//   "Licence expiring" a reading of the expiry, and Jonas Lind's "Invited" is
//   his account's word, not the driver's — an active profile with no licence
//   on record, eligible for nothing, and no account. Employed by Kystbyen is
//   `employee`; Lars Møller is NordRen's. Mads Jensen's profile names his
//   account, `DEMO_IDS.users.mads` (#140), the Login the Driver App's testers
//   share; no other driver has one.
import type { Point } from "@waste/contracts/geojson"
import type { EmploymentType, FuelType, LicenceClass, UnloadingStationOwnership, VehicleKind, VehicleOwnership } from "@waste/domain/resources/vocabulary"
import { CONTAINER_VEHICLE_COMPATIBILITY, STOP_MATCH_VEHICLE_TYPES } from "@waste/domain/route-schemes/matching"
import { inArray } from "drizzle-orm"

import type { Tx } from "../client"
import { driver, vehicle, vehicleCompartment, vehicleCompartmentFraction } from "../schema/fleet"
import { containerTypeVehicleType, vehicleType } from "../schema/fleet-types"
import { depot, unloadingStation, unloadingStationFraction, warehouse } from "../schema/places"
import { DEMO_COMPANY_ID, DEMO_PROJECT_IDS, DEMO_SERVICE_PROVIDER_IDS, DEMO_USER_IDS, keyed, required } from "./ids"
import { REGISTRY_IDS, REGISTRY_ROWS } from "./registry"
import { replaceSets, upsertOwned } from "./upsert"

const COMPANY_ID = DEMO_COMPANY_ID

/* ------------------------------ vehicle types ------------------------------ */

/** A vehicle type's key: its name as a slug, the shape the contracts hold keys to. */
const slugOf = (name: string): string => name.toLowerCase().replaceAll(" ", "-")

/** WH-T12's Type fact: the one vehicle type the canonical table does not name. */
const TRAILER_TYPE = "Closed trailer"

const VEHICLE_TYPE_NAMES: readonly string[] = [...STOP_MATCH_VEHICLE_TYPES, TRAILER_TYPE]

/** The container type a name of the domain's table is, among the Registry's: its key and its id. */
function containerTypeNamed(name: string): { key: string; id: string } {
  const row = REGISTRY_ROWS.containerTypes.find((candidate) => candidate.name === name)
  const key = row && Object.entries(REGISTRY_IDS.containerTypes).find(([, id]) => id === row.id)?.[0]
  if (!row?.id || !key) throw new Error(`resources seed: the compatibility table names ${name}, which is no container type of the Registry's`)
  return { key, id: row.id }
}

/** Every pair the table allows, led by the vehicle type whose set it is. */
const COMPATIBILITY: readonly { vehicleType: string; containerType: { key: string; id: string } }[] = STOP_MATCH_VEHICLE_TYPES.flatMap((type) =>
  Object.entries(CONTAINER_VEHICLE_COMPATIBILITY)
    .filter(([, types]) => types.includes(type))
    .map(([name]) => ({ vehicleType: slugOf(type), containerType: containerTypeNamed(name) })),
)

/* --------------------------------- places ---------------------------------- */

/** The projects the Resources fixtures scope to; Cairo Operations has none. */
type ResourcesProject = "copenhagen" | "harbor"

/** A place's code: its fixture id in capitals. */
const codeOf = (key: string): string => key.toUpperCase()

const at = (lng: number, lat: number): Point => ({ type: "Point", coordinates: [lng, lat] })

type DepotSpec = { key: string; project: ResourcesProject; name: string; address: string; location: Point; opensAt: string; closesAt: string }
const DEPOTS: readonly DepotSpec[] = [
  { key: "depot-nordhavn", project: "copenhagen", name: "Nordhavn Depot", address: "Kaj 14, Nordhavn", location: at(12.5958, 55.7091), opensAt: "05:00", closesAt: "22:00" },
]

type WarehouseSpec = { key: string; project: ResourcesProject; name: string; address: string; depot: string | null }
const WAREHOUSES: readonly WarehouseSpec[] = [
  { key: "warehouse-west", project: "copenhagen", name: "Warehouse West", address: "Logistikvej 8, Valby", depot: null },
  { key: "warehouse-nordhavn", project: "copenhagen", name: "Nordhavn Warehouse", address: "Kaj 14, Nordhavn", depot: "depot-nordhavn" },
  { key: "warehouse-harbor", project: "harbor", name: "Harbor Satellite Warehouse", address: "Dock 2, Harbor Commercial", depot: null },
]

type StationSpec = { key: string; name: string; address: string; location: Point; ownership: UnloadingStationOwnership; weighbridge: boolean; fractions: readonly string[] }
const STATIONS: readonly StationSpec[] = [
  { key: "station-arc", name: "ARC Amager", address: "Kraftværksvej 31", location: at(12.6186, 55.6903), ownership: "external", weighbridge: true, fractions: ["residual", "mixed"] },
]

/* ---------------------------------- fleet ---------------------------------- */

type VehicleSpec = {
  key: string
  callsign: string
  registration: string
  kind: VehicleKind
  /** The vehicle type's key. */
  type: string
  ownership: VehicleOwnership
  provider: keyof typeof DEMO_SERVICE_PROVIDER_IDS | null
  capacityKg: number
  requiredLicenceClass: LicenceClass
  homeDepot: string | null
  fuel: FuelType | null
  /** The fractions of its Fractions fact, its one compartment's; a trailer has no compartment. */
  fractions: readonly string[]
}
const VEHICLES: readonly VehicleSpec[] = [
  { key: "vehicle-wh24", callsign: "WH-24", registration: "CN 42 018", kind: "powered-vehicle", type: "rear-loader", ownership: "company", provider: null, capacityKg: 18_000, requiredLicenceClass: "c", homeDepot: "depot-nordhavn", fuel: "hvo", fractions: ["residual", "mixed"] },
  { key: "vehicle-wh31", callsign: "WH-31", registration: "DK 88 441", kind: "powered-vehicle", type: "glass-crane", ownership: "company", provider: null, capacityKg: 16_000, requiredLicenceClass: "c", homeDepot: null, fuel: "diesel", fractions: ["glass"] },
  { key: "vehicle-nr08", callsign: "NR-08", registration: "AB 51 912", kind: "powered-vehicle", type: "organic-sealed", ownership: "service-provider", provider: "nordren", capacityKg: 12_000, requiredLicenceClass: "c", homeDepot: null, fuel: "biogas", fractions: ["organic"] },
  { key: "vehicle-nr12", callsign: "NR-12", registration: "CK 74 305", kind: "powered-vehicle", type: "paper-compactor", ownership: "service-provider", provider: "nordren", capacityKg: 14_000, requiredLicenceClass: "c", homeDepot: null, fuel: "diesel", fractions: ["paper"] },
  // Invented: the fixture names no plate.
  { key: "trailer-wh12", callsign: "WH-T12", registration: "TR 12 012", kind: "trailer", type: slugOf(TRAILER_TYPE), ownership: "company", provider: null, capacityKg: 18_000, requiredLicenceClass: "ce", homeDepot: "depot-nordhavn", fuel: null, fractions: [] },
]

type DriverSpec = {
  key: string
  name: string
  employment: EmploymentType
  provider: keyof typeof DEMO_SERVICE_PROVIDER_IDS | null
  licenceClass: LicenceClass | null
  licenceExpiry: string | null
  account: keyof typeof DEMO_USER_IDS | null
}
const DRIVERS: readonly DriverSpec[] = [
  { key: "driver-mads", name: "Mads Jensen", employment: "employee", provider: null, licenceClass: "ce", licenceExpiry: "2028-12-31", account: "mads" },
  { key: "driver-freja", name: "Freja Nielsen", employment: "employee", provider: null, licenceClass: "ce", licenceExpiry: "2027-06-30", account: null },
  { key: "driver-lars", name: "Lars Møller", employment: "service-provider", provider: "nordren", licenceClass: "c", licenceExpiry: "2026-09-05", account: null },
  { key: "driver-jonas", name: "Jonas Lind", employment: "employee", provider: null, licenceClass: null, licenceExpiry: null, account: null },
]

/** Every vehicle and driver fixture is Copenhagen Central's. */
const FLEET_PROJECT: ResourcesProject = "copenhagen"

/* --------------------------------- rows ----------------------------------- */

/** Every Resources id, keyed by the prototype's record id or the key it goes by. */
export type ResourcesIds = {
  /** By key: `rear-loader`. */
  vehicleTypes: Readonly<Record<string, string>>
  /** `<vehicle type key>:<container type key>` */
  containerTypeVehicleTypes: Readonly<Record<string, string>>
  depots: Readonly<Record<string, string>>
  warehouses: Readonly<Record<string, string>>
  unloadingStations: Readonly<Record<string, string>>
  /** `<station>:<waste fraction key>` */
  unloadingStationFractions: Readonly<Record<string, string>>
  vehicles: Readonly<Record<string, string>>
  /** `<vehicle>:<position>` */
  vehicleCompartments: Readonly<Record<string, string>>
  /** `<vehicle>:<position>:<waste fraction key>` */
  vehicleCompartmentFractions: Readonly<Record<string, string>>
  drivers: Readonly<Record<string, string>>
}

type ResourcesRows = {
  vehicleTypes: (typeof vehicleType.$inferInsert)[]
  containerTypeVehicleTypes: (typeof containerTypeVehicleType.$inferInsert)[]
  depots: (typeof depot.$inferInsert)[]
  warehouses: (typeof warehouse.$inferInsert)[]
  unloadingStations: (typeof unloadingStation.$inferInsert)[]
  unloadingStationFractions: (typeof unloadingStationFraction.$inferInsert)[]
  vehicles: (typeof vehicle.$inferInsert)[]
  vehicleCompartments: (typeof vehicleCompartment.$inferInsert)[]
  vehicleCompartmentFractions: (typeof vehicleCompartmentFraction.$inferInsert)[]
  drivers: (typeof driver.$inferInsert)[]
}

/** How many rows the Resources seed holds per table. */
export type ResourcesCounts = { [K in keyof ResourcesRows]: number }

function build(): { ids: ResourcesIds; rows: ResourcesRows } {
  for (const types of Object.values(CONTAINER_VEHICLE_COMPATIBILITY)) {
    for (const type of types) {
      if (!(STOP_MATCH_VEHICLE_TYPES as readonly string[]).includes(type)) throw new Error(`resources seed: the compatibility table names ${type}, which is no canonical vehicle type`)
    }
  }
  const vehicleTypeIds = keyed(VEHICLE_TYPE_NAMES, slugOf, "vehicleType")
  const pairKey = (pair: (typeof COMPATIBILITY)[number]): string => `${pair.vehicleType}:${pair.containerType.key}`
  const pairIds = keyed(COMPATIBILITY, pairKey, "containerTypeVehicleType")
  const vehicleTypeId = (key: string) => required(vehicleTypeIds, key, "vehicle type")
  const depotIds = keyed(DEPOTS, (spec) => spec.key, "depot")
  const warehouseIds = keyed(WAREHOUSES, (spec) => spec.key, "warehouse")
  const stationIds = keyed(STATIONS, (spec) => spec.key, "unloadingStation")
  const stationFractions = STATIONS.flatMap((spec) => spec.fractions.map((fraction) => ({ station: spec.key, fraction })))
  const stationFractionKey = (entry: (typeof stationFractions)[number]): string => `${entry.station}:${entry.fraction}`
  const stationFractionIds = keyed(stationFractions, stationFractionKey, "unloadingStationFraction")
  const depotId = (key: string) => required(depotIds, key, "depot")
  const wasteFractionId = (key: string) => required(REGISTRY_IDS.wasteFractions, key, "waste fraction")
  const vehicleIds = keyed(VEHICLES, (spec) => spec.key, "vehicle")
  // One compartment per powered vehicle, at position 1.
  const compartments = VEHICLES.filter((spec) => spec.kind === "powered-vehicle").map((spec) => ({ vehicle: spec.key, position: 1, fractions: spec.fractions }))
  const compartmentKey = (entry: { vehicle: string; position: number }): string => `${entry.vehicle}:${entry.position}`
  const compartmentIds = keyed(compartments, compartmentKey, "vehicleCompartment")
  const carried = compartments.flatMap((entry) => entry.fractions.map((fraction) => ({ compartment: compartmentKey(entry), fraction })))
  const carriedKey = (entry: (typeof carried)[number]): string => `${entry.compartment}:${entry.fraction}`
  const carriedIds = keyed(carried, carriedKey, "vehicleCompartmentFraction")
  const driverIds = keyed(DRIVERS, (spec) => spec.key, "driver")
  const vehicleId = (key: string) => required(vehicleIds, key, "vehicle")
  const compartmentId = (key: string) => required(compartmentIds, key, "compartment")

  return {
    ids: {
      vehicleTypes: vehicleTypeIds,
      containerTypeVehicleTypes: pairIds,
      depots: depotIds,
      warehouses: warehouseIds,
      unloadingStations: stationIds,
      unloadingStationFractions: stationFractionIds,
      vehicles: vehicleIds,
      vehicleCompartments: compartmentIds,
      vehicleCompartmentFractions: carriedIds,
      drivers: driverIds,
    },
    rows: {
      vehicleTypes: VEHICLE_TYPE_NAMES.map((name) => ({ id: vehicleTypeId(slugOf(name)), companyId: COMPANY_ID, key: slugOf(name), name, description: null })),
      containerTypeVehicleTypes: COMPATIBILITY.map((pair) => ({
        id: required(pairIds, pairKey(pair), "compatibility pair"),
        companyId: COMPANY_ID,
        containerTypeId: pair.containerType.id,
        vehicleTypeId: vehicleTypeId(pair.vehicleType),
      })),
      depots: DEPOTS.map((spec) => ({
        id: depotId(spec.key),
        companyId: COMPANY_ID,
        projectId: DEMO_PROJECT_IDS[spec.project],
        code: codeOf(spec.key),
        name: spec.name,
        address: spec.address,
        location: spec.location,
        ownership: "company",
        serviceProviderId: null,
        opensAt: spec.opensAt,
        closesAt: spec.closesAt,
        vehicleCapacity: null,
        status: "active",
        notes: null,
      })),
      warehouses: WAREHOUSES.map((spec) => ({
        id: required(warehouseIds, spec.key, "warehouse"),
        companyId: COMPANY_ID,
        projectId: DEMO_PROJECT_IDS[spec.project],
        code: codeOf(spec.key),
        name: spec.name,
        address: spec.address,
        location: null,
        depotId: spec.depot ? depotId(spec.depot) : null,
        status: "active",
        notes: null,
      })),
      unloadingStations: STATIONS.map((spec) => ({
        id: required(stationIds, spec.key, "unloading station"),
        companyId: COMPANY_ID,
        code: codeOf(spec.key),
        name: spec.name,
        address: spec.address,
        location: spec.location,
        ownership: spec.ownership,
        serviceProviderId: null,
        opensAt: null,
        closesAt: null,
        weighbridge: spec.weighbridge,
        status: "active",
        notes: null,
      })),
      unloadingStationFractions: stationFractions.map((entry) => ({
        id: required(stationFractionIds, stationFractionKey(entry), "station fraction"),
        companyId: COMPANY_ID,
        unloadingStationId: required(stationIds, entry.station, "unloading station"),
        wasteFractionId: wasteFractionId(entry.fraction),
      })),
      vehicles: VEHICLES.map((spec) => ({
        id: vehicleId(spec.key),
        companyId: COMPANY_ID,
        projectId: DEMO_PROJECT_IDS[FLEET_PROJECT],
        registration: spec.registration,
        callsign: spec.callsign,
        kind: spec.kind,
        vehicleTypeId: vehicleTypeId(spec.type),
        ownership: spec.ownership,
        serviceProviderId: spec.provider ? DEMO_SERVICE_PROVIDER_IDS[spec.provider] : null,
        status: "active",
        capacityKg: spec.capacityKg,
        requiredLicenceClass: spec.requiredLicenceClass,
        homeDepotId: spec.homeDepot ? depotId(spec.homeDepot) : null,
        fuel: spec.fuel,
        telematicsDeviceId: null,
        notes: null,
      })),
      vehicleCompartments: compartments.map((entry) => ({
        id: compartmentId(compartmentKey(entry)),
        companyId: COMPANY_ID,
        projectId: DEMO_PROJECT_IDS[FLEET_PROJECT],
        vehicleId: vehicleId(entry.vehicle),
        position: entry.position,
        name: null,
        capacityKg: null,
        volumeLitres: null,
      })),
      vehicleCompartmentFractions: carried.map((entry) => ({
        id: required(carriedIds, carriedKey(entry), "compartment fraction"),
        companyId: COMPANY_ID,
        projectId: DEMO_PROJECT_IDS[FLEET_PROJECT],
        vehicleCompartmentId: compartmentId(entry.compartment),
        wasteFractionId: wasteFractionId(entry.fraction),
      })),
      drivers: DRIVERS.map((spec) => ({
        id: required(driverIds, spec.key, "driver"),
        companyId: COMPANY_ID,
        projectId: DEMO_PROJECT_IDS[FLEET_PROJECT],
        name: spec.name,
        workforceReference: null,
        employment: spec.employment,
        serviceProviderId: spec.provider ? DEMO_SERVICE_PROVIDER_IDS[spec.provider] : null,
        homeDepotId: null,
        licenceClass: spec.licenceClass,
        licenceNumber: null,
        licenceExpiry: spec.licenceExpiry,
        userAccountId: spec.account ? DEMO_USER_IDS[spec.account] : null,
        status: "active",
        notes: null,
      })),
    },
  }
}

const built = build()

/** Every Resources id the seed writes. */
export const RESOURCES_IDS: ResourcesIds = built.ids

/** The rows themselves, for a test that wants to read what the seed proposes. */
export const RESOURCES_ROWS: Readonly<ResourcesRows> = built.rows

export const RESOURCES_COUNTS: ResourcesCounts = Object.fromEntries(Object.entries(built.rows).map(([table, rows]) => [table, rows.length])) as ResourcesCounts

/** One compartment as the comparison reads it: its own columns, then its fractions in one order. */
const compartmentMember = (compartment: { position: number; name?: string | null; capacityKg?: number | null; volumeLitres?: number | null }, fractions: readonly string[]): string =>
  JSON.stringify([compartment.position, compartment.name ?? null, compartment.capacityKg ?? null, compartment.volumeLitres ?? null, [...fractions].sort()])

/**
 * The seeded vehicles' compartments with their fractions: a set of sets the
 * API replaces whole (`PUT /vehicles/{id}/compartments`, the fractions
 * first), so it is compared whole per vehicle — the compartments and what
 * each carries, whatever their ids — and replaced whole where it differs,
 * as replaceSets does a set of one level. Every seeded vehicle's set is the
 * seed's, the trailer's empty one included.
 */
async function writeCompartments(tx: Tx): Promise<number> {
  const rows = RESOURCES_ROWS
  const vehicleIds = rows.vehicles.map((row) => row.id as string)
  const described = (compartments: readonly { id?: string; vehicleId: string; position: number; name?: string | null; capacityKg?: number | null; volumeLitres?: number | null }[], carried: readonly { vehicleCompartmentId: string; wasteFractionId: string }[]) => {
    const byVehicle = new Map<string, string[]>(vehicleIds.map((id) => [id, []]))
    for (const compartment of compartments) {
      const fractions = carried.filter((row) => row.vehicleCompartmentId === compartment.id).map((row) => row.wasteFractionId)
      byVehicle.get(compartment.vehicleId)?.push(compartmentMember(compartment, fractions))
    }
    return new Map([...byVehicle].map(([id, members]) => [id, members.sort().join("\n")]))
  }
  const stored = await tx
    .select({ id: vehicleCompartment.id, vehicleId: vehicleCompartment.vehicleId, position: vehicleCompartment.position, name: vehicleCompartment.name, capacityKg: vehicleCompartment.capacityKg, volumeLitres: vehicleCompartment.volumeLitres })
    .from(vehicleCompartment)
    .where(inArray(vehicleCompartment.vehicleId, vehicleIds))
  const storedIds = stored.map((row) => row.id)
  const storedCarried =
    storedIds.length === 0
      ? []
      : await tx
          .select({ vehicleCompartmentId: vehicleCompartmentFraction.vehicleCompartmentId, wasteFractionId: vehicleCompartmentFraction.wasteFractionId })
          .from(vehicleCompartmentFraction)
          .where(inArray(vehicleCompartmentFraction.vehicleCompartmentId, storedIds))
  const found = described(stored, storedCarried)
  const proposed = described(rows.vehicleCompartments, rows.vehicleCompartmentFractions)
  const differing = vehicleIds.filter((id) => found.get(id) !== proposed.get(id))
  if (differing.length === 0) return 0

  const replaced = stored.filter((row) => differing.includes(row.vehicleId)).map((row) => row.id)
  let changed = 0
  if (replaced.length > 0) {
    changed += (await tx.delete(vehicleCompartmentFraction).where(inArray(vehicleCompartmentFraction.vehicleCompartmentId, replaced)).returning({ id: vehicleCompartmentFraction.id })).length
    changed += (await tx.delete(vehicleCompartment).where(inArray(vehicleCompartment.id, replaced)).returning({ id: vehicleCompartment.id })).length
  }
  const compartments = rows.vehicleCompartments.filter((row) => differing.includes(row.vehicleId))
  if (compartments.length > 0) {
    changed += (await tx.insert(vehicleCompartment).values(compartments).returning({ id: vehicleCompartment.id })).length
    const ids = compartments.map((row) => row.id as string)
    const carried = rows.vehicleCompartmentFractions.filter((row) => ids.includes(row.vehicleCompartmentId))
    if (carried.length > 0) changed += (await tx.insert(vehicleCompartmentFraction).values(carried).returning({ id: vehicleCompartmentFraction.id })).length
  }
  return changed
}

/** Writes Resources into an open transaction, after the Registry whose fractions and container types it names, and answers how many rows it changed. */
export async function applyResources(tx: Tx): Promise<number> {
  const rows = RESOURCES_ROWS
  let changed = 0
  // `key` is set once (fleet-types.ts): the seed spells it on insert and never rewrites it.
  changed += await upsertOwned(tx, vehicleType, rows.vehicleTypes, [vehicleType.name, vehicleType.description])
  changed += await replaceSets(tx, containerTypeVehicleType, containerTypeVehicleType.vehicleTypeId, Object.values(RESOURCES_IDS.vehicleTypes), rows.containerTypeVehicleTypes, [
    containerTypeVehicleType.containerTypeId,
  ])
  // A place's `code` is set once (places.ts), like a vehicle type's key.
  changed += await upsertOwned(tx, depot, rows.depots, [
    depot.name,
    depot.address,
    depot.location,
    depot.ownership,
    depot.serviceProviderId,
    depot.opensAt,
    depot.closesAt,
    depot.vehicleCapacity,
    depot.status,
    depot.notes,
  ])
  changed += await upsertOwned(tx, warehouse, rows.warehouses, [warehouse.name, warehouse.address, warehouse.location, warehouse.depotId, warehouse.status, warehouse.notes])
  changed += await upsertOwned(tx, unloadingStation, rows.unloadingStations, [
    unloadingStation.name,
    unloadingStation.address,
    unloadingStation.location,
    unloadingStation.ownership,
    unloadingStation.serviceProviderId,
    unloadingStation.opensAt,
    unloadingStation.closesAt,
    unloadingStation.weighbridge,
    unloadingStation.status,
    unloadingStation.notes,
  ])
  changed += await replaceSets(tx, unloadingStationFraction, unloadingStationFraction.unloadingStationId, Object.values(RESOURCES_IDS.unloadingStations), rows.unloadingStationFractions, [
    unloadingStationFraction.wasteFractionId,
  ])
  changed += await upsertOwned(tx, vehicle, rows.vehicles, [
    vehicle.registration,
    vehicle.callsign,
    vehicle.kind,
    vehicle.vehicleTypeId,
    vehicle.ownership,
    vehicle.serviceProviderId,
    vehicle.status,
    vehicle.capacityKg,
    vehicle.requiredLicenceClass,
    vehicle.homeDepotId,
    vehicle.fuel,
    vehicle.telematicsDeviceId,
    vehicle.notes,
  ])
  changed += await writeCompartments(tx)
  changed += await upsertOwned(tx, driver, rows.drivers, [
    driver.name,
    driver.workforceReference,
    driver.employment,
    driver.serviceProviderId,
    driver.homeDepotId,
    driver.licenceClass,
    driver.licenceNumber,
    driver.licenceExpiry,
    driver.userAccountId,
    driver.status,
    driver.notes,
  ])
  return changed
}
