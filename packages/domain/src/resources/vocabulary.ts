// Resources' closed lists (Issue #101): what a vehicle, a driver, a place, a
// movement and an allocation may be. Like the Registry's and Planning's
// (registry/vocabulary.ts, planning/vocabulary.ts), the database reads each
// list into its `CHECK` (`oneOf` in packages/db/src/schema/checks.ts) and the
// contracts read the same list into a `z.enum`, so the check at the API
// boundary and the check in the column cannot drift.
//
// Two lists are the glossary's verbatim: `STOCK_MOVEMENT_KINDS`, the six kinds
// of Stock Movement, and `ASSET_STATUSES`, the four states a Container Asset
// State folds onto — a container with no movement yet has no state, which is
// `null` on the wire and not a fifth value here. `STOCK_PLACE_KINDS` is where
// a movement comes from and goes to; a supplier and scrap have no row of their
// own, and maintenance is a place kind at a warehouse, not a table (#101 §6).
// `LICENCE_CLASSES` is lowest first, as route-schemes/fleet-profiles.ts orders
// its display tuple, and lowercase because every value here is a kebab token;
// resources/licence.ts spells the implication between them. The statuses of a
// depot and of an unloading station are the same four, so
// `UNLOADING_STATION_STATUSES` is `DEPOT_STATUSES` under a second name — one
// tuple, two readers — which is why the walking test counts twenty-one names
// over twenty lists. A Drop-off Point (Issue #293, M3) is a place residents
// bring waste to themselves, of the two kinds the glossary names.
// `DRIVER_ABSENCE_REASONS` and
// `VEHICLE_UNAVAILABILITY_REASONS` (O6 of #290) say why a driver is away or a
// vehicle out of use over a dated period (resources/availability.ts).
// `DECOMMISSION_REASON_STATUSES` (O30 of #290) is whether a reason the office
// keeps for scrapping a container is still offered; the reasons themselves
// are the company's rows, not a list here (resources/decommission-reasons.ts).
// `VEHICLE_DEFECT_STATUSES` (O13 of #290) is where a defect a pre-trip check
// found stands (resources/pre-trip.ts).
// `SENSOR_NETWORKS` and `SENSOR_STATUSES` (O26 of #290, row 9.10) are what a
// fill-level Sensor reports over and whether it still reports: the three
// networks the prototype offers, and a sensor retired once it is taken off
// its last bin for good (resources/sensors.ts).
//
// A value is a kebab-case token: it goes into a migration as a SQL literal
// and onto the wire as an enum member, and those are the same string. A list
// is a `readonly` tuple with a type read off it; `RESOURCES_VOCABULARIES`
// names them all for the test that walks them.

/** A vehicle drives itself or is towed: the prototype's `resourceKind`. */
export const VEHICLE_KINDS = ["powered-vehicle", "trailer"] as const
/** Whose vehicle it is. */
export const VEHICLE_OWNERSHIPS = ["company", "service-provider", "leased"] as const
/** The vehicle's lifecycle; "on route" and "position stale" are telemetry, never stored. */
export const VEHICLE_STATUSES = ["active", "unavailable", "maintenance", "retired"] as const
/** What the vehicle runs on. */
export const FUEL_TYPES = ["diesel", "hvo", "biogas", "electric", "hybrid", "other"] as const
/** The licence classes a driver may hold and a vehicle may require, lowest first: `ce` covers `c` covers `b`. */
export const LICENCE_CLASSES = ["b", "c", "ce"] as const
/** How the driver is employed. */
export const EMPLOYMENT_TYPES = ["employee", "service-provider", "temporary"] as const
/** The driver's lifecycle; "invited" is the account's and "absent" a dated window, which arrives later. */
export const DRIVER_STATUSES = ["active", "inactive", "suspended"] as const
/** Whether the warehouse takes and issues stock. */
export const WAREHOUSE_STATUSES = ["draft", "active", "restricted", "closed"] as const
/** Whether the depot is in use; `seasonal` is a depot that opens for part of the year. */
export const DEPOT_STATUSES = ["draft", "active", "seasonal", "closed"] as const
/** The same four as a depot's: one tuple, two readers. */
export const UNLOADING_STATION_STATUSES = DEPOT_STATUSES
/** Whose depot it is. */
export const DEPOT_OWNERSHIPS = ["company", "service-provider"] as const
/** Whose unloading station it is; an incineration plant the company delivers to is `external`. */
export const UNLOADING_STATION_OWNERSHIPS = ["company", "service-provider", "external"] as const
/** The glossary's six kinds of Stock Movement, verbatim. */
export const STOCK_MOVEMENT_KINDS = ["receipt", "issue", "return", "transfer", "adjustment", "decommission"] as const
/** Where a movement comes from and goes to; a supplier and scrap have no row, maintenance is at a warehouse, service is a placement. */
export const STOCK_PLACE_KINDS = ["supplier", "warehouse", "maintenance", "service", "scrap"] as const
/** The glossary's four states of a Container Asset State; a container with no movement has none. */
export const ASSET_STATUSES = ["in-warehouse", "in-service", "in-maintenance", "retired"] as const
/** Where a vehicle allocation stands; the prototype's Draft and Allocated are both `planned`. */
export const ALLOCATION_STATUSES = ["planned", "confirmed", "released"] as const
/** What was done to an allocation, each appending one event: the prototype's `allocationAction`, verbatim. */
export const ALLOCATION_ACTIONS = ["allocate", "change", "confirm", "release"] as const
/** A Drop-off Point's two kinds: a staffed recycling centre, and a bring bank of bins on a street. */
export const DROP_OFF_POINT_KINDS = ["recycling-centre", "bring-bank"] as const
/** Where a Drop-off Point stands: a draft is the office's alone, an active one is on the public map, a closed one is no longer used. */
export const DROP_OFF_POINT_STATUSES = ["draft", "active", "closed"] as const
/** Why a driver is away over a dated period (O6 of #290). */
export const DRIVER_ABSENCE_REASONS = ["holiday", "sick", "training", "leave", "other"] as const
/** Why a vehicle or a trailer is out of use over a dated period (O6 of #290). */
export const VEHICLE_UNAVAILABILITY_REASONS = ["maintenance", "repair", "inspection", "breakdown", "other"] as const
/** A Decommission Reason's state (O30 of #290): offered for a new decommission, or retired from them; a retired one still names the decommissions it was given to. */
export const DECOMMISSION_REASON_STATUSES = ["active", "inactive"] as const
/** The network a fill-level Sensor reports over (O26 of #290): the prototype's three. */
export const SENSOR_NETWORKS = ["lorawan", "sigfox", "nb-iot"] as const
/** A Sensor's state (O26 of #290): reporting, or retired, when its readings are refused and it is paired to no new container; a retired one keeps its pairings and readings. */
export const SENSOR_STATUSES = ["active", "retired"] as const
/** The unit a fuel is burnt and its emission factor given in (M10 of #293): a litre of a liquid fuel, a kilogram of gas, a kilowatt-hour of electricity. */
export const ENERGY_UNITS = ["litre", "kg", "kwh"] as const
/** Why a route's emissions are not measured, in the order they are judged: no active Plan, a Plan not yet measured, no vehicle planned, a vehicle with no fuel, no consumption for its type and fuel, no factor in force for its fuel. */
export const EMISSION_GAPS = ["no-plan", "plan-unmeasured", "no-vehicle", "no-fuel", "no-consumption", "no-factor"] as const
/** Where a Vehicle Defect a pre-trip check found stands (O13 of #290): open until the office marks it mended. */
export const VEHICLE_DEFECT_STATUSES = ["open", "resolved"] as const

/**
 * The places a container stands in while in stock — a warehouse, or
 * maintenance at one — and the places an adjustment may leave it in: in
 * stock, or scrapped, the correction door for a wrong decommission, never in
 * service. Not vocabularies but values of one, like Planning's
 * `DEFAULT_WEEKEND`: the shape table (resources/asset-state.ts) and the
 * command bodies (@waste/contracts/stock) are both built from them, so the
 * pairs a command may ask for and the pairs the ledger allows cannot drift.
 */
export const STOCK_PLACES = ["warehouse", "maintenance"] as const satisfies readonly (typeof STOCK_PLACE_KINDS)[number][]
export const ADJUSTMENT_TARGETS = ["warehouse", "maintenance", "scrap"] as const satisfies readonly (typeof STOCK_PLACE_KINDS)[number][]

export type VehicleKind = (typeof VEHICLE_KINDS)[number]
export type VehicleOwnership = (typeof VEHICLE_OWNERSHIPS)[number]
export type VehicleStatus = (typeof VEHICLE_STATUSES)[number]
export type FuelType = (typeof FUEL_TYPES)[number]
export type LicenceClass = (typeof LICENCE_CLASSES)[number]
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number]
export type DriverStatus = (typeof DRIVER_STATUSES)[number]
export type WarehouseStatus = (typeof WAREHOUSE_STATUSES)[number]
export type DepotStatus = (typeof DEPOT_STATUSES)[number]
export type UnloadingStationStatus = (typeof UNLOADING_STATION_STATUSES)[number]
export type DepotOwnership = (typeof DEPOT_OWNERSHIPS)[number]
export type UnloadingStationOwnership = (typeof UNLOADING_STATION_OWNERSHIPS)[number]
export type StockMovementKind = (typeof STOCK_MOVEMENT_KINDS)[number]
export type StockPlaceKind = (typeof STOCK_PLACE_KINDS)[number]
export type AssetStatus = (typeof ASSET_STATUSES)[number]
export type AllocationStatus = (typeof ALLOCATION_STATUSES)[number]
export type AllocationAction = (typeof ALLOCATION_ACTIONS)[number]
export type DropOffPointKind = (typeof DROP_OFF_POINT_KINDS)[number]
export type DropOffPointStatus = (typeof DROP_OFF_POINT_STATUSES)[number]
export type DriverAbsenceReason = (typeof DRIVER_ABSENCE_REASONS)[number]
export type VehicleUnavailabilityReason = (typeof VEHICLE_UNAVAILABILITY_REASONS)[number]
export type DecommissionReasonStatus = (typeof DECOMMISSION_REASON_STATUSES)[number]
export type SensorNetwork = (typeof SENSOR_NETWORKS)[number]
export type SensorStatus = (typeof SENSOR_STATUSES)[number]
export type EnergyUnit = (typeof ENERGY_UNITS)[number]
export type EmissionGap = (typeof EMISSION_GAPS)[number]
export type VehicleDefectStatus = (typeof VEHICLE_DEFECT_STATUSES)[number]

/** Every list of this module by its name, for a test that walks them and for a reader looking for the whole vocabulary at once. */
export const RESOURCES_VOCABULARIES = {
  VEHICLE_KINDS,
  VEHICLE_OWNERSHIPS,
  VEHICLE_STATUSES,
  FUEL_TYPES,
  LICENCE_CLASSES,
  EMPLOYMENT_TYPES,
  DRIVER_STATUSES,
  WAREHOUSE_STATUSES,
  DEPOT_STATUSES,
  UNLOADING_STATION_STATUSES,
  DEPOT_OWNERSHIPS,
  UNLOADING_STATION_OWNERSHIPS,
  STOCK_MOVEMENT_KINDS,
  STOCK_PLACE_KINDS,
  ASSET_STATUSES,
  ALLOCATION_STATUSES,
  ALLOCATION_ACTIONS,
  DROP_OFF_POINT_KINDS,
  DROP_OFF_POINT_STATUSES,
  DRIVER_ABSENCE_REASONS,
  VEHICLE_UNAVAILABILITY_REASONS,
  DECOMMISSION_REASON_STATUSES,
  SENSOR_NETWORKS,
  SENSOR_STATUSES,
  ENERGY_UNITS,
  EMISSION_GAPS,
  VEHICLE_DEFECT_STATUSES,
} as const satisfies Record<string, readonly [string, ...string[]]>
